import { openAtFile } from './testSupport'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopRepository } from './desktopRepository'
import { DouchatRuntime } from './runtime'
import type { ComputerProvider } from './computer'
import { runLocalAgent } from './localAgentRuntime'
import { MEMORY_OPEN, MEMORY_CLOSE, localUserMemoryEdits, type UserMemoryEdit } from '../shared/userMemory'
vi.mock('./localAgentRuntime', () => ({ runLocalAgent: vi.fn(), disposeLocalAgentSessions: vi.fn(), resetLocalAgentConversation: vi.fn() }))
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks(); vi.resetAllMocks() })
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'douchat-memory-')), path = join(directory, 'memory.db')
  const store = openAtFile(path)
  const first = store.createAgent({ name: 'First', role: 'Assistant', instructions: '', localAgentId: 'codex', provider: 'local', model: 'default', color: '#123456' })
  const second = store.createAgent({ name: 'Second', role: 'Assistant', instructions: '', localAgentId: 'codex', provider: 'local', model: 'default', color: '#123456' })
  const computer: ComputerProvider = { snapshots: () => [], start: vi.fn(), stop: vi.fn(), show: vi.fn(), createTools: () => [], dispose: vi.fn() }
  const runtime = new DouchatRuntime(store, computer, () => {})
  cleanup.push(() => { for (const agent of store.agents) runtime.disposeAgent(agent.id); store.close(); rmSync(directory, { recursive: true, force: true }) })
  return { store, runtime, first, second, path }
}
const shared: UserMemoryEdit = { scope: 'shared', shareWithAll: true, action: 'remember', key: 'preferred_name', text: 'My name is Alex', evidence: 'I am Alex' }
const directive = (edit: UserMemoryEdit) => `${MEMORY_OPEN}${JSON.stringify(edit)}${MEMORY_CLOSE}`

it('recalls a private travel assignment in another local group', async () => {
  const { store, runtime, first, second } = setup()
  vi.mocked(runLocalAgent).mockResolvedValue({ text: '收到', images: [] })
  await runtime.sendMessage(`direct-${first.id}`, '下周三去杭州两天，对接人微信 zhongtai')
  const group = store.createGroup({ name: '内部工作群', agentIds: [second.id] })
  const options = { config: second, sessionKey: `group:${group.id}:${second.id}:topic`, context: 'group',
    conversationId: group.id, topicId: group.activeTopicId, prompt: '最近有什么待办事项',
    groupMemoryRequest: { groupId: group.id, speaker: { id: 'owner', name: 'Owner' }, text: '最近有什么待办事项' } }
  await (runtime as any).performReply(options)
  expect(vi.mocked(runLocalAgent).mock.calls.at(-1)![1]).toContain('对接人微信 zhongtai')
})

it('rechecks internal search access when the conversation changes', async () => {
  const { store, runtime, first } = setup()
  const group = store.createGroup({ name: 'Internal', agentIds: [first.id] })
  const key = `group:${group.id}:${first.id}:topic`, internals = runtime as any
  const tool = internals.internalMemoryTool(key)
  await expect(tool.execute('call', { query: 'tasks' })).rejects.toThrow('unavailable')
  internals.memoryTurns.set(key, { userId: 'owner', agentId: first.id, humanText: 'tasks', signal: new AbortController().signal, groupId: group.id, speaker: { id: 'owner', name: 'Owner' } })
  internals.activeConversation.set(key, group.id)
  await expect(tool.execute('call', { query: 'tasks' })).resolves.toBeDefined()
  internals.activeConversation.set(key, 'another-conversation')
  await expect(tool.execute('call', { query: 'tasks' })).rejects.toThrow('unavailable')
})

it('shares ordinary user facts, isolates agent memories and persists across restart', () => {
  const { store, first, second, path } = setup()
  store.userMemories.remember(shared, first.id, 'I am Alex', 'owner')
  store.userMemories.remember({ ...shared, scope: 'agent', key: 'nickname', text: 'Call me Captain', evidence: 'Call me Captain' }, first.id, 'Call me Captain', 'owner')
  expect(store.userMemories.read().facts[0].text).toBe('My name is Alex')
  expect(store.userMemories.read(first.id).facts).toHaveLength(1)
  expect(store.userMemories.read(second.id).facts).toEqual([])
  store.deleteAgent(first.id)
  expect(store.userMemories.read().facts).toHaveLength(1)
  expect(() => store.userMemories.read(first.id)).toThrow('Agent not found')
  store.close()
  const reopened = openAtFile(path)
  try { expect(reopened.userMemories.read().facts[0].text).toBe('My name is Alex'); expect(() => reopened.userMemories.read(first.id)).toThrow('Agent not found') } finally { reopened.close() }
})

it('rejects stale edits, fabricated evidence and disabled writes', () => {
  const { store, first } = setup()
  const stale = store.userMemories.read()
  expect(() => store.userMemories.remember(shared, first.id, 'Unrelated message', 'owner')).toThrow('current human message')
  store.userMemories.remember(shared, first.id, 'I am Alex', 'owner')
  expect(() => store.userMemories.save(stale)).toThrow('Memory changed')
  store.userMemories.save({ ...store.userMemories.read(), autoRemember: false })
  expect(() => store.userMemories.remember(shared, first.id, 'I am Alex', 'owner')).toThrow('disabled')
  store.userMemories.save({ ...store.userMemories.read(), facts: [] })
  expect(store.userMemories.read().facts).toEqual([])
})

it('replaces corrections by key and allows explicit forgetting without duplicates', () => {
  const { store, first } = setup()
  store.userMemories.remember(shared, first.id, 'I am Alex', 'owner')
  store.userMemories.remember({ ...shared, text: 'My name is Dou', evidence: 'Call me Dou' }, first.id, 'Call me Dou', 'owner')
  expect(store.userMemories.read().facts).toHaveLength(1)
  expect(store.userMemories.read().facts[0].text).toBe('My name is Dou')
  store.userMemories.remember({ ...shared, action: 'forget', evidence: 'Forget my name' }, first.id, 'Forget my name', 'owner')
  expect(store.userMemories.read().facts).toEqual([])
})

it('shares memory across agents and hides directives', async () => {
  const { store, runtime, first, second } = setup()
  vi.mocked(runLocalAgent).mockResolvedValueOnce({ text: `Hello! ${directive(shared)}`, images: [] })
  await runtime.sendMessage(`direct-${first.id}`, 'I am Alex')
  expect(store.userMemories.read().facts[0].text).toBe('My name is Alex')
  const transcript = store.topicMessages(`direct-${first.id}`, store.activeTopicId(`direct-${first.id}`)).at(-1)!.text
  expect(transcript).not.toContain(MEMORY_OPEN); expect(transcript).toContain('shared user profile')
  store.userMemories.save({ ...store.userMemories.read(first.id), notes: 'FIRST_PRIVATE_SENTINEL' }, first.id)
  vi.mocked(runLocalAgent).mockResolvedValue({ text: 'Hello', images: [] })
  await runtime.sendMessage(`direct-${second.id}`, 'Who am I?')
  let prompt = vi.mocked(runLocalAgent).mock.calls.at(-1)![1]
  expect(prompt).toContain('My name is Alex'); expect(prompt).toContain('FIRST_PRIVATE_SENTINEL')
  await runtime.sendMessage(`direct-${first.id}`, 'What do you know?')
  expect(vi.mocked(runLocalAgent).mock.calls.at(-1)![1]).toContain('FIRST_PRIVATE_SENTINEL')
})

it('checks cancellation and permission changes before applying a local memory update', async () => {
  const { store, runtime, first } = setup()
  vi.mocked(runLocalAgent).mockImplementationOnce(async () => {
    store.userMemories.save({ ...store.userMemories.read(), autoRemember: false })
    return { text: directive(shared), images: [] }
  })
  await runtime.sendMessage(`direct-${first.id}`, 'I am Alex')
  expect(store.userMemories.read().facts).toEqual([])
  expect(store.topicMessages(`direct-${first.id}`, store.activeTopicId(`direct-${first.id}`)).at(-1)!.text).toContain('not saved')
  expect(localUserMemoryEdits(`${MEMORY_OPEN}{broken`)).toMatchObject({ text: '', edits: [], invalid: true })
})

it('refreshes hosted memory context each turn and guards the hosted memory tool', async () => {
  const { store, runtime, first } = setup()
  const config = { ...first, localAgentId: undefined }
  const key = `direct:direct-${first.id}:topic`
  const internals = runtime as any
  const tool = internals.userMemoryTool(key)
  await expect(tool.execute('outside', shared)).rejects.toThrow('private conversation')
  const state = { systemPrompt: '', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }] }
  const fakeSession = { state, abort: vi.fn(), prompt: vi.fn(async () => { await tool.execute('call', shared) }) }
  vi.spyOn(internals, 'session').mockReturnValue(fakeSession)
  const options = { config, sessionKey: key, context: 'direct', prompt: 'I am Alex', memoryRequest: 'I am Alex', conversationId: `direct-${first.id}`, topicId: 'topic' }
  await internals.performReply(options)
  expect(store.userMemories.read().facts[0].text).toBe('My name is Alex')
  fakeSession.prompt.mockImplementation(async () => {})
  store.userMemories.save({ ...store.userMemories.read(), notes: 'NEW_SHARED_SENTINEL' })
  await internals.performReply(options)
  expect(state.systemPrompt).toContain('NEW_SHARED_SENTINEL')
  await internals.performReply({ ...options, context: 'group' })
  expect(state.systemPrompt).not.toContain('NEW_SHARED_SENTINEL')
  await expect(tool.execute('outside', shared)).rejects.toThrow('private conversation')
})

it('isolates groups, attributes facts to speakers and persists across agents and restarts', () => {
  const { store, first, second, path } = setup()
  const group = store.createGroup({ name: 'Reading', agentIds: [first.id, second.id] })
  const other = store.createGroup({ name: 'Work', agentIds: [first.id] })
  const edit: UserMemoryEdit = { ...shared, scope: 'group' }
  const alex = { id: 'alex', name: 'Alex' }, dou = { id: 'dou', name: 'Dou' }
  store.groupMemories.remember(edit, group.id, first.id, alex, 'I am Alex', 'owner')
  store.groupMemories.remember({ ...edit, text: 'My name is Dou', evidence: 'I am Dou' }, group.id, second.id, dou, 'I am Dou', 'owner')
  expect(store.groupMemories.read(group.id).facts.map(f => f.subjectId)).toEqual(['alex', 'dou'])
  expect(store.groupMemories.read(other.id).facts).toEqual([])
  expect(store.userMemories.read().facts).toEqual([])
  expect(store.userMemories.read(first.id).facts).toEqual([])
  const stale = store.groupMemories.read(group.id)
  store.groupMemories.remember({ ...edit, action: 'forget', evidence: 'Forget my name' }, group.id, first.id, alex, 'Forget my name', 'owner')
  expect(store.groupMemories.read(group.id).facts.map(f => f.subjectId)).toEqual(['dou'])
  expect(() => store.groupMemories.save(stale, group.id)).toThrow('Memory changed')
  expect(() => store.groupMemories.remember(shared, group.id, first.id, alex, 'I am Alex', 'owner')).toThrow('current human')
  expect(() => store.groupMemories.remember(edit, group.id, first.id, alex, 'unrelated', 'owner')).toThrow('current human')
  store.groupMemories.save({ ...store.groupMemories.read(group.id), autoRemember: false }, group.id)
  expect(() => store.groupMemories.remember(edit, group.id, first.id, alex, 'I am Alex', 'owner')).toThrow('disabled')
  store.close()
  const reopened = openAtFile(path)
  try { expect(reopened.groupMemories.read(group.id)).toMatchObject({ autoRemember: false }); expect(reopened.groupMemories.read(group.id).facts[0].subjectId).toBe('dou') } finally { reopened.close() }
})

it('loads owner memory across internal groups and contacts, including read-only turns', async () => {
  const { store, runtime, first, second } = setup()
  const group = store.createGroup({ name: 'Reading', agentIds: [first.id, second.id] })
  store.userMemories.save({ ...store.userMemories.read(), notes: 'PRIVATE_SHARED_SENTINEL' })
  store.userMemories.save({ ...store.userMemories.read(first.id), notes: 'PRIVATE_AGENT_SENTINEL' }, first.id)
  const edit: UserMemoryEdit = { ...shared, scope: 'group' }
  const internals = runtime as any
  const options = { config: first, sessionKey: `group:${group.id}:${first.id}:topic1`, context: 'group', prompt: 'I am Alex', conversationId: group.id, topicId: 'topic1', groupMemoryRequest: { groupId: group.id, speaker: { id: 'owner', name: 'Owner' }, text: 'I am Alex' } }
  vi.mocked(runLocalAgent).mockResolvedValueOnce({ text: directive(edit), images: [] })
  await internals.performReply(options)
  expect(store.groupMemories.read(group.id).facts[0].subjectId).toBe('owner')
  vi.mocked(runLocalAgent).mockResolvedValue({ text: 'Hello', images: [] })
  await internals.performReply({ ...options, config: second, sessionKey: `group:${group.id}:${second.id}:topic2`, topicId: 'topic2', toolsDisabled: true })
  const prompt = vi.mocked(runLocalAgent).mock.calls.at(-1)![1]
  expect(prompt).toContain('My name is Alex')
  expect(prompt).toContain('Memory writes are disabled')
  expect(prompt).toContain('PRIVATE_SHARED_SENTINEL')
  expect(prompt).toContain('PRIVATE_AGENT_SENTINEL')
  vi.mocked(runLocalAgent).mockResolvedValueOnce({ text: directive({ ...edit, action: 'forget' }), images: [] })
  await internals.performReply({ ...options, toolsDisabled: true })
  expect(store.groupMemories.read(group.id).facts).toHaveLength(1)
})

it('lets hosted group tools write only group memory and rechecks cancellation and disabled settings', async () => {
  const { store, runtime, first } = setup()
  const group = store.createGroup({ name: 'Reading', agentIds: [first.id] })
  const internals = runtime as any, key = `group:${group.id}:${first.id}:topic`
  const tool = internals.userMemoryTool(key), edit: UserMemoryEdit = { ...shared, scope: 'group' }
  const state = { systemPrompt: '', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }] }
  const prompt = vi.fn(async () => {
    await expect(tool.execute('bad-scope', shared)).rejects.toThrow('current human')
    await tool.execute('remember', edit)
    store.groupMemories.save({ ...store.groupMemories.read(group.id), autoRemember: false }, group.id)
    await expect(tool.execute('disabled', edit)).rejects.toThrow('disabled')
    await expect(tool.execute('cancelled', edit, AbortSignal.abort())).rejects.toThrow()
  })
  vi.spyOn(internals, 'session').mockReturnValue({ state, abort: vi.fn(), prompt })
  await internals.performReply({ config: { ...first, localAgentId: undefined }, sessionKey: key, context: 'group', conversationId: group.id, topicId: 'topic', prompt: 'I am Alex', groupMemoryRequest: { groupId: group.id, speaker: { id: 'owner', name: 'Owner' }, text: 'I am Alex' } })
  expect(prompt).toHaveBeenCalledOnce()
  expect(state.systemPrompt).toContain('Douchat supports persistent group memory')
  expect(store.groupMemories.read(group.id).facts).toHaveLength(1)
  expect(store.userMemories.read().facts).toEqual([])
  await expect(tool.execute('outside-turn', edit)).rejects.toThrow('active human turn')
})

it('retrieves dated history across the owner’s contacts', async () => {
  const { store, runtime, first, second } = setup()
  store.userMemories.remember({ scope: 'agent', action: 'remember', key: 'decision', text: 'Orion originally used SQLite', evidence: 'SQLite' }, first.id, 'SQLite', 'owner')
  store.userMemories.remember({ scope: 'agent', action: 'remember', key: 'decision', text: 'Orion now uses PostgreSQL', evidence: 'PostgreSQL' }, first.id, 'PostgreSQL', 'owner')
  vi.mocked(runLocalAgent).mockResolvedValue({ text: 'Answer', images: [] })
  await runtime.sendMessage(`direct-${first.id}`, 'What was the Orion SQLite decision?')
  let prompt = vi.mocked(runLocalAgent).mock.calls.at(-1)![1]
  expect(prompt).toContain('Relevant memory retrieved by Douchat')
  expect(prompt).toContain('Orion originally used SQLite')
  expect(prompt).toContain('"historical":true')
  await runtime.sendMessage(`direct-${second.id}`, 'What was the Orion SQLite decision?')
  prompt = vi.mocked(runLocalAgent).mock.calls.at(-1)![1]
  expect(prompt).toContain('Orion originally used SQLite')
})
