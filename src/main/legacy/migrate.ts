import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { editableIdentityFiles } from '../../shared/agentFileEdits'
import { LOCAL_USER_ID, emptyUserMemory, type UserMemoryDocument } from '../../shared/userMemory'
import { validateAgentFiles, type AgentFiles } from '../../shared/agentCustomization'
import type { AgentConfig, ChatMessage, Conversation, PrivateMessage, Routine, RunEvent, TaskRun } from '../../shared/types'
import type { DesktopRepository } from '../desktopRepository'
import type { CredentialVault, SecretCodec } from '../credentialVault'
import type { IMChannelStorage, RecordData } from '../imChannels'
import { LegacyMemoryFiles, legacyProfileDirectory } from './memoryFiles'

/**
 * One-time import of what earlier releases kept: `douchat.db` (SQLite), memory
 * and profile Markdown files, attachment files, per-account provider and
 * connector secrets, and agent working-folder bindings.
 *
 * The import is:
 *  - read-only against the source — nothing there is modified or deleted;
 *  - idempotent — every record keeps its original id, so running it again
 *    replaces rather than duplicates;
 *  - verified — every imported id is read back from FeltDB before the desktop
 *    is marked migrated, and until then it will be attempted again.
 *
 * Hosted-account state (cloud contacts, friends, shared rooms, credits) is
 * not carried over; it is counted in the report instead.
 */
export const MIGRATION_VERSION = 1

export interface MigrationReport {
  status: 'complete' | 'not-needed' | 'failed'
  version: number
  at: number
  source?: string
  imported: Record<string, number>
  skipped: Record<string, number>
  verified: boolean
  error?: string
}

export interface LegacyMigrationOptions {
  userData: string
  /** Decrypts secrets written by earlier releases so they can move into the credential vault. */
  codec?: SecretCodec
  vault?: CredentialVault
  imStorage?: IMChannelStorage
  now?: () => number
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const ACCOUNT_META = 'account:v1:'

export const legacyDatabasePath = (userData: string): string => join(userData, 'douchat.db')

export async function migrateLegacyState(repository: DesktopRepository, options: LegacyMigrationOptions): Promise<MigrationReport> {
  const previous = (await repository.migration()) as MigrationReport | undefined
  if (previous && (previous.status === 'complete' || previous.status === 'not-needed') && previous.version === MIGRATION_VERSION) return previous
  const now = options.now ?? Date.now
  const source = legacyDatabasePath(options.userData)
  if (!existsSync(source)) {
    const report: MigrationReport = { status: 'not-needed', version: MIGRATION_VERSION, at: now(), imported: {}, skipped: {}, verified: true }
    await repository.setMigration({ ...report })
    return report
  }
  try {
    const report = await new Importer(repository, options, source).run()
    await repository.setMigration({ ...report })
    return report
  } catch (error) {
    const report: MigrationReport = {
      status: 'failed', version: MIGRATION_VERSION, at: now(), source, imported: {}, skipped: {}, verified: false,
      error: error instanceof Error ? error.message : String(error)
    }
    // The source is untouched, so the next launch simply tries again. Say so, once.
    await repository.setMigration({ ...report })
    await repository.addAttention({ id: 'legacy-migration', kind: 'migration', title: 'Earlier data could not be imported yet', detail: report.error })
    return report
  }
}

interface Row { data?: string; [key: string]: unknown }

class Importer {
  private readonly database: DatabaseSync
  private readonly imported: Record<string, number> = {}
  private readonly skipped: Record<string, number> = {}
  private readonly expected = { agent: new Set<string>(), session: new Set<string>(), message: new Set<string>(), attachment: new Set<string>(), memory: new Set<string>() }
  private readonly meta = new Map<string, string>()
  private readonly attachmentDirectory: string
  private primary = ''

  constructor(private readonly repository: DesktopRepository, private readonly options: LegacyMigrationOptions, private readonly source: string) {
    this.database = new DatabaseSync(source, { readOnly: true })
    this.attachmentDirectory = join(options.userData, 'attachments')
  }

  private count(kind: string, by = 1): void { this.imported[kind] = (this.imported[kind] ?? 0) + by }
  private skip(kind: string, by = 1): void { this.skipped[kind] = (this.skipped[kind] ?? 0) + by }

  private rows(sql: string, ...parameters: (string | number)[]): Row[] {
    try { return this.database.prepare(sql).all(...parameters) as Row[] }
    catch { return [] }
  }

  private json<T>(row: Row): T | undefined {
    try { return JSON.parse(row.data as string) as T } catch { return undefined }
  }

  async run(): Promise<MigrationReport> {
    try {
      for (const row of this.rows('SELECT key, value FROM meta')) this.meta.set(row.key as string, row.value as string)
      const agents = this.rows('SELECT data FROM agents ORDER BY rowid').flatMap(row => this.json<AgentConfig & Record<string, unknown>>(row) ?? [])
      const conversations = this.rows('SELECT data FROM conversations ORDER BY rowid').flatMap(row => this.json<Conversation & Record<string, unknown>>(row) ?? [])
      this.primary = this.primaryAccount(agents, conversations)

      const importedAgents = await this.importAgents(agents)
      const importedConversations = await this.importConversations(conversations, importedAgents)
      await this.importMessages(importedConversations)
      await this.importPrivateMessages(importedConversations)
      await this.importAutomation(importedAgents, importedConversations)
      await this.importGroupStates(importedConversations)
      await this.importAttachments()
      await this.importSettings(importedConversations)
      await this.importMemories(importedAgents, importedConversations)
      await this.importSecrets()
      await this.importWorkspaceBindings()
      // The importer wrote runs that were mid-flight when the old app closed; they did not finish.
      await this.repository.recoverInterruptedRuns()
    } finally {
      this.database.close()
    }
    const verified = await this.verify()
    if (!verified) throw new Error('Imported records could not be read back from FeltDB')
    return { status: 'complete', version: MIGRATION_VERSION, at: (this.options.now ?? Date.now)(), source: this.source, imported: this.imported, skipped: this.skipped, verified }
  }

  /** The account whose settings, memory and secrets become the desktop's. */
  private primaryAccount(agents: (AgentConfig & Record<string, unknown>)[], conversations: (Conversation & Record<string, unknown>)[]): string {
    const current = this.meta.get('currentAccountId')
    if (current) return current
    try {
      const contacts = JSON.parse(this.meta.get('accountDefaultContacts:v1') ?? '[]') as { accountId?: string }[]
      const known = contacts.map(item => item.accountId).filter((id): id is string => Boolean(id))
      if (known.length === 1) return known[0]
    } catch { /* fall through to ownership counts */ }
    const owners = new Map<string, number>()
    for (const item of [...agents, ...conversations]) if (typeof item.ownerId === 'string' && item.ownerId) owners.set(item.ownerId, (owners.get(item.ownerId) ?? 0) + 1)
    return [...owners].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
  }

  private accountMeta(key: string): string | undefined {
    return (this.primary ? this.meta.get(`${ACCOUNT_META}${this.primary}:${key}`) : undefined) || this.meta.get(key) || undefined
  }

  private async importAgents(agents: (AgentConfig & Record<string, unknown>)[]): Promise<Set<string>> {
    const imported = new Set<string>()
    const files = new Map<string, AgentFiles>()
    for (const agent of agents) {
      // The hosted onboarding contact only works against the Foundry service.
      if (agent.systemRole === 'admin') { this.skip('cloudAgents'); continue }
      const {
        ownerId, systemRole: _role, systemKey: _key, cloudAgentId: _cloud, templateVersion: _template, modelRoute: _route,
        capabilities: _capabilities, userOverrides: _overrides, systemFilesDirectory: _directory, ...clean
      } = agent as AgentConfig & Record<string, unknown>
      const systemFiles = this.profileFiles(ownerId as string | undefined, agent)
      files.set(agent.id, systemFiles)
      const next = { ...clean, ...(Object.keys(systemFiles).length ? { systemFiles } : {}) } as AgentConfig
      await this.repository.importer.agent(next)
      imported.add(agent.id); this.expected.agent.add(agent.id); this.count('agents')
    }
    return imported
  }

  /** Profile Markdown files were authoritative for identity text; the database held only a snapshot. */
  private profileFiles(owner: string | undefined, agent: AgentConfig): AgentFiles {
    const merged: AgentFiles = { ...agent.systemFiles }
    if (!owner) return merged
    const directory = legacyProfileDirectory(join(this.options.userData, 'accounts'), owner, agent.id)
    for (const name of editableIdentityFiles) {
      const path = join(directory, name)
      if (!existsSync(path)) continue
      try {
        const content = readFileSync(path, 'utf8')
        validateAgentFiles({ [name]: content })
        merged[name] = content
      } catch { this.skip('profileFiles') }
    }
    return merged
  }

  private async importConversations(conversations: (Conversation & Record<string, unknown>)[], agents: Set<string>): Promise<Set<string>> {
    const imported = new Set<string>()
    for (const conversation of conversations) {
      // Rooms shared through the hosted service, and chats with hosted friends, live on that service.
      if (conversation.remoteRoomId || conversation.socialRoom || conversation.person) { this.skip('cloudConversations'); continue }
      const members = conversation.agentIds.filter(id => agents.has(id))
      if (conversation.type === 'direct' && !members.length) { this.skip('cloudConversations'); continue }
      const { ownerId: _owner, remoteRoomId: _room, socialRoom: _social, person: _person, ...clean } = conversation
      await this.repository.importer.conversation({ ...clean, agentIds: members } as Conversation)
      imported.add(conversation.id); this.expected.session.add(conversation.id); this.count('sessions')
    }
    return imported
  }

  /** File links inside messages point into the old attachment folder; they now point into FeltDB's. */
  private relink(text: string): string {
    const oldPrefix = pathToFileURL(this.attachmentDirectory).href.replace(/^file:/, 'douchat-file:')
    const newPrefix = pathToFileURL(this.repository.blobDirectory).href.replace(/^file:/, 'douchat-file:')
    return text.split(oldPrefix).join(newPrefix)
  }

  private async importMessages(sessions: Set<string>): Promise<void> {
    for (const row of this.rows('SELECT data FROM messages ORDER BY rowid')) {
      const raw = row.data as string
      let message: ChatMessage & { socialTasks?: unknown }
      try { message = JSON.parse(this.relink(raw)) } catch { this.skip('messages'); continue }
      if (!sessions.has(message.conversationId)) { this.skip('messages'); continue }
      delete message.socialTasks
      await this.repository.importer.message(message)
      this.expected.message.add(message.id); this.count('messages')
    }
  }

  private async importPrivateMessages(sessions: Set<string>): Promise<void> {
    for (const row of this.rows('SELECT data FROM privateMessages ORDER BY rowid')) {
      const message = this.json<PrivateMessage>(row)
      if (!message || !sessions.has(message.conversationId)) { this.skip('privateMessages'); continue }
      await this.repository.importer.privateMessage(message); this.count('privateMessages')
    }
  }

  private async importAutomation(agents: Set<string>, sessions: Set<string>): Promise<void> {
    const routines = new Set<string>()
    for (const row of this.rows('SELECT data FROM routines ORDER BY rowid')) {
      const routine = this.json<Routine & { ownerId?: string }>(row)
      if (!routine || !agents.has(routine.agentId) || !sessions.has(routine.conversationId)) { this.skip('routines'); continue }
      const { ownerId: _owner, ...clean } = routine
      await this.repository.importer.routine(clean as Routine); routines.add(routine.id); this.count('routines')
    }
    const runs = new Map<string, string>()
    for (const row of this.rows('SELECT data FROM runs ORDER BY rowid')) {
      const run = this.json<TaskRun & { ownerId?: string }>(row)
      if (!run || !sessions.has(run.conversationId)) { this.skip('runs'); continue }
      const { ownerId: _owner, ...clean } = run
      await this.repository.importer.run(clean as TaskRun); runs.set(run.id, run.conversationId); this.count('runs')
    }
    for (const row of this.rows('SELECT data FROM runEvents ORDER BY rowid')) {
      const event = this.json<RunEvent>(row)
      const session = event && runs.get(event.runId)
      if (!event || !session) { this.skip('runEvents'); continue }
      await this.repository.importer.runEvent(event, session); this.count('runEvents')
    }
  }

  private async importGroupStates(sessions: Set<string>): Promise<void> {
    for (const [table, kind] of [['groupGames', 'game'], ['groupWorkflows', 'workflow']] as const) {
      for (const row of this.rows(`SELECT data FROM ${table} ORDER BY rowid`)) {
        const state = this.json<{ id: string; conversationId: string; topicId: string; revision?: number; ownerId?: string }>(row)
        if (!state || !sessions.has(state.conversationId)) { this.skip(table); continue }
        const { ownerId: _owner, ...document } = state
        await this.repository.importer.groupState({ id: state.id, sessionId: state.conversationId, topicId: state.topicId, kind, ...(state.revision !== undefined ? { revision: state.revision } : {}), document })
        this.count(table)
      }
    }
  }

  private async importAttachments(): Promise<void> {
    if (!existsSync(this.attachmentDirectory)) return
    const files = new Set(readdirSync(this.attachmentDirectory))
    const IMAGE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
    mkdirSync(this.repository.blobDirectory, { recursive: true, mode: 0o700 })
    for (const name of files) {
      if (name.includes('.tmp')) continue
      const image = /^([0-9a-f-]{36})\.(png|jpg|webp|gif)$/i.exec(name)
      const document = /^([0-9a-f-]{36})-(.+)$/i.exec(name)
      const id = image?.[1] ?? document?.[1]
      if (!id) { this.skip('attachments'); continue }
      const target = join(this.repository.blobDirectory, name)
      if (!existsSync(target)) cpSync(join(this.attachmentDirectory, name), target)
      const size = statSync(target).size
      await this.repository.importer.attachment(image
        ? { id, kind: 'image', name, size, mimeType: IMAGE[image[2].toLowerCase()], blob: name, createdAt: statSync(target).mtimeMs | 0 }
        : { id, kind: 'document', name: document![2], size, blob: name, createdAt: statSync(target).mtimeMs | 0 })
      this.expected.attachment.add(id); this.count('attachments')
    }
  }

  private async importSettings(sessions: Set<string>): Promise<void> {
    const name = this.accountMeta('userName')
    if (name) await this.repository.setUserName(name)
    const avatar = this.accountMeta('userAvatar')
    if (avatar) await this.repository.setUserAvatar(avatar)
    const connectors = this.accountMeta('connectors') ?? this.meta.get('connectors:v1')
    if (connectors) {
      try {
        const list = JSON.parse(connectors) as unknown
        if (Array.isArray(list)) { await this.repository.setConnectors(list as never); this.count('connectors', list.length) }
      } catch { this.skip('connectors') }
    }
    const decision = this.accountMeta('groupDecision:v1')
    if (decision) {
      try {
        const settings = JSON.parse(decision) as { mode?: string; providerId?: string }
        // The hosted decision model is gone; a group falls back to its lead unless a provider of the user's own was chosen.
        if (settings.mode !== 'leader' && settings.providerId && settings.providerId !== 'douchat:cloud') await this.repository.importer.setting('groupDecision', settings)
      } catch { this.skip('decisionSettings') }
    }
    for (const id of sessions) {
      const health = this.accountMeta(`groupHealth:${id}`)
      if (!health) continue
      try { await this.repository.importer.setting(`groupHealth:${id}`, JSON.parse(health)) } catch { this.skip('groupHealth') }
    }
    if (this.accountMeta('endpoint')) {
      await this.repository.addAttention({ id: 'legacy-endpoint', kind: 'provider-setup', title: 'Re-add your model endpoint',
        detail: 'An earlier release stored a custom model endpoint. Add it again under Settings → Models so its key is kept in the system credential store.' })
      this.skip('endpoint')
    }
  }

  private async importMemories(agents: Set<string>, sessions: Set<string>): Promise<void> {
    if (!this.primary) return
    const files = new LegacyMemoryFiles(join(this.options.userData, 'accounts'))
    const legacyFiles = new LegacyMemoryFiles(join(this.options.userData, 'memories'))
    const put = async (id: string, scope: 'user' | 'agent' | 'group', document: UserMemoryDocument, agentId?: string, groupId?: string): Promise<void> => {
      await this.repository.importer.memory({ id, scope, ...(agentId ? { agentId } : {}), ...(groupId ? { groupId } : {}), revision: document.revision, updatedAt: document.updatedAt, document: { ...document, userId: LOCAL_USER_ID } })
      this.expected.memory.add(id); this.count('memories')
    }
    const document = (row: Row | undefined, agentId?: string): UserMemoryDocument | undefined => {
      const saved = row ? this.json<UserMemoryDocument>(row) : undefined
      return saved ? { ...emptyUserMemory(this.primary, agentId), ...saved } : undefined
    }
    const read = (agentId?: string): UserMemoryDocument | undefined => {
      try { return files.read(this.primary, agentId) ?? legacyFiles.read(this.primary, agentId) } catch { this.skip('memoryFiles'); return undefined }
    }
    const shared = read() ?? document(this.rows('SELECT data FROM user_profiles WHERE userId = ?', this.primary)[0])
    if (shared) await put('user:shared', 'user', shared)
    for (const id of agents) {
      const own = read(id) ?? document(this.rows('SELECT data FROM agent_user_memories WHERE userId = ? AND agentId = ?', this.primary, id)[0], id)
      if (own) await put(`agent:${id}`, 'agent', own, id)
    }
    for (const id of sessions) {
      const row = this.rows('SELECT data FROM group_memories WHERE userId = ? AND groupId = ?', this.primary, id)[0]
      const saved = row ? this.json<{ audiences?: Record<string, UserMemoryDocument> } & UserMemoryDocument>(row) : undefined
      const merged = saved?.audiences?.internal ?? (saved && !saved.audiences ? saved : undefined)
      if (merged) await put(`group:${id}`, 'group', { ...emptyUserMemory(this.primary), ...merged, groupId: id }, undefined, id)
    }
    // Dated history: files only.
    for (const scope of [undefined, ...agents] as (string | undefined)[]) {
      let days: ReturnType<LegacyMemoryFiles['history']> = []
      try { days = files.history(this.primary, scope) } catch { this.skip('memoryFiles') }
      for (const day of days) {
        const id = `history:${scope ?? 'shared'}:${day.date}`
        await this.repository.importer.memory({ id, scope: 'history', ...(scope ? { agentId: scope } : {}), revision: 0, updatedAt: Date.parse(day.date) || 0, document: day })
        this.count('memoryHistory')
      }
    }
  }

  private codec(): SecretCodec | undefined {
    return this.options.codec && this.options.codec.available() ? this.options.codec : undefined
  }

  /** Secrets move from the account-keyed files of earlier releases into the credential vault. */
  private async importSecrets(): Promise<void> {
    const codec = this.codec()
    if (!this.primary) return
    const models = join(this.options.userData, 'custom-models', `${hash(this.primary)}.json`)
    if (existsSync(models)) {
      if (!codec || !this.options.vault) this.skip('providers')
      else {
        try {
          const stored = JSON.parse(readFileSync(models, 'utf8')) as { defaultModel?: string; providers: { id: string; name: string; kind: 'openai' | 'anthropic'; apiBase: string; models: string[]; modelLabels?: Record<string, string>; reasoningModels?: string[]; secret?: string }[] }
          const records = stored.providers.map(({ secret, id, name, kind, ...config }) => {
            if (secret) this.options.vault!.set(`provider:${id}`, codec.decrypt(secret))
            return { id, name, kind, config, credentialRef: `provider:${id}`, updatedAt: Date.now() }
          })
          await this.repository.replaceProviders(records, stored.defaultModel || undefined)
          this.count('providers', records.length)
        } catch { this.skip('providers') }
      }
    }
    const email = join(this.options.userData, 'email-connectors.json')
    if (existsSync(email)) {
      if (!codec || !this.options.vault) this.skip('emailCredentials')
      else {
        try {
          const secrets = JSON.parse(readFileSync(email, 'utf8')) as Record<string, string>
          for (const connector of await this.repository.connectors()) {
            const encrypted = secrets[`${this.primary}:${connector.id}`] ?? secrets[connector.id]
            if (encrypted) { this.options.vault.set(`email:${connector.id}`, codec.decrypt(encrypted)); this.count('emailCredentials') }
          }
        } catch { this.skip('emailCredentials') }
      }
    }
    const channels = join(this.options.userData, 'im-channels', `${hash(this.primary)}.json`)
    if (existsSync(channels)) {
      if (!codec || !this.options.imStorage) this.skip('imChannels')
      else {
        try {
          const records = (JSON.parse(codec.decrypt(readFileSync(channels, 'utf8'))) as RecordData[])
            .filter(record => this.expected.agent.has(record.agentId))
            .map(record => ({ ...record, owner: LOCAL_USER_ID }))
          await this.options.imStorage.save(records)
          this.count('imChannels', records.length)
        } catch { this.skip('imChannels') }
      }
    }
  }

  /** Native-session bindings and the working folders they own are re-keyed to the desktop. */
  private async importWorkspaceBindings(): Promise<void> {
    if (!this.primary) return
    const root = join(this.options.userData, 'local-workspaces')
    const sessions = join(root, 'sessions')
    if (!existsSync(sessions)) return
    for (const name of readdirSync(sessions)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      try {
        const record = JSON.parse(readFileSync(join(sessions, name), 'utf8')) as { owner: string; agent: string; sessionKey: string; generation: string; fingerprint: string; thread?: string; claudeAccountLogin?: boolean }
        if (record.owner !== this.primary || !this.expected.agent.has(record.agent)) { this.skip('workspaceBindings'); continue }
        const oldId = name.slice(0, -5)
        const id = hash(JSON.stringify([LOCAL_USER_ID, record.agent, record.sessionKey]))
        const folders: [string, string][] = [
          [join(root, 'files', hash(record.owner), hash(record.agent), oldId, record.generation), join(root, 'files', hash(LOCAL_USER_ID), hash(record.agent), id, record.generation)],
          [join(root, 'cursor', oldId, record.generation), join(root, 'cursor', id, record.generation)]
        ]
        for (const [from, to] of folders) if (existsSync(from) && !existsSync(to)) { mkdirSync(join(to, '..'), { recursive: true, mode: 0o700 }); cpSync(from, to, { recursive: true }) }
        await this.repository.importer.binding({ id, agentId: record.agent, sessionKey: record.sessionKey, generation: record.generation, fingerprint: record.fingerprint,
          ...(record.thread ? { thread: record.thread } : {}), ...(record.claudeAccountLogin ? { claudeAccountLogin: true } : {}), updatedAt: statSync(join(sessions, name)).mtimeMs | 0 })
        this.count('workspaceBindings')
      } catch { this.skip('workspaceBindings') }
    }
  }

  /** Read every imported id back out of FeltDB. */
  private async verify(): Promise<boolean> {
    const checks: ['agent' | 'session' | 'message' | 'attachment' | 'memory', Set<string>][] = [
      ['agent', this.expected.agent], ['session', this.expected.session], ['message', this.expected.message],
      ['attachment', this.expected.attachment], ['memory', this.expected.memory]
    ]
    for (const [kind, ids] of checks) for (const id of ids) if (!(await this.repository.hasRecord(kind, id))) return false
    return true
  }
}
