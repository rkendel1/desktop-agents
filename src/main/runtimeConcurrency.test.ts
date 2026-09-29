import { openAtFile } from './testSupport'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DouchatRuntime } from './runtime'
import { DesktopRepository } from './desktopRepository'
import { runLocalAgent } from './localAgentRuntime'

vi.mock('./localAgentRuntime', async (original) => ({ ...await original<object>(), runLocalAgent: vi.fn() }))
const directories: string[] = []
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })) })

async function setup(local: boolean, executor?: import('../shared/agentExecutor').AgentExecutor) {
  const directory = mkdtempSync(join(tmpdir(), 'douchat-concurrency-'))
  directories.push(directory)
  const store = await openAtFile(join(directory, 'state.json'), { seedDemo: true })
  const runtime = new DouchatRuntime(store, {
    snapshots: () => [], start: vi.fn(), stop: vi.fn(), show: vi.fn(), createTools: () => [], dispose: vi.fn()
  }, () => undefined, undefined, executor)
  const config = { ...(await store.agent('dobi'))!, ...(local ? { localAgentId: 'codex' } : {}) }
  const internal = runtime as any
  const calls: string[] = []
  const finish = new Map<string, () => void>()
  const start = (key: string, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    calls.push(key)
    finish.set(key, resolve)
    signal?.addEventListener('abort', () => reject(new Error('Stopped')), { once: true })
  })
  if (local) vi.mocked(runLocalAgent).mockImplementation(async (_config, _prompt, signal, _images, options) => {
    await start(options!.sessionKey!, signal)
    return { text: options!.sessionKey!, images: [] }
  })
  const run = (conversationId: string, topicId = 'topic', sessionKey = conversationId) => {
    if (!local && !internal.sessions.has(sessionKey)) internal.sessions.set(sessionKey, {
      agentId: config.id,
      agent: { state: { messages: [{ role: 'assistant', content: [{ type: 'text', text: sessionKey }] }] },
        prompt: () => start(sessionKey), abort: vi.fn() }
    })
    return internal.runReply({ config, sessionKey, conversationId, topicId, context: 'group', prompt: 'Hello' })
  }
  return { store, runtime, internal, calls, finish, run, config }
}

describe.each([false, true])('concurrent replies (local=%s)', local => {
  it('runs the same agent in separate conversations and stopping one leaves the other active', async () => {
    const { runtime, internal, calls, finish, run, config } = await setup(local)
    const a = run('crew'), b = run('direct-dobi')
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(internal.activeConversation.get('crew')).toBe('crew')
    expect(internal.activeConversation.get('direct-dobi')).toBe('direct-dobi')
    await runtime.stopConversation('crew')
    expect((await a).error).toBeTruthy()
    expect(internal.statuses.get(config.id)).toBe('thinking')
    expect(internal.activeConversation.get('direct-dobi')).toBe('direct-dobi')
    finish.get('direct-dobi')!()
    expect((await b).text).toBe('direct-dobi')
    expect(internal.statuses.get(config.id)).toBe('idle')
    expect(internal.pendingReplies.size).toBe(0)
  })

  it('serializes a topic while allowing another topic to proceed', async () => {
    const { calls, finish, run } = await setup(local)
    const a = run('crew', 'one', 'first'), b = run('crew', 'one', 'second'), c = run('crew', 'two', 'other-topic')
    await vi.waitFor(() => expect(calls).toEqual(['first', 'other-topic']))
    finish.get('other-topic')!(); await c
    expect(calls).not.toContain('second')
    finish.get('first')!(); await a
    await vi.waitFor(() => expect(calls).toContain('second'))
    finish.get('second')!(); await b
  })

  it('does not execute a queued reply after the conversation is stopped', async () => {
    const { runtime, calls, run } = await setup(local)
    const a = run('crew', 'one', 'first'), b = run('crew', 'one', 'second')
    await vi.waitFor(() => expect(calls).toEqual(['first']))
    await runtime.stopConversation('crew')
    await a
    expect((await b).error).toBe('Reply stopped')
    expect(calls).toEqual(['first'])
  })
})


it('bounds idle model sessions and expires them without retaining timers', async () => {
  const { internal, run, calls, finish } = await setup(false)
  for (let i = 0; i < 35; i++) {
    const key = `cache-${i}`
    const pending = run(key)
    await vi.waitFor(() => expect(calls).toContain(key))
    finish.get(key)!()
    await pending
  }
  expect(internal.sessions.size).toBe(32)
  expect(internal.sessions.has('cache-0')).toBe(false)
  const recent = internal.sessions.get('cache-34')
  vi.useFakeTimers()
  internal.retainIdleSession('cache-34')
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  expect(internal.sessions.has('cache-34')).toBe(false)
  expect(recent.agent.abort).toHaveBeenCalledOnce()
  for (const key of [...internal.sessions.keys()]) internal.disposeSession(key)
})



it('uses an injected executor for replies and session lifecycle', async () => {
  const executor = {
    run: vi.fn(async () => ({ text: 'Injected executor reply', images: [] })),
    resetConversation: vi.fn(), disposeAgent: vi.fn()
  }
  const { run, runtime, config, store } = await setup(true, executor)
  expect((await run('crew')).text).toBe('Injected executor reply')
  expect(executor.run).toHaveBeenCalledOnce()
  expect(runLocalAgent).not.toHaveBeenCalled()
  await runtime.resetConversation('crew', 'main')
  expect(executor.resetConversation).toHaveBeenCalledWith('crew', 'main', [])
  runtime.disposeAgent(config.id)
  expect(executor.disposeAgent).toHaveBeenCalledWith(config.id)
  await store.close()
})
