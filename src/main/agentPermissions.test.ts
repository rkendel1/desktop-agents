import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentPermissionBroker, nativeReadPermission, toolCapability } from './agentPermissions'
import { agentPermissions } from '../shared/agentPermissions'
import type { AgentConfig } from '../shared/types'
const config = { id: 'agent', ownerId: 'owner', name: 'Agent' } as AgentConfig
const input = { requester: 'Friend', roomName: 'Group', capability: 'filesRead' as const, operation: 'read', details: '/private/file' }
afterEach(() => vi.useRealTimers())
describe('agent permission boundary', () => {
  it('reuses native app access across tasks only for the same live session, app and requester', async () => {
    const broker = new AgentPermissionBroker(vi.fn())
    const lifetime = new AbortController()
    const native = { id: 'session-1', appId: 'com.apple.calculator', appName: 'Calculator', signal: lifetime.signal }
    const request = { ...input, requesterId: 'human', context: 'direct' as const, capability: 'otherTools' as const, details: '{}', operation: 'Use Calculator' }
    const task = broker.beginTask(config.id, 'human')
    const first = broker.authorize(config, request, undefined, true, task, native)
    expect(broker.snapshot()[0]).toMatchObject({ sessionScope: 'Calculator', nativeApp: { id: 'com.apple.calculator' } })
    broker.resolve(broker.snapshot()[0].id, 'session'); await first
    broker.endTask(task)
    const secondTask = broker.beginTask(config.id, 'human')
    await broker.authorize(config, request, undefined, true, secondTask, native)
    expect(broker.snapshot()).toHaveLength(0)
    for (const [r, scope] of [
      [request, { ...native, appId: 'com.apple.finder' }],
      [{ ...request, requesterId: 'someone-else' }, native],
      [request, { ...native, id: 'session-2' }]
    ] as const) {
      const work = broker.authorize(config, r, undefined, true, undefined, scope)
      const denied = expect(work).rejects.toThrow('declined')
      broker.resolve(broker.snapshot()[0].id, false); await denied
    }
    const permissions = agentPermissions(); permissions.sensitive.otherTools = 'deny'
    await expect(broker.authorize({ ...config, permissions }, request, undefined, true, undefined, native)).rejects.toThrow('disabled')
    lifetime.abort()
    await expect(broker.authorize(config, request, undefined, true, undefined, native)).rejects.toThrow()
    broker.endTask(secondTask)
  })
  it('does not turn once-only confirmations into session grants, and cancels pending requests on session close', async () => {
    const broker = new AgentPermissionBroker(vi.fn())
    const lifetime = new AbortController()
    const native = { id: 'session', appId: 'app', appName: 'App', signal: lifetime.signal }
    const once = broker.authorize(config, input, undefined, true, undefined, native)
    broker.resolve(broker.snapshot()[0].id, true); await once
    const again = broker.authorize(config, input, undefined, true, undefined, native)
    const cancelled = expect(again).rejects.toThrow('cancelled')
    lifetime.abort(); await cancelled
    const sensitive = broker.authorize(config, input, undefined, true)
    expect(() => broker.resolve(broker.snapshot()[0].id, 'session')).toThrow('unavailable')
    const denied = expect(sensitive).rejects.toThrow('declined')
    broker.resolve(broker.snapshot()[0].id, false); await denied
  })
  it('classifies only structured native read operations, never command descriptions', () => {
    expect(nativeReadPermission('claude', JSON.stringify({ tool: 'Read', input: { file_path: '/tmp/report' } }))).toMatchObject({ capability: 'filesRead', operation: 'native_read_file' })
    expect(nativeReadPermission('claude', JSON.stringify({ tool: 'WebFetch', input: { url: 'https://douchat.ai' } }))).toMatchObject({ capability: 'network' })
    expect(nativeReadPermission('claude', JSON.stringify({ tool: 'Bash', input: { command: 'cat /tmp/report' } }))).toBeUndefined()
    expect(nativeReadPermission('codex', '{"app":"Finder"}')).toBeUndefined()
    expect(nativeReadPermission('claude', 'Read this file')).toBeUndefined()
  })
  it('shares approved read access across search and read in one mailbox only', async () => {
    const broker = new AgentPermissionBroker(vi.fn())
    const task = broker.beginTask(config.id)
    const search = { ...input, capability: 'accountRead' as const, operation: 'email_search', details: '{"accountId":"work","folder":"INBOX"}' }
    const pending = broker.authorize(config, search, undefined, false, task)
    broker.resolve(broker.snapshot()[0].id, 'task'); await pending
    await broker.authorize(config, { ...search, operation: 'email_read', details: '{"accountId":"work","messageId":"new-message"}' }, undefined, false, task)
    const other = broker.authorize(config, { ...search, details: '{"accountId":"personal"}' }, undefined, false, task)
    const cancelled = expect(other).rejects.toThrow('cancelled')
    expect(broker.snapshot()).toHaveLength(1)
    broker.endTask(task); await cancelled
  })
  it('reuses a website grant only within the same task and revokes it at completion', async () => {
    const broker = new AgentPermissionBroker(vi.fn())
    const task = broker.beginTask(config.id, 'human')
    const web = { ...input, requesterId: 'human', capability: 'network' as const, operation: 'computer_open', details: '{"url":"https://douchat.ai/docs"}' }
    const first = broker.authorize(config, web, undefined, false, task)
    expect(broker.snapshot()[0].taskScope).toBe('https://douchat.ai')
    broker.resolve(broker.snapshot()[0].id, 'task'); await first
    await broker.authorize(config, { ...web, details: '{"url":"https://douchat.ai/about"}' }, undefined, false, task)
    expect(broker.snapshot()).toHaveLength(0)
    const other = broker.authorize(config, { ...web, details: '{"url":"https://other.test"}' }, undefined, false, task)
    const denied = expect(other).rejects.toThrow('declined')
    broker.resolve(broker.snapshot()[0].id, false); await denied
    const permissions = agentPermissions(); permissions.sensitive.network = 'deny'
    await expect(broker.authorize({ ...config, permissions }, web, undefined, false, task)).rejects.toThrow('disabled')
    await expect(broker.authorize(config, { ...web, requesterId: 'outsider' }, undefined, false, task)).rejects.toThrow('task changed')
    broker.endTask(task)
    const nextTask = broker.beginTask(config.id, 'human')
    const next = broker.authorize(config, web, undefined, false, nextTask)
    const cancelled = expect(next).rejects.toThrow('cancelled')
    expect(broker.snapshot()).toHaveLength(1)
    broker.endTask(nextTask); await cancelled
  })

  it('coalesces matching parallel requests only when the owner chooses task approval', async () => {
    const broker = new AgentPermissionBroker(vi.fn())
    const task = broker.beginTask(config.id)
    const read = { ...input, operation: 'computer_list_files', details: '{"path":"/tmp/allowed"}' }
    const pending = [broker.authorize(config, read, undefined, false, task), broker.authorize(config, read, undefined, false, task)]
    broker.resolve(broker.snapshot()[0].id, 'task')
    await Promise.all(pending)
    expect(broker.snapshot()).toHaveLength(0)
    const different = broker.authorize(config, { ...read, details: '{"path":"/tmp/other"}' }, undefined, false, task)
    const stopped = expect(different).rejects.toThrow('cancelled')
    broker.cancelAgent(config.id); await stopped
  })

  it.each(['email_send', 'computer_move_file', 'computer_click', 'create_routine', 'native command'])('never grants task-wide access to %s', async operation => {
    const broker = new AgentPermissionBroker(vi.fn())
    const task = broker.beginTask(config.id)
    const pending = broker.authorize(config, { ...input, capability: toolCapability(operation), operation, details: '{}' }, undefined, false, task)
    expect(broker.snapshot()[0].taskScope).toBeUndefined()
    expect(() => broker.resolve(broker.snapshot()[0].id, 'task')).toThrow('unavailable')
    broker.resolve(broker.snapshot()[0].id, true); await pending
    broker.endTask(task)
  })
  it('requires a fresh native-tool confirmation even with broad allow, while preserving deny', async () => {
    const broker = new AgentPermissionBroker(vi.fn())
    const permissions = agentPermissions()
    permissions.sensitive.filesRead = 'allow'
    const work = broker.authorize({ ...config, permissions }, input, undefined, true)
    expect(broker.snapshot()).toHaveLength(1)
    broker.resolve(broker.snapshot()[0].id, true)
    await work
    permissions.sensitive.filesRead = 'deny'
    await expect(broker.authorize({ ...config, permissions }, input, undefined, true)).rejects.toThrow('disabled')
    expect(broker.snapshot()).toHaveLength(0)
  })
  it('defaults to social interaction with explicit approval for sensitive operations', () => {
    expect(agentPermissions()).toMatchObject({ groupHumans: 'allow', groupAgents: 'allow', sensitive: { filesRead: 'ask', localExecution: 'ask' } })
    expect(agentPermissions({ groupHumans: 'bogus', sensitive: { filesRead: true } })).toMatchObject({ groupHumans: 'deny', sensitive: { filesRead: 'deny' } })
  })
  it('does not execute until the owner approves, and approval is single use', async () => {
    const broker = new AgentPermissionBroker(vi.fn())
    const execute = vi.fn()
    const work = broker.authorize(config, input).then(execute)
    expect(execute).not.toHaveBeenCalled()
    const request = broker.snapshot()[0]
    broker.resolve(request.id, true)
    await work
    expect(execute).toHaveBeenCalledOnce()
    expect(() => broker.resolve(request.id, true)).toThrow('no longer')
    const next = broker.authorize(config, input)
    const denied = expect(next).rejects.toThrow('declined')
    expect(broker.snapshot()).toHaveLength(1)
    broker.resolve(broker.snapshot()[0].id, false)
    await denied
  })
  it('honors deny without prompting and expires unanswered requests', async () => {
    vi.useFakeTimers()
    const broker = new AgentPermissionBroker(vi.fn())
    const permissions = agentPermissions()
    permissions.sensitive.filesRead = 'deny'
    await expect(broker.authorize({ ...config, permissions }, input)).rejects.toThrow('disabled')
    expect(broker.snapshot()).toHaveLength(0)
    const work = expect(broker.authorize(config, input)).rejects.toThrow('expired')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await work
    expect(broker.snapshot()).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('aborts pending approvals without leaking listeners or requests', async () => {
    const broker = new AgentPermissionBroker(vi.fn())
    const signal = new AbortController()
    const work = expect(broker.authorize(config, input, signal.signal)).rejects.toThrow(/abort/i)
    signal.abort()
    await work
    expect(broker.snapshot()).toHaveLength(0)
  })
  it('classifies tools conservatively', () => {
    expect(toolCapability('computer_list_files')).toBe('filesRead')
    expect(toolCapability('computer_move_file')).toBe('filesWrite')
    expect(toolCapability('computer_click')).toBe('browserControl')
    expect(toolCapability('email_read')).toBe('accountRead')
    expect(toolCapability('email_send')).toBe('accountWrite')
    expect(toolCapability('unknown_tool')).toBe('otherTools')
  })

  it('distinguishes a cancelled request from an owner declining it', async () => {
    const broker = new AgentPermissionBroker(vi.fn())
    const work = expect(broker.authorize(config, input)).rejects.toThrow('Permission request cancelled')
    broker.cancelAgent(config.id)
    await work
    expect(broker.snapshot()).toHaveLength(0)
  })
})
