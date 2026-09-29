import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopStartupError, startDesktop, stopDesktop } from './desktop'
import { DesktopRepository } from './desktopRepository'
import { migrateLegacyState } from './legacy/migrate'
import { addCustomLocalAgent, detectLocalAgents, removeCustomLocalAgent } from './localAgents'
import type { SecretCodec } from './credentialVault'

const roots: string[] = []
const userData = (): string => { const root = mkdtempSync(join(tmpdir(), 'desktop-boot-')); roots.push(root); return root }
const codec: SecretCodec = { available: () => true, encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() }
afterEach(() => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const agent = (id: string) => ({ id, name: `Agent ${id}`, role: 'Helper', instructions: '', color: '#0b5cff', provider: 'test', model: 'fixture', createdAt: 1 })
const topic = { id: 'topic-1', title: 'Main', createdAt: 1, updatedAt: 1 }
const conversation = (id: string, agentId: string) => ({ id, type: 'direct', name: `Agent ${agentId}`, agentIds: [agentId], topics: [topic], activeTopicId: topic.id, unread: 0, readAt: 0, createdAt: 1, updatedAt: 1 })
const message = (id: string, conversationId: string, text: string, createdAt: number) => ({ id, conversationId, topicId: topic.id, authorId: 'user', authorName: 'You', text, kind: 'message', createdAt })

/** A database the way an earlier release left it. Ids are deliberately not FeltDB-safe keys. */
function legacyDatabase(directory: string): void {
  const database = new DatabaseSync(join(directory, 'douchat.db'))
  for (const table of ['agents', 'conversations', 'messages']) database.exec(`CREATE TABLE ${table} (data TEXT)`)
  database.exec('CREATE TABLE meta (key TEXT, value TEXT)')
  const put = (table: string, value: unknown) => database.prepare(`INSERT INTO ${table} (data) VALUES (?)`).run(JSON.stringify(value))
  put('agents', agent('legacy-agent'))
  put('conversations', conversation('direct-legacy-agent', 'legacy-agent'))
  put('messages', message('im:tg:1', 'direct-legacy-agent', 'first', 10))
  put('messages', message('legacy-message-2', 'direct-legacy-agent', 'second', 20))
  database.close()
}

describe('offline operation', () => {
  it('starts and works with no network, account or provider', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('network is not available') })
    vi.stubGlobal('fetch', fetchSpy)
    const root = userData()
    const desktop = await startDesktop({ userData: root, codec })
    try {
      expect(desktop.migration.status).toBe('not-needed')
      const created = await desktop.repository.createAgent({ name: 'Local', role: '', instructions: '', color: '', provider: 'local', model: 'default' })
      const { conversation: chat } = await desktop.repository.ensureDirectConversation(created.id)
      await desktop.repository.addMessage({ conversationId: chat.id, topicId: chat.activeTopicId, authorId: 'user', authorName: 'You', text: 'offline note', kind: 'message' })
      await desktop.repository.updateAgent(created.id, { role: 'Renamed' })
      expect((await desktop.repository.agent(created.id))?.role).toBe('Renamed')
      expect((await desktop.repository.messages()).map(item => item.text)).toEqual(['offline note'])
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally { await stopDesktop(desktop) }
  })

  it('fails closed, without a fallback store, when the database cannot open', async () => {
    const root = userData()
    const first = await startDesktop({ userData: root, codec })
    try { await expect(startDesktop({ userData: root, codec })).rejects.toBeInstanceOf(DesktopStartupError) }
    finally { await stopDesktop(first) }
  })
})

describe('shutdown persistence', () => {
  it('keeps everything written before a clean shutdown, and leaves no lock behind', async () => {
    const root = userData()
    const desktop = await startDesktop({ userData: root, codec })
    const created = await desktop.repository.createAgent({ name: 'Persist', role: '', instructions: '', color: '', provider: 'local', model: 'default' })
    const { conversation: chat } = await desktop.repository.ensureDirectConversation(created.id)
    for (let i = 0; i < 25; i++) await desktop.repository.addMessage({ conversationId: chat.id, topicId: chat.activeTopicId, authorId: 'user', authorName: 'You', text: `note ${i}`, kind: 'message' })
    // Writes that are still in flight when shutdown begins are part of it.
    const inFlight = [desktop.repository.setSetting('late', { value: 1 }), desktop.repository.setUserName('Robin')]
    await stopDesktop(desktop)
    await Promise.all(inFlight)
    expect(existsSync(join(desktop.databaseDirectory, 'desktop.lock'))).toBe(false)

    const reopened = await startDesktop({ userData: root, codec })
    try {
      expect((await reopened.repository.agent(created.id))?.name).toBe('Persist')
      expect((await reopened.repository.messages()).map(item => item.text)).toEqual(Array.from({ length: 25 }, (_, i) => `note ${i}`))
      expect(await reopened.repository.setting('late')).toEqual({ value: 1 })
      expect(await reopened.repository.userName()).toBe('Robin')
    } finally { await stopDesktop(reopened) }
  })

  it('refuses writes after close instead of losing them silently', async () => {
    const repository = await DesktopRepository.open(userData())
    await repository.close()
    await expect(repository.setSetting('x', 1)).rejects.toThrow(/shutting down|closed/i)
  })
})

describe('legacy migration', () => {
  it('imports once, keeps ids, and running it again duplicates and corrupts nothing', async () => {
    const root = userData()
    legacyDatabase(root)
    const desktop = await startDesktop({ userData: root, codec })
    try {
      expect(desktop.migration).toMatchObject({ status: 'complete', verified: true })
      const snapshot = async () => ({
        agents: await desktop.repository.agents(), conversations: await desktop.repository.conversations(),
        messages: await desktop.repository.messages(), counts: await desktop.repository.counts()
      })
      const once = await snapshot()
      expect(once.agents.map(item => item.id)).toEqual(['legacy-agent'])
      expect(once.conversations.map(item => item.id)).toEqual(['direct-legacy-agent'])
      expect(once.messages.map(item => item.id)).toEqual(['im:tg:1', 'legacy-message-2'])

      // Same launch again: the completed marker short-circuits.
      const again = await migrateLegacyState(desktop.repository, { userData: root, codec, vault: desktop.vault, imStorage: desktop.imStorage })
      expect(again.status).toBe('complete')
      expect(await snapshot()).toEqual(once)

      // Worst case: the marker is lost, so the import genuinely runs a second time over the same source.
      await desktop.repository.setMigration({})
      const forced = await migrateLegacyState(desktop.repository, { userData: root, codec, vault: desktop.vault, imStorage: desktop.imStorage })
      expect(forced).toMatchObject({ status: 'complete', verified: true })
      expect(await snapshot()).toEqual(once)
    } finally { await stopDesktop(desktop) }

    // The source is never modified, and the imported state survives a restart with the same ids.
    expect(existsSync(join(root, 'douchat.db'))).toBe(true)
    const reopened = await startDesktop({ userData: root, codec })
    try { expect((await reopened.repository.messages()).map(item => item.id)).toEqual(['im:tg:1', 'legacy-message-2']) }
    finally { await stopDesktop(reopened) }
  })

  it('stores no provider secret in FeltDB', async () => {
    const root = userData()
    const desktop = await startDesktop({ userData: root, codec })
    await desktop.providers.save([{ id: 'p', name: 'P', kind: 'openai', apiBase: 'https://example.com/v1', apiKey: 'sk-secret-value', models: ['m'] }], 'p/m')
    await stopDesktop(desktop)
    for (const entry of readdirSync(desktop.databaseDirectory, { withFileTypes: true })) {
      if (entry.isFile()) expect(readFileSync(join(desktop.databaseDirectory, entry.name), 'utf8')).not.toContain('sk-secret-value')
    }
  })
})

describe('custom local agents', () => {
  it('are kept in FeltDB and survive a restart', async () => {
    const root = userData()
    const first = await startDesktop({ userData: root, codec })
    await addCustomLocalAgent({ name: 'My CLI', command: process.execPath, args: ['--flag'] })
    expect(await first.repository.localAgentDefinitions()).toEqual([expect.objectContaining({ name: 'My CLI', command: process.execPath, args: ['--flag'] })])
    await stopDesktop(first)
    expect(existsSync(join(root, 'local-agents.json'))).toBe(false)
    const second = await startDesktop({ userData: root, codec })
    try {
      const agents = await detectLocalAgents({ executable: async () => undefined, desktopApp: async () => undefined, version: async () => undefined })
      expect(agents.find(agent => agent.name === 'My CLI')).toMatchObject({ custom: true, command: process.execPath })
    } finally { await stopDesktop(second) }
  })

  it('import local-agents.json once, leave the file alone, and do not resurrect removed agents', async () => {
    const root = userData()
    const id = 'custom:11111111-1111-4111-8111-111111111111'
    const file = join(root, 'local-agents.json')
    const original = JSON.stringify([{ id, name: 'Old CLI', command: process.execPath, args: [] }], null, 2)
    writeFileSync(file, original)
    const first = await startDesktop({ userData: root, codec })
    expect((await first.repository.localAgentDefinitions()).map(item => item.id)).toEqual([id])
    await removeCustomLocalAgent(id)
    await stopDesktop(first)
    expect(readFileSync(file, 'utf8')).toBe(original)
    const second = await startDesktop({ userData: root, codec })
    try { expect(await second.repository.localAgentDefinitions()).toEqual([]) }
    finally { await stopDesktop(second) }
  })
})
