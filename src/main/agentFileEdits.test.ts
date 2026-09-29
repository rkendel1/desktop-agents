import { openAtFile } from './testSupport'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopRepository } from './desktopRepository'
import { DouchatRuntime } from './runtime'
import { runLocalAgent } from './localAgentRuntime'
import { FILE_EDIT_OPEN, FILE_EDIT_CLOSE, localAgentFileEdits } from '../shared/agentFileEdits'
import type { ComputerProvider } from './computer'
vi.mock('./localAgentRuntime', () => ({ runLocalAgent: vi.fn(), disposeLocalAgentSessions: vi.fn(), resetLocalAgentConversation: vi.fn() }))
const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); vi.resetAllMocks() })
async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'douchat-self-edit-'))
  const path = join(directory, 'test.db')
  const store = await openAtFile(path)
  const agent = (await store.createAgent({ name: 'Reader', role: '', instructions: '', provider: 'local', model: 'default', localAgentId: 'codex', color: '#123456' }))
  const computer: ComputerProvider = { snapshots: () => [], start: vi.fn(), stop: vi.fn(), show: vi.fn(), createTools: () => [], dispose: vi.fn() }
  const runtime = new DouchatRuntime(store, computer, () => {})
  cleanup.push(async () => { runtime.disposeAgent(agent.id); await store.close(); rmSync(directory, { recursive: true, force: true }) })
  return { store, agent, runtime, internal: runtime as any, path }
}
const evidence = 'Be my reading assistant from now on. Summarize links before analysis.'
const edit = { evidence, changes: [
  { file: 'IDENTITY.md', previous: '', content: '# Identity\nReading assistant' },
  { file: 'AGENTS.md', previous: '', content: '# Workflow\nSummarize links before analysis.' }
] }
const directive = (value: unknown) => `${FILE_EDIT_OPEN}${JSON.stringify(value)}${FILE_EDIT_CLOSE}`

it('applies local identity changes, emits a receipt, and uses persisted files on later turns', async () => {
  const { store, agent, runtime, path } = await setup()
  vi.mocked(runLocalAgent).mockResolvedValueOnce({ text: directive(edit), images: [] })
  await runtime.sendMessage(`direct-${agent.id}`, evidence)
  expect((await store.agent(agent.id))?.systemFiles).toMatchObject({ 'IDENTITY.md': '# Identity\nReading assistant', 'AGENTS.md': '# Workflow\nSummarize links before analysis.' })
  const messages = (await store.contextMessages(`direct-${agent.id}`, (await store.activeTopicId(`direct-${agent.id}`))))
  expect(messages.at(-1)?.text).toContain('IDENTITY.md')
  expect(messages.at(-1)?.text).not.toContain(FILE_EDIT_OPEN)
  vi.mocked(runLocalAgent).mockResolvedValueOnce({ text: 'Ready', images: [] })
  await runtime.sendMessage(`direct-${agent.id}`, 'Hello')
  expect(vi.mocked(runLocalAgent).mock.calls.at(-1)![1]).toContain('# Identity\nReading assistant')
  const saved = (await store.agent(agent.id))?.systemFiles
  await store.close()
  const reopened = await openAtFile(path)
  try { expect((await reopened.agent(agent.id))?.systemFiles).toEqual(saved) } finally { await reopened.close() }
})

it('cloud tools read current files and reject stale batches atomically, foreign files and fabricated evidence', async () => {
  const { store, agent, internal } = await setup()
  const key = `direct:direct-${agent.id}:topic`
  const [read, update] = internal.agentFileTools(key)
  await expect(read.execute('outside', {})).rejects.toThrow('active private')
  const abort = new AbortController()
  internal.memoryTurns.set(key, { userId: 'owner', agentId: agent.id, humanText: evidence, signal: abort.signal })
  expect(JSON.parse((await read.execute('read', {})).content[0].text)['SOUL.md']).toBe('')
  await store.updateAgent(agent.id, { systemFiles: { 'AGENTS.md': 'Manual edit', 'SOUL.md': 'Stay concise' } })
  await expect(update.execute('conflict', edit)).rejects.toThrow('changed')
  expect((await store.agent(agent.id))?.systemFiles?.['IDENTITY.md']).toBeUndefined()
  await expect(update.execute('fake', { ...edit, evidence: 'not said' })).rejects.toThrow('evidence')
  await expect(update.execute('escape', { evidence, changes: [{ file: '../SOUL.md', previous: '', content: 'bad' }] })).rejects.toThrow('Invalid identity')
  await expect(update.execute('memory', { evidence, changes: [{ file: 'USER.md', previous: '', content: 'private' }] })).rejects.toThrow('Invalid identity')
  await update.execute('valid', { evidence, changes: [{ file: 'IDENTITY.md', previous: '', content: 'Reading assistant' }] })
  expect((await store.agent(agent.id))?.systemFiles?.['SOUL.md']).toBe('Stay concise')
  internal.memoryTurns.set(key, { userId: 'owner', agentId: agent.id, humanText: evidence, signal: abort.signal, groupId: 'group' })
  await expect(update.execute('group', edit)).rejects.toThrow('active private')
  internal.memoryTurns.set(key, { userId: 'owner', agentId: agent.id, humanText: evidence, signal: abort.signal })
  abort.abort()
  await expect(update.execute('cancelled', edit)).rejects.toThrow()
})

it('injects hosted editing guidance only in owner private turns and removes access after completion', async () => {
  const { agent, internal } = await setup()
  const key = `direct:direct-${agent.id}:topic`
  const tool = internal.agentFileTools(key)[1]
  const state = { systemPrompt: '', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Done' }] }] }
  const session = { state, abort: vi.fn(), prompt: vi.fn(async () => { await tool.execute('call', edit) }) }
  vi.spyOn(internal, 'session').mockReturnValue(session)
  const options = { config: { ...agent, localAgentId: undefined }, sessionKey: key, context: 'direct', prompt: evidence, memoryRequest: evidence, conversationId: `direct-${agent.id}`, topicId: 'topic' }
  await internal.performReply(options)
  expect(state.systemPrompt).toContain('read_agent_files and update_agent_files')
  await expect(tool.execute('late', edit)).rejects.toThrow('active private')
  session.prompt.mockImplementation(async () => {})
  await internal.performReply({ ...options, context: 'group' })
  expect(state.systemPrompt).not.toContain('read_agent_files and update_agent_files')
})

it('rejects malformed or multiple local batches without partially saving', () => {
  expect(localAgentFileEdits(`Hello ${directive(edit)} ${FILE_EDIT_OPEN}{bad${FILE_EDIT_CLOSE}`)).toMatchObject({ text: 'Hello', edits: [], invalid: true })
  expect(localAgentFileEdits(FILE_EDIT_OPEN + '{}')).toMatchObject({ edits: [], invalid: true })
  expect(localAgentFileEdits(directive(edit))).toMatchObject({ edits: [edit], invalid: false })
})
