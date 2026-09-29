import { afterEach, expect, it, vi } from 'vitest'
import { DouchatRuntime } from './runtime'
import { userMemoryPrompt } from '../shared/userMemory'
import { createTestDesktop, disposeTestDesktops } from './testSupport'
import type { ComputerProvider } from './computer'
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); vi.useRealTimers() })
async function setup() {
  const desktop = await createTestDesktop()
  const root = desktop.root, store = desktop.repository
  cleanups.push(disposeTestDesktops)
  const create = async (name: string) => (await store.createAgent({ name, role: '', instructions: '', color: '#123456', provider: 'local', model: 'default', localAgentId: 'codex' }))
  const agent = await create('Reader'), other = await create('Other')
  const remember = async (key: string, text: string, kind: 'profile' | 'memory' = 'memory') => (await store.userMemories.remember({ scope: 'agent', action: 'remember', kind, key, text, evidence: text }, agent.id, text))
  return { root, store, agent, other, remember }
}
it('separates profile and summary, records local dates, and retrieves corrected historical decisions', async () => {
  const { store, agent, remember } = await setup()
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 24, 12))
  await remember('interest', 'I study astronomy', 'profile')
  await remember('decision', 'Project Orion uses SQLite')
  vi.setSystemTime(new Date(2026, 8, 25, 12))
  await remember('decision', 'Project Orion uses PostgreSQL')
  const doc = (await store.userMemories.read(agent.id))
  expect(doc.facts.filter(f => f.kind === 'profile').map(f => f.text)).toEqual(['I study astronomy'])
  expect(doc.facts.filter(f => (f.kind ?? 'memory') === 'memory').map(f => f.text)).toEqual(['Project Orion uses PostgreSQL'])
  expect([...(await store.userMemories.dates(agent.id))].sort()).toEqual(['2026-09-24', '2026-09-25'])
  expect((await store.userMemories.search('Orion SQLite', agent.id)).hits).toContainEqual(expect.objectContaining({ text: 'Project Orion uses SQLite', historical: true, path: 'memory/2026-09-24.md' }))
  expect((await store.userMemories.readHistory('agent', '2026-09-24.md', agent.id)).text).toContain('SQLite')
  expect(userMemoryPrompt((await store.userMemories.read()), doc)).not.toContain('SQLite')
  await expect(async () => (await store.userMemories.readHistory('agent', '../USER.md', agent.id))).rejects.toThrow('Invalid memory date')
  await store.userMemories.remember({ scope: 'agent', action: 'forget', key: 'decision', evidence: 'Forget Orion' }, agent.id, 'Forget Orion')
  expect((await store.userMemories.search('Orion', agent.id)).hits).toEqual([])
  for (const date of (await store.userMemories.dates(agent.id))) expect((await store.userMemories.readHistory('agent', date, agent.id)).text).not.toContain('Orion')
})
it('keeps evicted summary facts searchable, supports archived-key forgetting and clears history', async () => {
  const { store, agent, remember } = await setup()
  vi.useFakeTimers()
  for (let i = 0; i < 103; i++) { vi.setSystemTime(new Date(2026, 8, 25, 12, 0, i)); await remember(`fact-${i}`, `Decision number ${i} NEBULA${i}`) }
  const doc = (await store.userMemories.read(agent.id))
  expect(doc.facts).toHaveLength(100)
  expect(doc.facts.some(f => f.key === 'fact-0')).toBe(false)
  expect((await store.userMemories.search('NEBULA0', agent.id)).hits[0]).toMatchObject({ key: 'fact-0', historical: true })
  await store.userMemories.remember({ scope: 'agent', action: 'forget', key: 'fact-0', evidence: 'forget' }, agent.id, 'forget')
  expect((await store.userMemories.search('NEBULA0', agent.id)).hits).toEqual([])
  await store.userMemories.save({ ...(await store.userMemories.read(agent.id)), notes: '', memoryNotes: '', facts: [], clearHistory: true }, agent.id)
  expect((await store.userMemories.search('NEBULA', agent.id)).hits).toEqual([])
})
it('defaults to private, requires explicit shared intent, and guards hosted retrieval by turn', async () => {
  const { store, agent, other, remember } = await setup()
  await remember('secret', 'PRIVATE_STARGAZER')
  expect((await store.userMemories.search('PRIVATE_STARGAZER', other.id)).hits).toEqual([])
  const edit = { scope: 'shared' as const, action: 'remember' as const, key: 'shared', text: 'SHARED_STARGAZER', evidence: 'Share this' }
  await expect(async () => (await store.userMemories.remember(edit, agent.id, 'Share this'))).rejects.toThrow('explicit request')
  await store.userMemories.remember({ ...edit, shareWithAll: true }, agent.id, 'Share this')
  expect((await store.userMemories.search('SHARED_STARGAZER', other.id)).hits[0].scope).toBe('shared')
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
