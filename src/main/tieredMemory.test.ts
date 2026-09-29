import { afterEach, expect, it, vi } from 'vitest'
import { DouchatRuntime } from './runtime'
import { userMemoryPrompt } from '../shared/userMemory'
import { createTestDesktop, disposeTestDesktops } from './testSupport'
import type { ComputerProvider } from './computer'
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); vi.useRealTimers() })
function setup() {
  const desktop = createTestDesktop()
  const root = desktop.root, store = desktop.repository
  cleanups.push(disposeTestDesktops)
  const create = (name: string) => store.createAgent({ name, role: '', instructions: '', color: '#123456', provider: 'local', model: 'default', localAgentId: 'codex' })
  const agent = create('Reader'), other = create('Other')
  const remember = (key: string, text: string, kind: 'profile' | 'memory' = 'memory') => store.userMemories.remember({ scope: 'agent', action: 'remember', kind, key, text, evidence: text }, agent.id, text)
  return { root, store, agent, other, remember }
}
it('separates profile and summary, records local dates, and retrieves corrected historical decisions', () => {
  const { store, agent, remember } = setup()
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 24, 12))
  remember('interest', 'I study astronomy', 'profile')
  remember('decision', 'Project Orion uses SQLite')
  vi.setSystemTime(new Date(2026, 8, 25, 12))
  remember('decision', 'Project Orion uses PostgreSQL')
  const doc = store.userMemories.read(agent.id)
  expect(doc.facts.filter(f => f.kind === 'profile').map(f => f.text)).toEqual(['I study astronomy'])
  expect(doc.facts.filter(f => (f.kind ?? 'memory') === 'memory').map(f => f.text)).toEqual(['Project Orion uses PostgreSQL'])
  expect([...store.userMemories.dates(agent.id)].sort()).toEqual(['2026-09-24', '2026-09-25'])
  expect(store.userMemories.search('Orion SQLite', agent.id).hits).toContainEqual(expect.objectContaining({ text: 'Project Orion uses SQLite', historical: true, path: 'memory/2026-09-24.md' }))
  expect(store.userMemories.readHistory('agent', '2026-09-24.md', agent.id).text).toContain('SQLite')
  expect(userMemoryPrompt(store.userMemories.read(), doc)).not.toContain('SQLite')
  expect(() => store.userMemories.readHistory('agent', '../USER.md', agent.id)).toThrow('Invalid memory date')
  store.userMemories.remember({ scope: 'agent', action: 'forget', key: 'decision', evidence: 'Forget Orion' }, agent.id, 'Forget Orion')
  expect(store.userMemories.search('Orion', agent.id).hits).toEqual([])
  for (const date of store.userMemories.dates(agent.id)) expect(store.userMemories.readHistory('agent', date, agent.id).text).not.toContain('Orion')
})
it('keeps evicted summary facts searchable, supports archived-key forgetting and clears history', () => {
  const { store, agent, remember } = setup()
  vi.useFakeTimers()
  for (let i = 0; i < 103; i++) { vi.setSystemTime(new Date(2026, 8, 25, 12, 0, i)); remember(`fact-${i}`, `Decision number ${i} NEBULA${i}`) }
  const doc = store.userMemories.read(agent.id)
  expect(doc.facts).toHaveLength(100)
  expect(doc.facts.some(f => f.key === 'fact-0')).toBe(false)
  expect(store.userMemories.search('NEBULA0', agent.id).hits[0]).toMatchObject({ key: 'fact-0', historical: true })
  store.userMemories.remember({ scope: 'agent', action: 'forget', key: 'fact-0', evidence: 'forget' }, agent.id, 'forget')
  expect(store.userMemories.search('NEBULA0', agent.id).hits).toEqual([])
  store.userMemories.save({ ...store.userMemories.read(agent.id), notes: '', memoryNotes: '', facts: [], clearHistory: true }, agent.id)
  expect(store.userMemories.search('NEBULA', agent.id).hits).toEqual([])
})
it('defaults to private, requires explicit shared intent, and guards hosted retrieval by turn', async () => {
  const { store, agent, other, remember } = setup()
  remember('secret', 'PRIVATE_STARGAZER')
  expect(store.userMemories.search('PRIVATE_STARGAZER', other.id).hits).toEqual([])
  const edit = { scope: 'shared' as const, action: 'remember' as const, key: 'shared', text: 'SHARED_STARGAZER', evidence: 'Share this' }
  expect(() => store.userMemories.remember(edit, agent.id, 'Share this')).toThrow('explicit request')
  store.userMemories.remember({ ...edit, shareWithAll: true }, agent.id, 'Share this')
  expect(store.userMemories.search('SHARED_STARGAZER', other.id).hits[0].scope).toBe('shared')
  const computer: ComputerProvider = { snapshots: () => [], start: vi.fn(), stop: vi.fn(), show: vi.fn(), createTools: () => [], dispose: vi.fn() }
  const runtime = new DouchatRuntime(store, computer, () => {})
  cleanups.push(() => runtime.disposeAgent(agent.id))
  const internal = runtime as any, key = `direct:direct-${agent.id}:topic`
  const [search] = internal.memoryRetrievalTools(key)
  await expect(search.execute('outside', { query: 'STARGAZER' })).rejects.toThrow('active private')
  internal.memoryTurns.set(key, { userId: 'owner', agentId: agent.id, humanText: 'remember?', signal: new AbortController().signal, groupId: 'group' })
  await expect(search.execute('group', { query: 'STARGAZER' })).rejects.toThrow('active private')
  internal.memoryTurns.set(key, { userId: 'owner', agentId: agent.id, humanText: 'remember?', signal: new AbortController().signal })
  expect((await search.execute('valid', { query: 'STARGAZER' })).content[0].text).toContain('PRIVATE_STARGAZER')
})
