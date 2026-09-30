import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { lstat, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  AgentConfig, AttentionItem, ChatMessage, CiEvent, CiRun, DevelopmentEnvironmentRef, CodingEvent, CodingSession, Conversation, CreateGroupInput, CreateRoutineInput, EmailConnectorAccount, MessageAttachment,
  MessageDeliveryReply, PrivateMessage, ResolvedCreateAgentInput, Routine, RunEvent, RunStatus, TaskRun, Topic,
  Project, UpdateAgentInput, UpdateConversationInput
} from '../shared/types'
import { normalizeAgentEmoji } from '../shared/avatar'
import { thinkingLevel } from '../shared/thinkingLevels'
import { GameRuleError } from '../shared/gameText'
import { agentPermissions } from '../shared/agentPermissions'
import { validateAgentFiles, validateAgentSkills } from '../shared/agentCustomization'
import { DEFAULT_DECISION_SETTINGS, validateDecisionSettings, type DecisionSettings } from '../shared/groupDecision'
import type { StoredJevEvaluation } from '../shared/jev'
import type { GameState } from '../shared/groupGame'
import type { GroupWorkflow } from '../shared/groupWorkflow'
import { mediaName, MAX_IM_FILE_BYTES, IMMediaError } from './imMedia'
import { DESKTOP_SCHEMA_VERSION, FeltDatabase, FeltDatabaseError, type Batch, type RecordChange, type Records } from './felt/database'
import {
  agentFromRecord, agentToRecord, ciRunFromRecord, ciRunToRecord, developmentEnvironmentFromRecord, developmentEnvironmentToRecord, codingSessionFromRecord, codingSessionToRecord, projectFromRecord, conversationFromParts, conversationParts, eventFromRecord, eventToRecord, messageFromRecord,
  messageToRecord, privateMessageFromRecord, privateMessageToRecord, routineFromRecord, routineToRecord, runFromRecord, runToRecord,
  type AgentProcessRow, type AgentProfileRecord, type AgentRecord, type AttachmentRecord, type CiRunRecord, type CodingSessionRecord, type DecisionRecord, type DevelopmentEnvironmentRecord, type EvaluationRecord, type EvidenceRecord, type ExecutionEventRecord, type LocalAgentDefinitionRecord, type GroupMemberRecord, type GroupRecord,
  type MessageRecord, type PrivateMessageRecord, type RunRecord, type ScheduleRecord, type SessionRecord, type TopicRecord, type WorkspaceRecord
} from './felt/records'
import { MemoryRepository, type MemoryRecord } from './memoryRepository'

export { DESKTOP_SCHEMA_VERSION }

/** A folder's id: the same path is always the same workspace (and project). */
export const workspaceId = (path: string): string => `workspace-${createHash('sha256').update(path).digest('hex').slice(0, 32)}`
export type { RecordChange }

const DEFAULT_TOPIC_ID = 'main'

/** Roughly 1.5 MB of base64 — far above a 256px avatar, far below bloat. */
const AVATAR_LIMIT = 1_500_000
const PRIVATE_MESSAGE_LIMIT = 400
const MAX_CODING_EVENTS = 100
const MAX_CI_EVENTS = 100
const RUN_LIMIT = 120
const RUN_EVENT_LIMIT = 2_000
/** Trim in bursts, so a stream of events does not read the whole log each time. */
const TRIM_SLACK = 100
const RECENT_MESSAGES = 51
const ATTACHMENT_ID = /^[0-9a-f-]{36}$/i
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const IMAGE_EXTENSION: Record<MessageAttachment['mimeType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

function validAvatar(dataUrl: string): boolean {
  return !dataUrl || (/^data:image\/(png|jpeg|webp);base64,/.test(dataUrl) && dataUrl.length <= AVATAR_LIMIT)
}

export interface DesktopRepositoryOptions {
  /** Orchestration fixtures that need a small crew to already exist. */
  seedDemo?: boolean
}

interface DesktopRecord {
  id: string
  schemaVersion: number
  createdAt: number
  userName?: string
  userAvatar?: string
  migration?: Record<string, unknown>
}

interface SettingRecord { id: string; value: unknown; updatedAt: number }

/** Non-secret provider configuration. The secret itself is in the credential vault, named by `credentialRef`. */
export interface ProviderRecord {
  id: string
  kind: 'openai' | 'anthropic' | 'ollama'
  name: string
  config: Omit<import('../shared/customModels').CustomProviderInput, 'id' | 'name' | 'kind' | 'apiKey'>
  credentialRef?: string
  updatedAt: number
}
/** How a local agent's native session is bound to a chat: which working-folder generation it uses, and which CLI thread it may resume. */
export interface RuntimeBindingRecord {
  id: string; agentId: string; sessionKey: string; generation: string; fingerprint: string
  thread?: string; claudeAccountLogin?: boolean; updatedAt: number
}
export interface ToolExecutionRecord {
  id: string; runId?: string; sessionId: string; messageId?: string; tool: string
  status: 'running' | 'succeeded' | 'failed'; target?: string; startedAt: number; finishedAt?: number
}
interface GroupStateRecord { id: string; sessionId: string; topicId: string; kind: 'game' | 'workflow'; revision?: number; document: unknown }

function newTopic(title = '', at = Date.now()): Topic {
  return { id: randomUUID(), title, createdAt: at, updatedAt: at }
}

const defaultAgents = (): AgentConfig[] => {
  const now = Date.now()
  return [
    {
      id: 'dobi',
      name: 'Dobi',
      role: 'Product lead',
      instructions:
        'Turn ambiguous requests into a crisp plan. Be direct, practical, and concise. Delegate implementation detail to the right teammate instead of writing it yourself.',
      labels: 'planning, product, coordination',
      color: '#14B8A6',
      provider: 'openai',
      model: 'gpt-5.6-terra',
      createdAt: now
    },
    {
      id: 'lin',
      name: 'Lin',
      role: 'Maker',
      instructions:
        'You are a pragmatic builder. Convert plans into concrete deliverables, call out tradeoffs, and answer with the next useful action. Keep responses compact.',
      labels: 'building, engineering, delivery',
      color: '#FF5DA8',
      provider: 'openai',
      model: 'gpt-5.6-terra',
      createdAt: now + 1
    }
  ]
}

/**
 * The domain boundary between the desktop and its durable state.
 *
 * Everything the app remembers — agents, sessions, messages, memories,
 * schedules, execution history — is a FeltDB record (`desktop.flow`). The
 * rest of the application talks to this class, never to database files, and
 * every method is asynchronous because FeltDB is.
 *
 * Writes that belong together commit as one FeltDB transaction. Operations
 * that read and then write are serialized, so two of them cannot interleave.
 */
export class DesktopRepository {
  readonly memories: MemoryRepository
  /** Kept as the names the runtime already uses for its two memory scopes. */
  readonly userMemories: MemoryRepository['user']
  readonly groupMemories: MemoryRepository['group']

  private readonly desktop: Records<DesktopRecord>
  private readonly settings: Records<SettingRecord>
  private readonly agentRows: Records<AgentRecord>
  private readonly profiles: Records<AgentProfileRecord>
  private readonly workspaces: Records<WorkspaceRecord>
  private readonly codingRows: Records<CodingSessionRecord>
  private readonly ciRows: Records<CiRunRecord>
  private readonly environmentRows: Records<DevelopmentEnvironmentRecord>
  private readonly evidenceRows: Records<EvidenceRecord>
  private readonly evaluationRows: Records<EvaluationRecord>
  private readonly decisionRows: Records<DecisionRecord>
  private readonly localAgentRows: Records<LocalAgentDefinitionRecord>
  private readonly processRows: Records<AgentProcessRow>
  /** Coding sessions found still `running` when this desktop opened: their process died with the last run. */
  recoveredCodingSessions: CodingSession[] = []
  private readonly sessions: Records<SessionRecord>
  private readonly topics: Records<TopicRecord>
  private readonly groups: Records<GroupRecord>
  private readonly members: Records<GroupMemberRecord>
  private readonly messageRows: Records<MessageRecord>
  private readonly privateRows: Records<PrivateMessageRecord>
  private readonly runRows: Records<RunRecord>
  private readonly eventRows: Records<ExecutionEventRecord>
  private readonly scheduleRows: Records<ScheduleRecord>
  private readonly attachments: Records<AttachmentRecord>
  private readonly groupStates: Records<GroupStateRecord>
  private readonly memoryRows: Records<MemoryRecord>
  private readonly providerRows: Records<ProviderRecord>
  private readonly attentionRows: Records<AttentionItem>
  private readonly toolRows: Records<ToolExecutionRecord>
  private readonly bindingRows: Records<RuntimeBindingRecord>
  readonly blobDirectory: string
  private readonly skillDirectory: string

  private readonly lockContext = new AsyncLocalStorage<true>()
  private tail: Promise<unknown> = Promise.resolve()
  private closing = false

  private constructor(readonly felt: FeltDatabase) {
    this.blobDirectory = join(felt.directory, 'blobs')
    this.skillDirectory = join(felt.directory, 'skills')
    mkdirSync(this.blobDirectory, { recursive: true, mode: 0o700 })
    this.desktop = felt.collection('Desktop')
    this.settings = felt.collection('Setting')
    this.agentRows = felt.collection('Agent')
    this.profiles = felt.collection('AgentProfile')
    this.workspaces = felt.collection('Workspace')
    this.codingRows = felt.collection('CodingSession')
    this.ciRows = felt.collection('CiRun')
    this.environmentRows = felt.collection('DevelopmentEnvironment')
    this.evidenceRows = felt.collection('Evidence')
    this.evaluationRows = felt.collection('Evaluation')
    this.decisionRows = felt.collection('Decision')
    this.localAgentRows = felt.collection('LocalAgentDefinition')
    this.processRows = felt.collection('AgentProcess')
    this.sessions = felt.collection('Session')
    this.topics = felt.collection('Topic')
    this.groups = felt.collection('Group')
    this.members = felt.collection('GroupMember')
    this.messageRows = felt.collection('Message')
    this.privateRows = felt.collection('PrivateMessage')
    this.runRows = felt.collection('Run')
    this.eventRows = felt.collection('ExecutionEvent')
    this.scheduleRows = felt.collection('Schedule')
    this.attachments = felt.collection('Attachment')
    this.groupStates = felt.collection('GroupState')
    this.memoryRows = felt.collection('Memory')
    this.providerRows = felt.collection('Provider')
    this.attentionRows = felt.collection('AttentionItem')
    this.toolRows = felt.collection('ToolExecution')
    this.bindingRows = felt.collection('RuntimeBinding')
    this.memories = new MemoryRepository(felt, this.memoryRows, async id => (await this.agentRows.has(id)), async id => (await this.sessions.get(id))?.kind === 'group',
      work => this.exclusive(work))
    this.userMemories = this.memories.user
    this.groupMemories = this.memories.group
  }

  /**
   * Open (or create) the desktop state under `<root>/felt`. Fails closed: if
   * FeltDB cannot start, or holds data from a newer desktop, nothing is opened.
   */
  static async open(root: string, options: DesktopRepositoryOptions = {}): Promise<DesktopRepository> {
    const felt = await FeltDatabase.open(join(root, 'felt'))
    try {
      const repository = new DesktopRepository(felt)
      await repository.initialize(Boolean(options.seedDemo))
      return repository
    } catch (error) {
      await felt.close()
      throw error
    }
  }

  /** Finish every write in flight, then close FeltDB. Nothing is accepted after this begins. */
  async close(): Promise<void> {
    this.closing = true
    await this.tail.catch(() => undefined)
    await this.felt.close()
  }

  /**
   * Announce changes as FeltDB makes them: one call per record written or
   * removed, whichever writer made the change.
   */
  subscribe(listener: (change: RecordChange) => void, collections?: string[]): () => void {
    return this.felt.subscribe(listener, collections)
  }

  /**
   * Operations that read then write must not interleave with one another.
   * Re-entrant: an operation that calls another one already holds the lock.
   */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new FeltDatabaseError('The desktop is shutting down; the change was not accepted'))
    if (this.lockContext.getStore()) return work()
    const run = this.tail.then(() => this.lockContext.run(true, work), () => this.lockContext.run(true, work))
    this.tail = run.catch(() => undefined)
    return run
  }

  private async initialize(seedDemo: boolean): Promise<void> {
    const existing = await this.desktop.get('local')
    // Never open, and so never rewrite, state written by a newer desktop.
    if (existing && existing.schemaVersion > DESKTOP_SCHEMA_VERSION) throw new FeltDatabaseError(`This desktop data was written by a newer version of the app (schema ${existing.schemaVersion}).`)
    if (!existing) await this.desktop.put({ id: 'local', schemaVersion: DESKTOP_SCHEMA_VERSION, createdAt: Date.now() })
    if (seedDemo && !(await this.setting('demoSeeded'))) await this.seedDemo()
    await this.recoverInterruptedRuns()
    this.recoveredCodingSessions = await this.recoverInterruptedCodingSessions()
  }

  // ───────────────────────────── settings ─────────────────────────────

  async setting<T>(key: string): Promise<T | undefined> {
    return (await this.settings.get(key))?.value as T | undefined
  }

  setSetting(key: string, value: unknown): Promise<void> {
    return this.exclusive(async () => {
      if (value === undefined) await this.settings.delete(key)
      else await this.settings.put({ id: key, value, updatedAt: Date.now() })
    })
  }

  async decisionSettings(): Promise<DecisionSettings> {
    const saved = await this.setting<unknown>('groupDecision')
    return saved ? validateDecisionSettings(saved as DecisionSettings) : { ...DEFAULT_DECISION_SETTINGS }
  }

  async saveDecisionSettings(settings: DecisionSettings): Promise<DecisionSettings> {
    const valid = validateDecisionSettings(settings)
    await this.setSetting('groupDecision', valid)
    return valid
  }

  /** Persist one structured evaluation atomically; Jev owns no store or cache of its own. */
  saveJevEvaluation(evaluation: StoredJevEvaluation): Promise<void> {
    return this.exclusive(() => this.felt.transaction(async batch => {
      const { question, result, context } = structuredClone(evaluation)
      const createdAt = Date.parse(result.provenance.timestamp)
      await batch.put(this.evaluationRows, {
        id: result.evaluationId, questionId: question.id, question, result, context,
        ...(context.projectId ? { projectId: context.projectId } : {}),
        ...(context.invariantId ? { invariantId: context.invariantId } : {}), createdAt
      })
      await batch.put(this.decisionRows, { id: result.evaluationId, evaluationId: result.evaluationId,
        questionId: question.id, value: result.decision.value, status: result.decision.status, createdAt })
      for (const supplied of question.inputs) await batch.put(this.evidenceRows, {
        id: `${result.evaluationId}.${supplied.id}`, evaluationId: result.evaluationId, questionId: question.id,
        inputId: supplied.id, name: supplied.name, value: supplied.value,
        relevance: result.evidence.find(item => item.inputId === supplied.id)?.relevance ?? [], createdAt
      })
    }))
  }

  async jevEvaluation(evaluationId: string): Promise<StoredJevEvaluation | undefined> {
    const record = await this.evaluationRows.get(evaluationId)
    return record ? { question: record.question, result: record.result, context: record.context } : undefined
  }

  async jevEvaluations(projectId?: string): Promise<StoredJevEvaluation[]> {
    const records = projectId ? await this.evaluationRows.where({ projectId }) : await this.evaluationRows.all()
    return records.sort((left, right) => right.createdAt - left.createdAt)
      .map(record => ({ question: record.question, result: record.result, context: record.context }))
  }

  async groupHealth(conversationId: string): Promise<import('./groupHealth').GroupHealth> {
    return (await this.setting<import('./groupHealth').GroupHealth>(`groupHealth:${conversationId}`)) ?? {}
  }

  saveGroupHealth(conversationId: string, health: import('./groupHealth').GroupHealth): Promise<void> {
    return this.setSetting(`groupHealth:${conversationId}`, health)
  }

  // ───────────────────────────── providers ─────────────────────────────

  providers(): Promise<ProviderRecord[]> {
    return this.providerRows.all()
  }

  /** Make the stored providers exactly `records`, and optionally record the default model in the same commit. */
  replaceProviders(records: ProviderRecord[], defaultModel?: string): Promise<void> {
    return this.exclusive(() => this.felt.transaction(async batch => {
      const keep = new Set(records.map(record => record.id))
      for (const stale of await this.providerRows.all()) if (!keep.has(stale.id)) await batch.delete(this.providerRows, stale.id)
      for (const record of records) await batch.put(this.providerRows, record)
      if (defaultModel !== undefined) await batch.put(this.settings, { id: 'defaultModel', value: defaultModel, updatedAt: Date.now() })
    }))
  }

  // ───────────────────────────── profile ─────────────────────────────

  async userName(): Promise<string> {
    return (await this.desktop.get('local'))?.userName || 'You'
  }

  async userAvatar(): Promise<string> {
    return (await this.desktop.get('local'))?.userAvatar ?? ''
  }

  setUserName(name: string): Promise<void> {
    return this.exclusive(async () => { await this.desktop.put({ ...(await this.desktop.get('local'))!, userName: name.trim() || 'You' }) })
  }

  /**
   * The renderer downscales before sending; the checks here are the backstop.
   * A remote URL is refused outright — the state must never make the app fetch
   * an image at render time — and the cap keeps the row small.
   */
  setUserAvatar(dataUrl: string): Promise<void> {
    const value = dataUrl.trim()
    if (!validAvatar(value)) return Promise.resolve()
    return this.exclusive(async () => { await this.desktop.put({ ...(await this.desktop.get('local'))!, userAvatar: value }) })
  }

  async migration(): Promise<Record<string, unknown> | undefined> {
    return (await this.desktop.get('local'))?.migration
  }

  setMigration(migration: Record<string, unknown>): Promise<void> {
    return this.exclusive(async () => { await this.desktop.put({ ...(await this.desktop.get('local'))!, migration }) })
  }

  async connectors(): Promise<EmailConnectorAccount[]> {
    const value = await this.setting<unknown>('connectors')
    return Array.isArray(value)
      ? value.filter((item): item is EmailConnectorAccount => Boolean(item && typeof item === 'object' && (item as EmailConnectorAccount).kind === 'email'))
      : []
  }

  setConnectors(connectors: EmailConnectorAccount[]): Promise<void> {
    return this.setSetting('connectors', connectors)
  }

  // ───────────────────────────── reads ─────────────────────────────

  async agents(): Promise<AgentConfig[]> {
    const [rows, profiles] = await Promise.all([this.agentRows.all(), this.profiles.all()])
    const byAgent = new Map(profiles.map(profile => [profile.id, profile]))
    return rows.map(record => agentFromRecord(record, byAgent.get(record.id)))
  }

  async conversations(): Promise<Conversation[]> {
    const [sessions, topics, groups, members, workspaces] = await Promise.all([
      this.sessions.all(), this.topics.all(), this.groups.all(), this.members.all(), this.workspaces.all()
    ])
    const topicsOf = new Map<string, TopicRecord[]>(), membersOf = new Map<string, GroupMemberRecord[]>()
    for (const topic of topics) (topicsOf.get(topic.sessionId) ?? topicsOf.set(topic.sessionId, []).get(topic.sessionId)!).push(topic)
    for (const member of members) (membersOf.get(member.groupId) ?? membersOf.set(member.groupId, []).get(member.groupId)!).push(member)
    const groupOf = new Map(groups.map(group => [group.id, group])), workspaceOf = new Map(workspaces.map(workspace => [workspace.id, workspace]))
    return sessions.map(session => conversationFromParts({
      session, group: session.kind === 'group' ? groupOf.get(session.id) : undefined,
      members: session.kind === 'group' ? membersOf.get(session.id) ?? [] : [],
      topics: topicsOf.get(session.id) ?? [], workspacePath: session.workspaceId ? workspaceOf.get(session.workspaceId)?.path : undefined
    }))
  }

  async messages(): Promise<ChatMessage[]> {
    return (await this.messageRows.all()).map(messageFromRecord)
  }

  async privateMessages(): Promise<PrivateMessage[]> {
    return (await this.privateRows.all()).map(privateMessageFromRecord)
  }

  async routines(): Promise<Routine[]> {
    return (await this.scheduleRows.all()).map(routineFromRecord)
  }

  async runs(): Promise<TaskRun[]> {
    return (await this.runRows.all()).map(runFromRecord)
  }

  async runEvents(): Promise<RunEvent[]> {
    return (await this.eventRows.all()).map(eventFromRecord)
  }

  async agent(agentId: string): Promise<AgentConfig | undefined> {
    const record = await this.agentRows.get(agentId)
    return record ? agentFromRecord(record, await this.profiles.get(agentId)) : undefined
  }

  async conversation(conversationId: string): Promise<Conversation | undefined> {
    const session = await this.sessions.get(conversationId)
    return session ? this.compose(session) : undefined
  }

  private async compose(session: SessionRecord): Promise<Conversation> {
    const [workspace, group, members, topics] = await Promise.all([
      session.workspaceId ? this.workspaces.get(session.workspaceId) : undefined,
      session.kind === 'group' ? this.groups.get(session.id) : undefined,
      session.kind === 'group' ? this.members.where({ groupId: session.id }) : [],
      this.topics.where({ sessionId: session.id })
    ])
    return conversationFromParts({ session, group, members, topics, workspacePath: workspace?.path })
  }

  // ───────────────────────────── staging helpers ─────────────────────────────
  // These add writes to a batch; the caller commits them together.

  private async stageWorkspace(batch: Batch, path: string | undefined): Promise<string | undefined> {
    if (!path) return undefined
    const existing = (await this.workspaces.where({ path }))[0]
    if (existing) return existing.id
    const record: WorkspaceRecord = { id: workspaceId(path), path, createdAt: Date.now() }
    await batch.put(this.workspaces, record)
    return record.id
  }

  private async stageAgent(batch: Batch, agent: AgentConfig, bump = true): Promise<void> {
    if (bump) agent.revision = ((await batch.get(this.agentRows, agent.id))?.revision ?? 0) + 1
    const { agent: record, profile } = agentToRecord(agent)
    // Dependencies first: a profile never outlives the agent it belongs to.
    await batch.put(this.agentRows, record)
    if (profile) await batch.put(this.profiles, { ...profile, updatedAt: (await batch.get(this.profiles, agent.id))?.updatedAt ?? profile.updatedAt })
    else await batch.delete(this.profiles, agent.id)
  }

  private async stageConversation(batch: Batch, conversation: Conversation, bump = true): Promise<void> {
    if (bump) conversation.revision = ((await batch.get(this.sessions, conversation.id))?.revision ?? 0) + 1
    const workspaceId = await this.stageWorkspace(batch, conversation.workspacePath)
    const binding = conversation.type === 'direct' && conversation.agentIds[0] ? await batch.get(this.agentRows, conversation.agentIds[0]) : undefined
    const parts = conversationParts(conversation, workspaceId, binding ? { provider: binding.provider, model: binding.model } : undefined)
    const memberIds = new Set(parts.members.map(member => member.id))
    for (const stale of await this.members.where({ groupId: conversation.id })) if (!memberIds.has(stale.id)) await batch.delete(this.members, stale.id)
    for (const member of parts.members) await batch.put(this.members, member)
    if (parts.group) await batch.put(this.groups, parts.group)
    const topicIds = new Set(parts.topics.map(topic => topic.id))
    for (const stale of await this.topics.where({ sessionId: conversation.id })) if (!topicIds.has(stale.id)) await batch.delete(this.topics, stale.id)
    for (const topic of parts.topics) await batch.put(this.topics, topic)
    await batch.put(this.sessions, parts.session)
  }

  private async stageMessage(batch: Batch, message: ChatMessage, conversation?: Conversation): Promise<void> {
    const reset = conversation
      ? conversation.topics.find(topic => topic.id === message.topicId)?.contextReset
      : await this.contextResetOf(batch, message.conversationId, message.topicId)
    if (reset && message.createdAt >= reset.at) message.contextVersion = reset.id
    await batch.put(this.messageRows, messageToRecord(message))
  }

  private async contextResetOf(batch: Batch, conversationId: string, topicId: string): Promise<{ id: string; at: number } | undefined> {
    const topic = await batch.get(this.topics, `${conversationId}/${topicId}`)
    return topic?.contextResetId !== undefined ? { id: topic.contextResetId, at: topic.contextResetAt ?? 0 } : undefined
  }

  private async stageRemoveSession(batch: Batch, conversationId: string): Promise<void> {
    await batch.delete(this.sessions, conversationId)
    await batch.deleteWhere(this.messageRows, { sessionId: conversationId })
    await batch.deleteWhere(this.privateRows, { sessionId: conversationId })
    await batch.deleteWhere(this.groupStates, { sessionId: conversationId })
    await batch.deleteWhere(this.scheduleRows, { sessionId: conversationId })
    await batch.deleteWhere(this.toolRows, { sessionId: conversationId })
    await batch.deleteWhere(this.topics, { sessionId: conversationId })
    await batch.delete(this.groups, conversationId)
    await batch.deleteWhere(this.members, { groupId: conversationId })
    await batch.delete(this.settings, `groupHealth:${conversationId}`)
    await this.memories.stageRemoveGroup(batch, conversationId)
  }

  private async stageTopicContentRemoval(batch: Batch, conversationId: string, topicId: string): Promise<void> {
    await batch.deleteWhere(this.messageRows, { sessionId: conversationId, topicId })
    await batch.deleteWhere(this.privateRows, { sessionId: conversationId, topicId })
    await batch.deleteWhere(this.groupStates, { sessionId: conversationId, topicId })
  }

  // ───────────────────────────── group games & workflows ─────────────────────────────

  async groupGames(): Promise<GameState[]> {
    return (await this.groupStates.where({ kind: 'game' })).map(state => state.document as GameState)
  }

  async groupWorkflows(): Promise<GroupWorkflow[]> {
    return (await this.groupStates.where({ kind: 'workflow' })).map(state => state.document as GroupWorkflow)
  }

  saveGroupWorkflow(workflow: GroupWorkflow): Promise<void> {
    return this.exclusive(async () => {
      if (!(await this.sessions.has(workflow.conversationId))) throw new Error('This group task does not belong to an existing chat.')
      if (!(await this.topicMessages(workflow.conversationId, workflow.topicId)).some(message => message.id === workflow.user.id)) throw new Error('The original group task message was deleted.')
      // A cleared or reset topic must not be resurrected by a late journal write.
      if (!(await this.contextMessages(workflow.conversationId, workflow.topicId)).some(message => message.id === workflow.user.id)) return
      workflow.updatedAt = Date.now()
      await this.groupStates.put({ id: workflow.id, sessionId: workflow.conversationId, topicId: workflow.topicId, kind: 'workflow', document: workflow })
    })
  }

  async groupGame(id: string): Promise<GameState | undefined> {
    const state = await this.groupStates.get(id)
    return state?.kind === 'game' ? state.document as GameState : undefined
  }

  /** State and visible messages commit together. Stale slots cannot publish twice. */
  commitGame(game: GameState, expectedRevision?: number): Promise<void> {
    return this.exclusive(async () => {
      const conversation = await this.conversation(game.conversationId)
      if (!conversation) throw new GameRuleError('The game does not belong to an existing chat.', game.language ?? 'zh-CN')
      const previous = await this.groupGame(game.id)
      if (!['paused', 'cancelled'].includes(game.status) && game.players.some(player => !player.human && !conversation.agentIds.includes(player.id))) throw new GameRuleError('A player left the group. End this game and select players again.', game.language ?? 'zh-CN')
      if (previous ? previous.revision !== expectedRevision || game.revision !== previous.revision + 1 : expectedRevision !== undefined) throw new GameRuleError('Game state has changed.', game.language ?? 'zh-CN')
      if (previous && (previous.conversationId !== game.conversationId || previous.topicId !== game.topicId)) throw new GameRuleError('Game identity cannot be changed.', game.language ?? 'zh-CN')
      await this.felt.transaction(async batch => {
        await batch.put(this.groupStates, { id: game.id, sessionId: game.conversationId, topicId: game.topicId, kind: 'game', revision: game.revision, document: game })
        const now = Date.now()
        for (const event of game.events.slice(previous?.events.length ?? 0).filter(event => event.audience === 'group')) {
          await this.stageMessage(batch, { id: event.id, conversationId: game.conversationId, topicId: game.topicId,
            authorId: event.authorId === 'human' ? 'user' : event.authorId, authorName: event.authorName,
            text: event.text, kind: event.authorId === 'system' ? 'system' : 'message', createdAt: now }, conversation)
        }
        conversation.updatedAt = now
        await this.stageConversation(batch, conversation)
      })
    })
  }

  // ───────────────────────────── attachments ─────────────────────────────

  /** Received documents remain local files, exposed by the same file chips as tool results. */
  async saveIMFile(input: { name: string; data: Uint8Array }): Promise<string> {
    if (!input.data.byteLength || input.data.byteLength > MAX_IM_FILE_BYTES) throw new IMMediaError('文件须为 1 字节至 20 MB，请调整后重发。')
    const name = mediaName(input.name)
    const id = randomUUID()
    const blob = `${id}-${name}`
    const path = join(this.blobDirectory, blob)
    await writeFile(path, input.data, { flag: 'wx', mode: 0o600 })
    try { await this.attachments.put({ id, kind: 'document', name, size: input.data.byteLength, blob, createdAt: Date.now() }) }
    catch (error) { await unlink(path).catch(() => undefined); throw error }
    const label = name.replace(/[\\[\]`]/g, character => '\\' + character)
    return `[${label}](<${pathToFileURL(path).href.replace(/^file:/, 'douchat-file:')}>)`
  }

  /** Only documents the desktop itself stored bypass normal user-folder roots. */
  async ownedDocumentPath(input: string): Promise<string | undefined> {
    const path = resolve(input)
    if (dirname(path) !== resolve(this.blobDirectory)) return undefined
    const id = basename(path).slice(0, 36)
    const record = await this.attachments.get(id)
    if (record?.kind !== 'document' || basename(path)[36] !== '-' || record.blob !== basename(path)) throw new Error('Document not found')
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink() || dirname(await realpath(path)) !== await realpath(this.blobDirectory)) throw new Error('Document not found')
    return path
  }

  async saveImageAttachment(input: {
    quoted?: boolean
    name: string
    mimeType: MessageAttachment['mimeType']
    data: Uint8Array
  }): Promise<MessageAttachment> {
    if (!IMAGE_EXTENSION[input.mimeType]) throw new Error('Unsupported image format')
    if (!input.data.byteLength || input.data.byteLength > MAX_IMAGE_BYTES) throw new Error('Each image must be 8 MB or smaller.')
    const id = randomUUID()
    const blob = `${id}.${IMAGE_EXTENSION[input.mimeType]}`
    const path = join(this.blobDirectory, blob)
    await writeFile(path, input.data, { flag: 'wx', mode: 0o600 })
    try {
      await this.attachments.put({ id, kind: 'image', name: input.name, size: input.data.byteLength, mimeType: input.mimeType, blob, createdAt: Date.now() })
    } catch (cause) {
      await unlink(path).catch(() => undefined)
      throw cause
    }
    return { id, kind: 'image', name: input.name, mimeType: input.mimeType, size: input.data.byteLength, ...(typeof input.quoted === 'boolean' ? { quoted: input.quoted } : {}) }
  }

  async attachmentDataUrl(id: string): Promise<string> {
    if (!ATTACHMENT_ID.test(id)) throw new Error('Invalid attachment id')
    const record = await this.attachments.get(id)
    if (record?.kind !== 'image' || !record.mimeType) throw new Error('Attachment not found')
    try {
      const data = await readFile(join(this.blobDirectory, record.blob))
      return `data:${record.mimeType};base64,${data.toString('base64')}`
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Attachment not found')
      throw cause
    }
  }

  // ───────────────────────────── agents ─────────────────────────────

  createAgent(input: ResolvedCreateAgentInput): Promise<AgentConfig> {
    const id = `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bot'}-${randomUUID()}`
    const now = Date.now()
    const { systemFilesDirectory: _ignoredSystemFilesDirectory, ...safeInput } = input as ResolvedCreateAgentInput & { systemFilesDirectory?: string }
    const avatar = validAvatar(input.avatar?.trim() ?? '') ? input.avatar?.trim() : ''
    const thinking = thinkingLevel(safeInput.thinkingLevel)
    delete safeInput.thinkingLevel
    const agent: AgentConfig = {
      ...safeInput,
      ...(safeInput.systemFiles ? { systemFiles: validateAgentFiles(safeInput.systemFiles) } : {}),
      ...(thinking ? { thinkingLevel: thinking } : {}),
      avatar,
      avatarEmoji: avatar ? '' : normalizeAgentEmoji(input.avatarEmoji),
      avatarSeed: !input.localAgentId && input.provider !== 'local' ? randomUUID() : undefined,
      id,
      createdAt: now
    }
    const topic = newTopic('', now)
    return this.exclusive(async () => {
      await this.felt.transaction(async batch => {
        await this.stageAgent(batch, agent)
        await this.stageConversation(batch, {
          id: `direct-${id}`,
          type: 'direct',
          name: agent.name,
          agentIds: [agent.id],
          topics: [topic],
          activeTopicId: topic.id,
          unread: 0,
          readAt: now,
          createdAt: now,
          updatedAt: now
        })
      })
      return (await this.agent(id))!
    })
  }

  updateAgent(agentId: string, input: UpdateAgentInput): Promise<AgentConfig | undefined> {
    return this.exclusive(async () => {
      const agent = await this.agent(agentId)
      if (!agent) return undefined
      if (input.expectedRevision !== undefined && input.expectedRevision !== agent.revision) throw new Error('Agent changed. Reload before saving.')
      const {
        expectedSystemFiles,
        expectedRevision: _expectedRevision,
        revision: _ignoredRevision,
        systemFilesDirectory: _ignoredSystemFilesDirectory,
        ...next
      } = input as UpdateAgentInput & Partial<AgentConfig> & { systemFilesDirectory?: string }
      if (expectedSystemFiles && next.systemFiles) {
        for (const name of Object.keys(next.systemFiles) as (keyof typeof next.systemFiles)[]) {
          if ((agent.systemFiles?.[name] ?? '') !== (expectedSystemFiles[name] ?? '')) throw new Error(`${name} changed. Reload before saving.`)
        }
      }
      if (next.permissions !== undefined) next.permissions = agentPermissions(next.permissions)
      const thinkingChanged = 'thinkingLevel' in next
      if (thinkingChanged) next.thinkingLevel = thinkingLevel(next.thinkingLevel)
      if (next.systemFiles !== undefined) next.systemFiles = { ...agent.systemFiles, ...validateAgentFiles(next.systemFiles) }
      const created: string[] = []
      if (next.skills !== undefined) {
        next.skills = validateAgentSkills(next.skills)
        // Fresh directories prevent stale resources and never follow existing file symlinks.
        // Retain prior directories for replies already using the previous skill version.
        try {
          for (const skill of next.skills) {
            if (!skill.files) continue
            const previous = agent.skills?.find(item => item.id === skill.id)
            if (previous?.directory && previous.content === skill.content && JSON.stringify(previous.files) === JSON.stringify(skill.files)) {
              skill.directory = previous.directory
              continue
            }
            mkdirSync(this.skillDirectory, { recursive: true })
            const directory = mkdtempSync(join(this.skillDirectory, 'skill-'))
            created.push(directory)
            writeFileSync(join(directory, 'SKILL.md'), skill.content)
            for (const file of skill.files) {
              const target = join(directory, file.path)
              mkdirSync(dirname(target), { recursive: true })
              writeFileSync(target, Buffer.from(file.data, 'base64'), { flag: 'wx', mode: 0o700 })
            }
            skill.directory = directory
          }
        } catch (error) {
          for (const directory of created) rmSync(directory, { recursive: true, force: true })
          throw error
        }
      }
      if (next.avatar !== undefined) {
        next.avatar = next.avatar.trim()
        if (!validAvatar(next.avatar)) delete next.avatar
      }
      if (next.avatarEmoji !== undefined) {
        const original = next.avatarEmoji.trim()
        next.avatarEmoji = normalizeAgentEmoji(next.avatarEmoji)
        if (original && !next.avatarEmoji) delete next.avatarEmoji
      }
      if (next.avatar) next.avatarEmoji = ''
      if (next.avatarEmoji) next.avatar = ''
      Object.assign(agent, next)
      try {
        await this.felt.transaction(async batch => {
          await this.stageAgent(batch, agent)
          for (const conversation of await this.conversations()) {
            if (conversation.type === 'direct' && conversation.agentIds[0] === agentId) {
              conversation.name = agent.name
              await this.stageConversation(batch, conversation)
            } else if (conversation.type === 'group' && !conversation.description) {
              conversation.name = await this.groupName(conversation, agent)
              await this.stageConversation(batch, conversation)
            }
          }
        })
      } catch (error) {
        for (const directory of created) rmSync(directory, { recursive: true, force: true })
        throw error
      }
      return (await this.agent(agentId))!
    })
  }

  /** `updated` is an agent whose new name is not stored yet. */
  private async groupName(conversation: Conversation, updated?: AgentConfig): Promise<string> {
    if (!conversation.autoNamed) return conversation.name
    const names = await Promise.all(conversation.agentIds.map(async agentId => updated?.id === agentId ? updated.name : (await this.agent(agentId))?.name))
    return names.filter(Boolean).join(', ') || conversation.name
  }

  deleteAgent(agentId: string): Promise<void> {
    return this.exclusive(async () => {
      if (!(await this.agentRows.has(agentId))) return
      await this.felt.transaction(async batch => {
        // Its own direct chats go with it, along with their messages,
        // private deliveries and routines.
        for (const conversation of await this.conversations()) {
          if (conversation.type === 'direct' && conversation.agentIds.includes(agentId)) {
            await this.stageRemoveSession(batch, conversation.id)
            continue
          }
          if (!conversation.agentIds.includes(agentId)) continue
          conversation.agentIds = conversation.agentIds.filter((id) => id !== agentId)
          if (conversation.leadAgentId === agentId) conversation.leadAgentId = conversation.agentIds[0]
          conversation.name = await this.groupName(conversation)
          await this.stageConversation(batch, conversation)
        }
        await batch.deleteWhere(this.privateRows, { senderId: agentId })
        await batch.deleteWhere(this.privateRows, { recipientId: agentId })
        // Runs first: the schedules they point at have to still exist here.
        const scheduleIds = new Set((await this.scheduleRows.where({ agentId })).map(schedule => schedule.id))
        for (const run of await this.runRows.all()) {
          if (run.agentId !== agentId && !(run.scheduleId && scheduleIds.has(run.scheduleId))) continue
          await batch.deleteWhere(this.eventRows, { runId: run.id })
          await batch.delete(this.runRows, run.id)
        }
        await batch.deleteWhere(this.scheduleRows, { agentId })
        await this.memories.stageRemoveAgent(batch, agentId)
        await batch.deleteWhere(this.bindingRows, { agentId })
        await batch.delete(this.profiles, agentId)
        await batch.delete(this.agentRows, agentId)
      })
    })
  }

  // ───────────────────────────── conversations ─────────────────────────────

  /** Restore an existing private thread, or recreate it after the user deleted
   * it while keeping the agent. The stable id prevents duplicate directs. */
  ensureDirectConversation(agentId: string): Promise<{ conversation: Conversation; created: boolean }> {
    return this.exclusive(async () => {
      const agent = await this.agent(agentId)
      if (!agent) throw new Error('Agent not found')
      const existing = (await this.sessions.where({ agentId })).find(session => session.kind === 'direct')
      if (existing) {
        const conversation = await this.compose(existing)
        conversation.hidden = undefined
        await this.felt.transaction(batch => this.stageConversation(batch, conversation))
        return { conversation, created: false }
      }
      const now = Date.now()
      const topic = newTopic('', now)
      const conversation: Conversation = {
        id: `direct-${agentId}`,
        type: 'direct',
        name: agent.name,
        agentIds: [agentId],
        topics: [topic],
        activeTopicId: topic.id,
        unread: 0,
        readAt: now,
        createdAt: now,
        updatedAt: now
      }
      await this.felt.transaction(batch => this.stageConversation(batch, conversation))
      return { conversation, created: true }
    })
  }

  /** Channels are transports for the agent's existing direct conversation. */
  async ensureIMConversation(agentId: string): Promise<Conversation> {
    if (!(await this.agentRows.has(agentId))) throw new Error('Agent not found')
    return (await this.ensureDirectConversation(agentId)).conversation
  }

  createGroup(input: CreateGroupInput): Promise<Conversation> {
    return this.exclusive(async () => {
      const now = Date.now()
      const known = new Set((await this.agentRows.all()).map((agent) => agent.id))
      const agentIds = [...new Set(input.agentIds)].filter((agentId) => known.has(agentId))
      const topic = newTopic('', now)
      const conversation: Conversation = {
        id: `group-${randomUUID()}`,
        type: 'group',
        autoNamed: !input.name.trim(),
        name:
          input.name.trim() ||
          (await Promise.all(agentIds.map(async (agentId) => (await this.agent(agentId))?.name))).filter(Boolean).join(', ') ||
          'New group',
        description: input.description?.trim() || undefined,
        agentIds,
        leadAgentId: agentIds.includes(input.leadAgentId ?? '') ? input.leadAgentId : agentIds[0],
        topics: [topic],
        activeTopicId: topic.id,
        unread: 0,
        readAt: now,
        createdAt: now,
        updatedAt: now
      }
      await this.felt.transaction(batch => this.stageConversation(batch, conversation))
      return (await this.conversation(conversation.id))!
    })
  }

  /**
   * A Project starts with one long-lived group conversation and may gain more
   * named chats. They use the ordinary runtime, so routing, delegation, Jev,
   * memory and message persistence remain unchanged. Only references are stored
   * here: the workspace remains the filesystem/Git authority and Compute remains
   * the execution authority.
   */
  ensureProjectConversation(projectId: string): Promise<Conversation> {
    return this.exclusive(async () => {
      const project = await this.project(projectId)
      if (!project) throw new Error('Project not found')
      const id = `project-${projectId}`
      const existing = await this.conversation(id)
      const knownAgentIds = (await this.agentRows.all()).map(agent => agent.id)
      if (existing) {
        existing.projectId = projectId
        existing.name = project.name
        existing.description = `Project conversation for ${project.name}`
        existing.workspacePath = project.path
        existing.hidden = true
        existing.agentIds = [...new Set([...existing.agentIds.filter(agentId => knownAgentIds.includes(agentId)), ...knownAgentIds])]
        if (!existing.leadAgentId || !existing.agentIds.includes(existing.leadAgentId)) existing.leadAgentId = existing.agentIds[0]
        await this.felt.transaction(batch => this.stageConversation(batch, existing))
        return (await this.conversation(id))!
      }
      const now = Date.now()
      const topic = newTopic('', now)
      const conversation: Conversation = {
        id, projectId, type: 'group', autoNamed: false, hidden: true,
        name: project.name, description: `Project conversation for ${project.name}`,
        agentIds: knownAgentIds, leadAgentId: knownAgentIds[0], workspacePath: project.path,
        topics: [topic], activeTopicId: topic.id, unread: 0, readAt: now, createdAt: now, updatedAt: now
      }
      await this.felt.transaction(batch => this.stageConversation(batch, conversation))
      return (await this.conversation(id))!
    })
  }

  /** Every discussion attached to a Project. The original chat is created lazily for existing Projects. */
  async projectConversations(projectId: string): Promise<Conversation[]> {
    if (!(await this.project(projectId))) throw new Error('Project not found')
    await this.ensureProjectConversation(projectId)
    return (await this.conversations()).filter(conversation => conversation.projectId === projectId)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.createdAt - b.createdAt)
  }

  /** A separate project discussion with the same workspace and current agent roster. */
  createProjectConversation(projectId: string, name: string): Promise<Conversation> {
    return this.exclusive(async () => {
      const project = await this.project(projectId)
      if (!project) throw new Error('Project not found')
      const clean = name.trim()
      if (!clean || clean.length > 80) throw new Error('Chat name must be between 1 and 80 characters.')
      const now = Date.now()
      const agentIds = (await this.agentRows.all()).map(agent => agent.id)
      const topic = newTopic('', now)
      const conversation: Conversation = {
        id: `project-${projectId}-${randomUUID()}`, projectId, type: 'group', autoNamed: false, hidden: true,
        name: clean, description: `Project chat for ${project.name}`, agentIds, leadAgentId: agentIds[0], workspacePath: project.path,
        topics: [topic], activeTopicId: topic.id, unread: 0, readAt: now, createdAt: now, updatedAt: now
      }
      await this.felt.transaction(batch => this.stageConversation(batch, conversation))
      return (await this.conversation(conversation.id))!
    })
  }

  /** Read, change and write one conversation as a single operation. */
  private change<T>(conversationId: string, work: (conversation: Conversation, batch: Batch) => Promise<T> | T, missing: T): Promise<T> {
    return this.exclusive(async () => {
      const conversation = await this.conversation(conversationId)
      if (!conversation) return missing
      return this.felt.transaction(async batch => {
        const result = await work(conversation, batch)
        await this.stageConversation(batch, conversation)
        return result
      })
    })
  }

  /** Callers must validate the folder and eligibility first. */
  async setConversationAllowedFolders(conversationId: string, folders: string[]): Promise<void> {
    if (!(await this.sessions.has(conversationId))) throw new Error('Chat not found')
    await this.change<void>(conversationId, conversation => { conversation.allowedFolders = [...new Set(folders)] }, undefined)
  }

  setConversationWorkspace(conversationId: string, workspacePath: string | undefined): Promise<Conversation | undefined> {
    return this.exclusive(async () => {
      const conversation = await this.conversation(conversationId)
      if (!conversation) return undefined
      // A coding session's folder is fixed for as long as it runs; the chat cannot be pointed elsewhere underneath it.
      const pinned = (await this.codingRows.where({ sessionId: conversationId })).find(row => row.status === 'running' && row.cwd !== workspacePath)
      if (pinned) throw new Error(`A coding session is running in this chat and is pinned to ${pinned.cwd}. Stop it before changing the folder.`)
      if (workspacePath) conversation.workspacePath = workspacePath
      else delete conversation.workspacePath
      await this.felt.transaction(batch => this.stageConversation(batch, conversation))
      return this.conversation(conversationId)
    })
  }

  updateConversation(conversationId: string, input: UpdateConversationInput): Promise<Conversation | undefined> {
    return this.exclusive(async () => {
      const conversation = await this.conversation(conversationId)
      if (!conversation) return undefined
      if (input.expectedRevision !== undefined && input.expectedRevision !== conversation.revision) throw new Error('Conversation changed. Reload before saving.')
      if (conversation.type === 'group') {
        if (input.avatar !== undefined) {
          if (!validAvatar(input.avatar)) throw new Error('Invalid group avatar')
          conversation.avatar = input.avatar || undefined
          if (input.avatar) conversation.avatarEmoji = undefined
        }
        if (input.avatarEmoji !== undefined) {
          const emoji = normalizeAgentEmoji(input.avatarEmoji)
          if (input.avatarEmoji && !emoji) throw new Error('Invalid group emoji')
          conversation.avatarEmoji = emoji || undefined
          if (emoji) conversation.avatar = undefined
        }
      }
      if (input.savedToContacts !== undefined) conversation.savedToContacts = input.savedToContacts
      if (input.muted !== undefined) conversation.muted = input.muted
      if (input.hidden !== undefined) conversation.hidden = input.hidden
      if (input.manuallyUnread !== undefined) {
        conversation.manuallyUnread = input.manuallyUnread
        conversation.unread = input.manuallyUnread ? Math.max(1, conversation.unread) : 0
      }
      if (input.name?.trim()) {
        conversation.name = input.name.trim()
        if (conversation.type === 'group') conversation.autoNamed = false
      }
      if (input.description !== undefined) conversation.description = input.description.trim() || undefined
      if (input.agentIds && conversation.type === 'group') {
        const known = new Set((await this.agentRows.all()).map((agent) => agent.id))
        conversation.agentIds = [...new Set(input.agentIds)].filter((agentId) => known.has(agentId))
        if (!conversation.agentIds.includes(conversation.leadAgentId ?? '')) {
          conversation.leadAgentId = conversation.agentIds[0]
        }
      }
      if (input.leadAgentId && conversation.agentIds.includes(input.leadAgentId)) {
        conversation.leadAgentId = input.leadAgentId
      }
      conversation.updatedAt = Date.now()
      await this.felt.transaction(batch => this.stageConversation(batch, conversation))
      return this.conversation(conversationId)
    })
  }

  deleteConversation(conversationId: string): Promise<void> {
    return this.exclusive(async () => {
      const target = await this.conversation(conversationId)
      if (!target) return
      if (target.savedToContacts) {
        await this.felt.transaction(async batch => {
          await this.stageClearConversation(batch, conversationId)
          const current = (await this.conversation(conversationId))!
          current.hidden = true
          current.updatedAt = Date.now()
          await this.stageConversation(batch, current)
        })
        return
      }
      await this.felt.transaction(batch => this.stageRemoveSession(batch, conversationId))
    })
  }

  setConversationPinned(conversationId: string, pinned: boolean): Promise<void> {
    return this.change<void>(conversationId, conversation => { conversation.pinned = pinned || undefined }, undefined)
  }

  markConversationRead(conversationId: string): Promise<void> {
    return this.change<void>(conversationId, conversation => {
      conversation.manuallyUnread = false
      conversation.unread = 0
      conversation.readAt = Date.now()
    }, undefined)
  }

  markAllConversationsRead(): Promise<void> {
    return this.exclusive(async () => {
      const now = Date.now()
      await this.felt.transaction(async batch => {
        for (const conversation of await this.conversations()) {
          conversation.manuallyUnread = false
          conversation.unread = 0
          conversation.readAt = now
          await this.stageConversation(batch, conversation)
        }
      })
    })
  }

  addUnread(conversationId: string, count: number): Promise<void> {
    if (count <= 0) return Promise.resolve()
    return this.change<void>(conversationId, conversation => {
      conversation.hidden = false
      conversation.unread += count
    }, undefined)
  }

  // ───────────────────────────── topics ─────────────────────────────

  createTopic(conversationId: string): Promise<Topic | undefined> {
    return this.change<Topic | undefined>(conversationId, conversation => {
      const topic = newTopic('', Date.now())
      conversation.topics.push(topic)
      conversation.activeTopicId = topic.id
      conversation.updatedAt = topic.createdAt
      return topic
    }, undefined)
  }

  renameTopic(conversationId: string, topicId: string, title: string): Promise<void> {
    return this.change<void>(conversationId, conversation => {
      const topic = conversation.topics.find((item) => item.id === topicId)
      if (!topic) return
      topic.title = title.trim().slice(0, 80)
      topic.updatedAt = Date.now()
    }, undefined)
  }

  deleteTopic(conversationId: string, topicId: string): Promise<void> {
    return this.exclusive(async () => {
      const conversation = await this.conversation(conversationId)
      if (!conversation || conversation.topics.length <= 1) return
      await this.felt.transaction(async batch => {
        conversation.topics = conversation.topics.filter((topic) => topic.id !== topicId)
        if (conversation.activeTopicId === topicId) conversation.activeTopicId = conversation.topics[0].id
        conversation.updatedAt = Date.now()
        await this.stageTopicContentRemoval(batch, conversationId, topicId)
        await this.stageConversation(batch, conversation)
      })
    })
  }

  setActiveTopic(conversationId: string, topicId: string): Promise<void> {
    return this.exclusive(async () => {
      const conversation = await this.conversation(conversationId)
      if (!conversation || !conversation.topics.some((topic) => topic.id === topicId)) return
      conversation.activeTopicId = topicId
      await this.felt.transaction(batch => this.stageConversation(batch, conversation))
    })
  }

  async activeTopicId(conversationId: string): Promise<string> {
    const conversation = await this.conversation(conversationId)
    if (!conversation) return DEFAULT_TOPIC_ID
    return conversation.topics.some((topic) => topic.id === conversation.activeTopicId)
      ? conversation.activeTopicId
      : conversation.topics[0]?.id ?? DEFAULT_TOPIC_ID
  }

  // ───────────────────────────── messages ─────────────────────────────

  /** The newest page of every topic, oldest first. */
  async recentMessages(): Promise<ChatMessage[]> {
    const pages = await Promise.all((await this.topics.all()).map(async topic =>
      (await this.messageRows.where({ sessionId: topic.sessionId, topicId: topic.topicId }, { order: 'desc', limit: RECENT_MESSAGES })).reverse()))
    return pages.flat().sort((a, b) => a.timestamp - b.timestamp).map(messageFromRecord)
  }

  async searchMessages(conversationId: string, query: string): Promise<ChatMessage[]> {
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    return (await this.messageRows.where({ sessionId: conversationId }))
      .filter(message => message.content.toLowerCase().includes(needle))
      .reverse().slice(0, 100).map(messageFromRecord)
  }

  /** Fifty messages ending just before `before` (or the newest fifty), oldest first. */
  async messagePage(conversationId: string, topicId: string, before?: string): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
    const anchor = before === undefined ? undefined : await this.messageRows.get(before)
    const seq = anchor && anchor.sessionId === conversationId && anchor.topicId === topicId
      ? (await this.messageRows.stored(before!))?.seq : undefined
    const page = await this.messageRows.page({
      where: [{ field: 'sessionId', eq: conversationId }, { field: 'topicId', eq: topicId }, ...(seq !== undefined ? [{ field: 'seq', lt: seq }] : [])],
      order: 'desc', limit: 51
    })
    return { messages: page.slice(0, 50).reverse().map(messageFromRecord), hasMore: page.length > 50 }
  }

  async topicMessages(conversationId: string, topicId: string): Promise<ChatMessage[]> {
    return (await this.messageRows.where({ sessionId: conversationId, topicId })).map(messageFromRecord)
  }

  async message(id: string): Promise<ChatMessage | undefined> {
    const record = await this.messageRows.get(id)
    return record ? messageFromRecord(record) : undefined
  }

  private async contextResetFor(conversationId: string, topicId: string): Promise<{ id: string; at: number } | undefined> {
    const topic = await this.topics.get(`${conversationId}/${topicId}`)
    return topic?.contextResetId !== undefined ? { id: topic.contextResetId, at: topic.contextResetAt ?? 0 } : undefined
  }

  async contextMessages(conversationId: string, topicId: string): Promise<ChatMessage[]> {
    const [reset, messages] = await Promise.all([this.contextResetFor(conversationId, topicId), this.topicMessages(conversationId, topicId)])
    return messages.filter(message => !reset || message.contextVersion === reset.id)
  }

  async contextPrivateMessages(conversationId: string, topicId: string): Promise<PrivateMessage[]> {
    const [reset, messages] = await Promise.all([this.contextResetFor(conversationId, topicId), this.topicPrivateMessages(conversationId, topicId)])
    return messages.filter(message => !reset || message.contextVersion === reset.id)
  }

  resetConversationContext(conversationId: string, topicId: string): Promise<void> {
    return this.exclusive(async () => {
      const conversation = await this.conversation(conversationId)
      const topic = conversation?.topics.find(item => item.id === topicId)
      if (!conversation || !topic) throw new Error('Chat not found')
      await this.felt.transaction(async batch => {
        const reset = { id: randomUUID(), at: Date.now() }
        // Keep the visible boundary outside the new model context, including on
        // repeated resets.
        await this.stageMessage(batch, { id: `context-reset:${reset.id}`, conversationId, topicId,
          authorId: 'system', authorName: 'Desktop', kind: 'system', text: 'Context reset', createdAt: reset.at }, conversation)
        topic.contextReset = reset
        if (conversation.type === 'group') await batch.put(this.settings, { id: `groupHealth:${conversationId}`, value: {}, updatedAt: Date.now() })
        for (const state of await this.groupStates.where({ sessionId: conversationId, topicId })) if (state.kind === 'game') await batch.delete(this.groupStates, state.id)
        await this.stageConversation(batch, conversation)
      })
    })
  }

  async topicPrivateMessages(conversationId: string, topicId: string): Promise<PrivateMessage[]> {
    return (await this.privateRows.where({ sessionId: conversationId, topicId })).map(privateMessageFromRecord)
  }

  setMessageDeliveryState(id: string, deliveryState?: ChatMessage['deliveryState']): Promise<void> {
    return this.exclusive(async () => {
      const message = await this.message(id)
      if (!message) return
      message.deliveryState = deliveryState
      await this.messageRows.put(messageToRecord(message))
    })
  }

  addMessage(message: Omit<ChatMessage, 'id' | 'createdAt'> & { id?: string; createdAt?: number }): Promise<ChatMessage> {
    let result: ChatMessage = {
      ...message,
      id: message.id ?? randomUUID(),
      createdAt: message.createdAt ?? Date.now()
    }
    return this.exclusive(() => this.felt.transaction(async batch => {
      const session = await batch.get(this.sessions, result.conversationId)
      const projectId = (session?.meta as { projectId?: unknown } | undefined)?.projectId
      const activeRun = typeof projectId === 'string' && !result.runId
        ? (await this.runRows.where({ sessionId: result.conversationId })).filter(run => run.status === 'running').sort((a, b) => b.createdAt - a.createdAt)[0]
        : undefined
      if (typeof projectId === 'string') result = {
        ...result, projectId, sessionId: result.sessionId ?? result.conversationId,
        ...(activeRun ? { runId: activeRun.id } : {}),
        ...(result.authorId !== 'user' && result.authorId !== 'system' ? { agentId: result.authorId } : {}),
        origin: result.origin ?? (result.authorId === 'user' ? 'user' : result.authorId === 'system' ? 'system' : result.sourceChannel ? 'channel' : 'agent')
      }
      await this.stageMessage(batch, result)
      if (!session) return result
      await batch.put(this.sessions, { ...session, updatedAt: result.createdAt, revision: (session.revision ?? 0) + 1 })
      const topic = await batch.get(this.topics, `${result.conversationId}/${result.topicId}`)
      if (topic) {
        const next = { ...topic, updatedAt: result.createdAt }
        // The first human line names the topic, the way a chat thread is titled.
        if (!topic.title && result.authorId === 'user') {
          next.title = (result.text || result.attachments?.map((attachment) => attachment.name).join(', ') || 'Image').slice(0, 80)
        }
        await batch.put(this.topics, next)
      }
      return result
    }))
  }

  async attachMessageRun(messageId: string, runId: string): Promise<void> {
    await this.exclusive(async () => {
      const record = await this.messageRows.get(messageId)
      if (!record) return
      await this.messageRows.put({ ...record, metadata: { ...(record.metadata ?? {}), runId } })
    })
  }

  /** Replace a message the runtime is still streaming into; the transcript stays durable while a turn runs. */
  updateMessage(id: string, patch: Partial<Pick<ChatMessage, 'text' | 'error' | 'detail' | 'actions' | 'attachments' | 'deliveries'>>): Promise<ChatMessage | undefined> {
    return this.exclusive(async () => {
      const message = await this.message(id)
      if (!message) return undefined
      const next = { ...message, ...patch }
      await this.messageRows.put(messageToRecord(next))
      return next
    })
  }

  async imReceipt(id: string, conversationId: string): Promise<ChatMessage | undefined> {
    const message = await this.message(id)
    return message && message.conversationId === conversationId && message.authorId === 'user' ? message : undefined
  }

  completeIMReceipt(id: string, text: string, attachments: ChatMessage['attachments']): Promise<ChatMessage> {
    return this.exclusive(async () => {
      const message = await this.message(id)
      if (!message || message.authorId !== 'user') throw new Error('IM receipt not found')
      const updated = { ...message, text, ...(attachments?.length ? { attachments } : {}) }
      await this.messageRows.put(messageToRecord(updated))
      return updated
    })
  }

  addDeliveryReplies(deliveryId: string, replies: MessageDeliveryReply[]): Promise<void> {
    if (!replies.length) return Promise.resolve()
    return this.exclusive(async () => {
      const holder = (await this.messageRows.all()).reverse().find(record =>
        (record.metadata?.deliveries as ChatMessage['deliveries'] | undefined)?.some(delivery => delivery.id === deliveryId))
      const message = holder && messageFromRecord(holder)
      const delivery = message?.deliveries?.find((candidate) => candidate.id === deliveryId)
      if (!message || !delivery) return
      const known = new Set(delivery.replies?.map((reply) => reply.id) ?? [])
      delivery.replies = [...(delivery.replies ?? []), ...replies.filter((reply) => !known.has(reply.id))]
      await this.messageRows.put(messageToRecord(message))
    })
  }

  addPrivateMessages(messages: PrivateMessage[]): Promise<void> {
    if (!messages.length) return Promise.resolve()
    return this.exclusive(() => this.felt.transaction(async batch => {
      for (const message of messages) {
        if (await batch.get(this.privateRows, message.id)) continue
        const reset = await this.contextResetOf(batch, message.conversationId, message.topicId)
        if (reset && message.createdAt >= reset.at) message.contextVersion = reset.id
        await batch.put(this.privateRows, privateMessageToRecord(message))
      }
      const stored = await this.privateRows.all()
      const excess = stored.length + messages.filter(message => !stored.some(row => row.id === message.id)).length - PRIVATE_MESSAGE_LIMIT
      for (const stale of stored.slice(0, Math.max(0, excess))) await batch.delete(this.privateRows, stale.id)
    }))
  }

  deleteMessage(conversationId: string, messageId: string): Promise<void> {
    return this.exclusive(async () => {
      if ((await this.messageRows.get(messageId))?.sessionId === conversationId) await this.messageRows.delete(messageId)
    })
  }

  private async stageClearConversation(batch: Batch, conversationId: string, topicId?: string): Promise<void> {
    if (topicId === undefined) {
      await batch.deleteWhere(this.groupStates, { sessionId: conversationId })
      await batch.deleteWhere(this.messageRows, { sessionId: conversationId })
      await batch.deleteWhere(this.privateRows, { sessionId: conversationId })
      return
    }
    await this.stageTopicContentRemoval(batch, conversationId, topicId)
    const conversation = await this.conversation(conversationId)
    const topic = conversation?.topics.find((item) => item.id === topicId)
    if (conversation && topic) {
      topic.title = ''
      delete topic.contextReset
      await this.stageConversation(batch, conversation)
    }
  }

  clearConversation(conversationId: string, topicId?: string): Promise<void> {
    return this.exclusive(() => this.felt.transaction(batch => this.stageClearConversation(batch, conversationId, topicId)))
  }

  // ───────────────────────────── routines & runs ─────────────────────────────

  createRoutine(input: CreateRoutineInput, nextRunAt: number): Promise<Routine> {
    const now = Date.now()
    const routine: Routine = {
      ...input,
      id: randomUUID(),
      target: 'local',
      enabled: true,
      nextRunAt,
      createdAt: now,
      updatedAt: now
    }
    return this.exclusive(async () => { await this.scheduleRows.put(routineToRecord(routine)); return routine })
  }

  deleteRoutine(routineId: string): Promise<void> {
    return this.exclusive(async () => { await this.scheduleRows.delete(routineId) })
  }

  private async routine(routineId: string): Promise<Routine | undefined> {
    const record = await this.scheduleRows.get(routineId)
    return record ? routineFromRecord(record) : undefined
  }

  setRoutineEnabled(routineId: string, enabled: boolean, nextRunAt?: number): Promise<Routine | undefined> {
    return this.exclusive(async () => {
      const routine = await this.routine(routineId)
      if (!routine) return undefined
      routine.enabled = enabled
      if (nextRunAt !== undefined) routine.nextRunAt = nextRunAt
      routine.updatedAt = Date.now()
      await this.scheduleRows.put(routineToRecord(routine))
      return routine
    })
  }

  markRoutineTriggered(routineId: string, triggeredAt: number, nextRunAt: number): Promise<Routine | undefined> {
    return this.exclusive(async () => {
      const routine = await this.routine(routineId)
      if (!routine) return undefined
      routine.lastRunAt = triggeredAt
      routine.nextRunAt = nextRunAt
      routine.updatedAt = triggeredAt
      await this.scheduleRows.put(routineToRecord(routine))
      return routine
    })
  }

  /**
   * Record that a set of routines fired, as one change. A one-time routine
   * (`disableAt`) is switched off in the same commit.
   */
  triggerRoutines(triggers: { routineId: string; triggeredAt: number; nextRunAt: number; disableAt?: number }[]): Promise<void> {
    return this.exclusive(() => this.felt.transaction(async batch => {
      for (const trigger of triggers) {
        const record = await batch.get(this.scheduleRows, trigger.routineId)
        if (!record) continue
        const routine = routineFromRecord(record)
        routine.lastRunAt = trigger.triggeredAt
        routine.nextRunAt = trigger.nextRunAt
        routine.updatedAt = trigger.triggeredAt
        if (trigger.disableAt !== undefined) { routine.enabled = false; routine.nextRunAt = trigger.disableAt }
        await batch.put(this.scheduleRows, routineToRecord(routine))
      }
    }))
  }

  createRun(
    input: Omit<TaskRun, 'id' | 'status' | 'createdAt' | 'target'> & { status?: RunStatus; createdAt?: number }
  ): Promise<TaskRun> {
    const run: TaskRun = {
      ...input,
      id: randomUUID(),
      target: 'local',
      status: input.status ?? 'queued',
      createdAt: input.createdAt ?? Date.now()
    }
    return this.exclusive(() => this.felt.transaction(async batch => {
      await batch.put(this.runRows, runToRecord(run))
      // Oldest runs fall off the back; their events go with them.
      const stored = await this.runRows.all()
      for (const old of stored.slice(0, Math.max(0, stored.length + 1 - RUN_LIMIT))) {
        await batch.deleteWhere(this.eventRows, { runId: old.id })
        await batch.delete(this.runRows, old.id)
      }
      await batch.put(this.eventRows, eventToRecord({ id: randomUUID(), runId: run.id, type: 'status', kind: 'queued', label: 'Queued', status: 'queued', createdAt: run.createdAt }, run.conversationId))
      return run
    }))
  }

  updateRun(
    runId: string,
    patch: Partial<Pick<TaskRun, 'status' | 'latestActivity' | 'error' | 'startedAt' | 'finishedAt'>>
  ): Promise<TaskRun | undefined> {
    return this.exclusive(async () => {
      const record = await this.runRows.get(runId)
      if (!record) return undefined
      const run = runFromRecord(record)
      Object.assign(run, patch)
      await this.runRows.put(runToRecord(run))
      return run
    })
  }

  addRunEvent(input: Omit<RunEvent, 'id' | 'createdAt'> & { createdAt?: number }): Promise<RunEvent> {
    const event: RunEvent = {
      ...input,
      id: randomUUID(),
      createdAt: input.createdAt ?? Date.now()
    }
    return this.exclusive(async () => {
      const run = await this.runRows.get(event.runId)
      if (!run) return event
      await this.eventRows.put(eventToRecord(event, run.sessionId))
      await this.trimEvents()
      return event
    })
  }

  /** A tool call is recorded when it starts and settled when it returns. */
  startToolExecution(input: { runId?: string; sessionId: string; callId: string; tool: string; target?: string }): Promise<void> {
    const id = `${input.runId ?? input.sessionId}:${input.callId}`
    return this.exclusive(async () => {
      await this.toolRows.put({ id, ...(input.runId ? { runId: input.runId } : {}), sessionId: input.sessionId, tool: input.tool, status: 'running',
        ...(input.target ? { target: input.target } : {}), startedAt: Date.now() })
    })
  }

  finishToolExecution(input: { runId?: string; sessionId: string; callId: string; failed: boolean }): Promise<void> {
    return this.exclusive(async () => {
      const record = await this.toolRows.get(`${input.runId ?? input.sessionId}:${input.callId}`)
      if (record) await this.toolRows.put({ ...record, status: input.failed ? 'failed' : 'succeeded', finishedAt: Date.now() })
    })
  }

  /** A tool call begins: its execution record, its event and the run's latest activity are stored together. */
  startToolCall(input: { runId: string; sessionId?: string; callId: string; tool: string; target?: string; event: Omit<RunEvent, 'id' | 'createdAt'> }): Promise<void> {
    const id = `${input.runId}:${input.callId}`
    return this.exclusive(async () => {
      await this.felt.transaction(async batch => {
        const run = await batch.get(this.runRows, input.runId)
        if (!run) return
        await batch.put(this.runRows, { ...run, metadata: { ...(run.metadata ?? {}), latestActivity: input.tool } })
        await batch.put(this.eventRows, eventToRecord({ ...input.event, id: randomUUID(), createdAt: Date.now() }, run.sessionId))
        await batch.put(this.toolRows, { id, runId: input.runId, sessionId: input.sessionId ?? run.sessionId, tool: input.tool, status: 'running',
          ...(input.target ? { target: input.target } : {}), startedAt: Date.now() })
      })
      await this.trimEvents()
    })
  }

  /** A tool call returns: its execution record and its result event are stored together. */
  finishToolCall(input: { runId: string; sessionId?: string; callId: string; failed: boolean; event: Omit<RunEvent, 'id' | 'createdAt'> }): Promise<void> {
    const id = `${input.runId}:${input.callId}`
    return this.exclusive(async () => {
      await this.felt.transaction(async batch => {
        const run = await batch.get(this.runRows, input.runId)
        if (!run) return
        await batch.put(this.eventRows, eventToRecord({ ...input.event, id: randomUUID(), createdAt: Date.now() }, run.sessionId))
        const record = await batch.get(this.toolRows, id)
        if (record) await batch.put(this.toolRows, { ...record, status: input.failed ? 'failed' : 'succeeded', finishedAt: Date.now() })
      })
      await this.trimEvents()
    })
  }

  /** Events beyond the cap are dropped oldest first, in batches so a long run is not trimmed on every append. */
  private async trimEvents(): Promise<void> {
    const total = await this.eventRows.count()
    if (total <= RUN_EVENT_LIMIT + TRIM_SLACK) return
    const stale = await this.eventRows.page({ order: 'asc', limit: total - RUN_EVENT_LIMIT })
    await this.felt.transaction(async batch => { for (const old of stale) await batch.delete(this.eventRows, old.id) })
  }

  toolExecutions(sessionId: string): Promise<ToolExecutionRecord[]> {
    return this.toolRows.where({ sessionId })
  }

  async runEventsFor(runId: string): Promise<RunEvent[]> {
    return (await this.eventRows.where({ runId })).map(eventFromRecord)
  }

  // ───────────────────────────── custom local agents ─────────────────────────────
  // The agent CLIs the owner registered (name, command, arguments). Configuration, but desktop state all the same.

  async localAgentDefinitions(): Promise<{ id: string; name: string; command: string; args?: string[]; avatar?: string }[]> {
    return (await this.localAgentRows.all()).sort((a, b) => a.position - b.position)
      .map(({ position: _position, updatedAt: _updated, ...definition }) => definition)
  }

  /** The whole list, in order, in one transaction: entries that are not in it are removed. */
  replaceLocalAgentDefinitions(definitions: { id: string; name: string; command: string; args?: string[]; avatar?: string }[]): Promise<void> {
    return this.exclusive(() => this.felt.transaction(async batch => {
      const keep = new Set(definitions.map(item => item.id))
      for (const old of await this.localAgentRows.all()) if (!keep.has(old.id)) await batch.delete(this.localAgentRows, old.id)
      const now = Date.now()
      for (const [position, definition] of definitions.entries()) {
        await batch.put(this.localAgentRows, { id: definition.id, name: definition.name, command: definition.command, position, updatedAt: now,
          ...(definition.args ? { args: definition.args } : {}), ...(definition.avatar ? { avatar: definition.avatar } : {}) })
      }
    }))
  }

  // ───────────────────────────── projects and coding sessions ─────────────────────────────
  // A project is a folder Foundry may work in; the folder itself stays the authority for its files.
  // Nothing here stores source code, only that the project and the session exist and what they produced.

  async projects(): Promise<Project[]> {
    return (await this.workspaces.all()).filter(record => record.name !== undefined).map(projectFromRecord)
  }

  async project(id: string): Promise<Project | undefined> {
    const record = await this.workspaces.get(id)
    return record?.name !== undefined ? projectFromRecord(record) : undefined
  }

  /** The same folder is always the same project, so adding it again updates rather than duplicates. */
  addProject(input: { path: string; name: string; isGit: boolean; testCommand?: string[] }): Promise<Project> {
    return this.exclusive(async () => {
      const existing = (await this.workspaces.where({ path: input.path }))[0]
      const now = Date.now()
      const record: WorkspaceRecord = { ...(existing ?? { id: workspaceId(input.path), path: input.path, createdAt: now }),
        name: input.name.trim() || basename(input.path), isGit: input.isGit, updatedAt: now,
        ...(input.testCommand ? { testCommand: input.testCommand } : {}) }
      if (!input.testCommand) delete record.testCommand
      await this.workspaces.put(record)
      const project = projectFromRecord(record)
      await this.ensureProjectConversation(project.id)
      return project
    })
  }

  setProjectTestCommand(id: string, testCommand: string[] | undefined): Promise<Project | undefined> {
    return this.exclusive(async () => {
      const record = await this.workspaces.get(id)
      if (record?.name === undefined) return undefined
      const next: WorkspaceRecord = { ...record, updatedAt: Date.now() }
      if (testCommand) next.testCommand = testCommand
      else delete next.testCommand
      await this.workspaces.put(next)
      return projectFromRecord(next)
    })
  }

  /** Stops being a project. Chats that used the folder keep their workspace; sessions keep their history. */
  removeProject(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const record = await this.workspaces.get(id)
      if (record?.name === undefined) return false
      if ((await this.codingRows.where({ workspaceId: id })).some(row => row.status === 'running')) throw new Error('This project has a coding session that is still running.')
      if ((await this.ciRows.where({ workspaceId: id })).some(row => row.status === 'running')) throw new Error('This project has a CI run that is still running.')
      const { name: _name, isGit: _isGit, testCommand: _test, ...rest } = record
      await this.workspaces.put({ ...rest, updatedAt: Date.now() })
      return true
    })
  }

  async codingSessions(projectId?: string): Promise<CodingSession[]> {
    const rows = projectId ? await this.codingRows.where({ workspaceId: projectId }) : await this.codingRows.all()
    return rows.map(codingSessionFromRecord)
  }

  /** Processes Foundry started and is responsible for (see processLedger.ts). Not their state — a note for the next start. */
  processLedger(): { put(record: AgentProcessRow): Promise<void>; remove(id: string): Promise<void>; all(): Promise<AgentProcessRow[]> } {
    return {
      put: async record => { await this.processRows.put(record) },
      remove: async id => { await this.processRows.delete(id) },
      all: () => this.processRows.all()
    }
  }

  async codingSession(id: string): Promise<CodingSession | undefined> {
    const record = await this.codingRows.get(id)
    return record ? codingSessionFromRecord(record) : undefined
  }

  createCodingSession(input: Omit<CodingSession, 'id' | 'createdAt' | 'changes' | 'commands' | 'events'> & { changes?: CodingSession['changes']; commands?: CodingSession['commands']; events?: CodingSession['events'] }): Promise<CodingSession> {
    const session: CodingSession = { changes: [], commands: [], events: [], ...input, id: randomUUID(), createdAt: Date.now() }
    return this.exclusive(async () => {
      if (!(await this.project(session.projectId))) throw new Error('Project not found')
      await this.codingRows.put(codingSessionToRecord(session))
      return session
    })
  }

  /** Patch a session. A finished session stays finished: a late update cannot revive it. */
  updateCodingSession(id: string, patch: Partial<Omit<CodingSession, 'id' | 'projectId' | 'createdAt'>>): Promise<CodingSession | undefined> {
    return this.exclusive(async () => {
      const record = await this.codingRows.get(id)
      if (!record) return undefined
      const current = codingSessionFromRecord(record)
      if (current.status !== 'running' && patch.status === 'running') return current
      const next: CodingSession = { ...current, ...patch }
      await this.codingRows.put(codingSessionToRecord(next))
      return next
    })
  }

  /** Append a meaningful outcome to a session's history (bounded; older entries fall off). */
  addCodingEvent(id: string, event: Omit<CodingEvent, 'at'> & { at?: number }): Promise<void> {
    return this.exclusive(async () => {
      const record = await this.codingRows.get(id)
      if (!record) return
      const session = codingSessionFromRecord(record)
      await this.codingRows.put(codingSessionToRecord({ ...session, events: [...session.events, { at: Date.now(), ...event }].slice(-MAX_CODING_EVENTS) }))
    })
  }

  /** Reopen a finished session for another turn in the same project, chat and topic. Its folder does not change. */
  resumeCodingSession(id: string): Promise<CodingSession> {
    return this.exclusive(async () => {
      const record = await this.codingRows.get(id)
      if (!record) throw new Error('Coding session not found')
      const current = codingSessionFromRecord(record)
      if (current.status === 'running') throw new Error('This coding session is already running.')
      if ((await this.codingRows.where({ agentId: current.agentId })).some(row => row.status === 'running')) throw new Error('This agent is already working on a coding session.')
      const { finishedAt: _finished, error: _error, ...rest } = current
      const next: CodingSession = { ...rest, status: 'running', startedAt: Date.now(),
        events: [...current.events, { at: Date.now(), kind: 'continued' as const, label: 'Continued' }].slice(-MAX_CODING_EVENTS) }
      await this.codingRows.put(codingSessionToRecord(next))
      return next
    })
  }

  /**
   * Sessions still marked running when the app starts belong to a process that no
   * longer exists. They become `interrupted`; their history and changes stay.
   */
  recoverInterruptedCodingSessions(now = Date.now()): Promise<CodingSession[]> {
    return this.exclusive(async () => {
      const interrupted = (await this.codingRows.all()).filter(row => row.status === 'running')
      const recovered: CodingSession[] = []
      for (const row of interrupted) {
        const current = codingSessionFromRecord(row)
        const next: CodingSession = { ...current, status: 'interrupted', finishedAt: now, error: 'The app closed while this coding session was running. Its process did not survive.',
          events: [...current.events, { at: now, kind: 'interrupted' as const, label: 'Interrupted when Foundry closed' }].slice(-MAX_CODING_EVENTS) }
        await this.codingRows.put(codingSessionToRecord(next))
        recovered.push(next)
      }
      return recovered
    })
  }

  // ───────────────────────────── CI runs ─────────────────────────────

  async ciRuns(projectId?: string): Promise<CiRun[]> {
    const rows = projectId ? await this.ciRows.where({ workspaceId: projectId }) : await this.ciRows.all()
    return rows.map(ciRunFromRecord)
  }

  async ciRun(id: string): Promise<CiRun | undefined> {
    const record = await this.ciRows.get(id)
    return record ? ciRunFromRecord(record) : undefined
  }

  /** A new run, numbered within its project. */
  createCiRun(input: Omit<CiRun, 'id' | 'number' | 'createdAt' | 'operations' | 'events'> & { events?: CiEvent[] }): Promise<CiRun> {
    return this.exclusive(async () => {
      if (!(await this.project(input.projectId))) throw new Error('Project not found')
      const existing = await this.ciRows.where({ workspaceId: input.projectId })
      if (existing.some(row => row.status === 'running')) throw new Error('This project already has a CI run in progress.')
      const run: CiRun = { operations: [], events: [], ...input, id: randomUUID(), number: existing.reduce((highest, row) => Math.max(highest, row.number), 0) + 1, createdAt: Date.now() }
      await this.ciRows.put(ciRunToRecord(run))
      return run
    })
  }

  /** Patch a run. A finished run stays finished: a late update cannot revive it, and its status is not rewritten. */
  updateCiRun(id: string, patch: Partial<Omit<CiRun, 'id' | 'projectId' | 'number' | 'createdAt'>>, event?: Omit<CiEvent, 'at'>): Promise<CiRun | undefined> {
    return this.exclusive(async () => {
      const record = await this.ciRows.get(id)
      if (!record) return undefined
      const current = ciRunFromRecord(record)
      const finished = current.status !== 'running'
      const { status: _status, phase: _phase, ...rest } = patch
      const next: CiRun = { ...current, ...(finished ? rest : patch), events: event ? [...current.events, { at: Date.now(), ...event }].slice(-MAX_CI_EVENTS) : current.events }
      await this.ciRows.put(ciRunToRecord(next))
      return next
    })
  }

  // ───────────────────────────── development environments (references to Compute) ─────────────────────────────

  /** The Compute environment a project points at. A reference only: what that environment is, and whether it exists, is asked of Compute. */
  async developmentEnvironment(projectId: string): Promise<DevelopmentEnvironmentRef | undefined> {
    const record = await this.environmentRows.get(projectId)
    return record ? developmentEnvironmentFromRecord(record) : undefined
  }

  /** Point a project at a Compute environment (one per project). */
  putDevelopmentEnvironment(ref: DevelopmentEnvironmentRef): Promise<DevelopmentEnvironmentRef> {
    return this.exclusive(async () => {
      if (!(await this.project(ref.projectId))) throw new Error('Project not found')
      await this.environmentRows.put(developmentEnvironmentToRecord(ref))
      return ref
    })
  }

  deleteDevelopmentEnvironment(projectId: string): Promise<void> {
    return this.exclusive(async () => { await this.environmentRows.delete(projectId) })
  }

  // ───────────────────────────── runtime bindings ─────────────────────────────

  runtimeBinding(id: string): Promise<RuntimeBindingRecord | undefined> { return this.bindingRows.get(id) }
  runtimeBindings(): Promise<RuntimeBindingRecord[]> { return this.bindingRows.all() }
  putRuntimeBinding(record: RuntimeBindingRecord): Promise<void> { return this.exclusive(async () => { await this.bindingRows.put(record) }) }

  // ───────────────────────────── attention ─────────────────────────────

  async attentionItems(): Promise<AttentionItem[]> {
    return (await this.attentionRows.all()).filter(item => item.resolvedAt === undefined).reverse()
  }

  addAttention(input: Omit<AttentionItem, 'id' | 'createdAt' | 'resolvedAt'> & { id?: string }): Promise<AttentionItem> {
    const item: AttentionItem = { ...input, id: input.id ?? randomUUID(), createdAt: Date.now() }
    return this.exclusive(() => this.attentionRows.put(item))
  }

  resolveAttention(id: string): Promise<void> {
    return this.exclusive(async () => {
      const item = await this.attentionRows.get(id)
      if (item && item.resolvedAt === undefined) await this.attentionRows.put({ ...item, resolvedAt: Date.now() })
    })
  }

  // ───────────────────────────── run recovery ─────────────────────────────

  /**
   * A run that was queued or running when the app stopped did not finish — and
   * did not fail either; nobody knows. Mark it `interrupted`, keep whatever
   * partial reply was durably recorded, and leave an attention item. A
   * scheduled one-time task is made eligible for one delayed retry.
   */
  recoverInterruptedRuns(now = Date.now()): Promise<TaskRun[]> {
    return this.exclusive(async () => {
      const interrupted = (await this.runs()).filter(run => run.status === 'queued' || run.status === 'running')
      for (const run of interrupted) {
        const title = 'The app closed before this task finished'
        const partial = (await this.runEventsFor(run.id)).filter(event => event.kind === 'message_delta').at(-1)?.detail
        const conversation = await this.conversation(run.conversationId)
        const routine = run.routineId ? await this.routine(run.routineId) : undefined
        await this.felt.transaction(async batch => {
          if (conversation) {
            const topicId = conversation.activeTopicId
            if (partial?.trim()) {
              const agent = await this.agent(run.agentId)
              await this.stageMessage(batch, { id: `interrupted:${run.id}`, conversationId: conversation.id, topicId, authorId: run.agentId,
                authorName: agent?.name ?? 'Agent', text: partial, kind: 'message', error: title, createdAt: now }, conversation)
            }
            await this.stageMessage(batch, { id: `interrupted-notice:${run.id}`, conversationId: conversation.id, topicId, authorId: 'system',
              authorName: 'Desktop', text: title, kind: 'system', createdAt: now }, conversation)
            conversation.updatedAt = now
            await this.stageConversation(batch, conversation)
          }
          const record = await batch.get(this.runRows, run.id)
          if (record) await batch.put(this.runRows, runToRecord({ ...runFromRecord(record), status: 'interrupted', latestActivity: 'Interrupted', error: title, finishedAt: now }))
          await batch.put(this.eventRows, eventToRecord({ id: randomUUID(), runId: run.id, type: 'status', kind: 'interrupted', label: title, status: 'interrupted', createdAt: now }, run.conversationId))
          await batch.put(this.attentionRows, { id: `interrupted:${run.id}`, kind: 'interrupted-run', title, sessionId: run.conversationId, runId: run.id, detail: run.title, createdAt: now })
          if (routine?.schedule.kind === 'once' && !routine.enabled) await batch.put(this.scheduleRows, routineToRecord({ ...routine, enabled: true, nextRunAt: now + 60_000, updatedAt: now }))
        })
      }
      return interrupted
    })
  }

  // ───────────────────────────── import (migration) ─────────────────────────────

  /** Write helpers for the one-time legacy import. They keep the record's original id, so a repeated import replaces rather than duplicates. */
  readonly importer = {
    agent: (agent: AgentConfig): Promise<void> => this.exclusive(() => this.felt.transaction(batch => this.stageAgent(batch, { ...agent, revision: agent.revision ?? 1 }, false))),
    conversation: (conversation: Conversation): Promise<void> => this.exclusive(() => this.felt.transaction(batch => this.stageConversation(batch, { ...conversation, revision: conversation.revision ?? 1 }, false))),
    message: async (message: ChatMessage): Promise<void> => { await this.messageRows.put(messageToRecord(message)) },
    privateMessage: async (message: PrivateMessage): Promise<void> => { await this.privateRows.put(privateMessageToRecord(message)) },
    routine: async (routine: Routine): Promise<void> => { await this.scheduleRows.put(routineToRecord(routine)) },
    run: async (run: TaskRun): Promise<void> => { await this.runRows.put(runToRecord(run)) },
    runEvent: async (event: RunEvent, sessionId?: string): Promise<void> => { await this.eventRows.put(eventToRecord(event, sessionId)) },
    groupState: async (state: { id: string; sessionId: string; topicId: string; kind: 'game' | 'workflow'; revision?: number; document: unknown }): Promise<void> => { await this.groupStates.put(state) },
    attachment: async (record: AttachmentRecord): Promise<void> => { await this.attachments.put(record) },
    memory: async (record: MemoryRecord): Promise<void> => { await this.memoryRows.put(record) },
    binding: async (record: RuntimeBindingRecord): Promise<void> => { await this.bindingRows.put(record) },
    setting: (key: string, value: unknown): Promise<void> => this.setSetting(key, value)
  }

  async counts(): Promise<Record<string, number>> {
    const [agents, sessions, messages, privateMessages, schedules, runs, groupStates, attachments, memories, topics] = await Promise.all([
      this.agentRows.count(), this.sessions.count(), this.messageRows.count(), this.privateRows.count(), this.scheduleRows.count(),
      this.runRows.count(), this.groupStates.count(), this.attachments.count(), this.memoryRows.count(), this.topics.count()
    ])
    return { agents, sessions, messages, privateMessages, schedules, runs, groupStates, attachments, memories, topics }
  }

  hasRecord(collection: 'agent' | 'session' | 'message' | 'attachment' | 'memory', id: string): Promise<boolean> {
    switch (collection) {
      case 'agent': return this.agentRows.has(id)
      case 'session': return this.sessions.has(id)
      case 'message': return this.messageRows.has(id)
      case 'attachment': return this.attachments.has(id)
      case 'memory': return this.memoryRows.has(id)
    }
  }

  // ───────────────────────────── demo fixture ─────────────────────────────

  private seedDemo(): Promise<void> {
    return this.exclusive(() => this.felt.transaction(async batch => {
      const agents = defaultAgents()
      const now = Date.now()
      const groupTopic = newTopic('', now)
      const dobiTopic = newTopic('', now)
      const linTopic = newTopic('', now)
      for (const agent of agents) await this.stageAgent(batch, agent)
      await this.stageConversation(batch, { id: 'crew', type: 'group', name: 'Dobi, Lin',
        description: 'The default crew: shape a goal together and hand the work to the right bot.',
        agentIds: agents.map((agent) => agent.id), leadAgentId: agents[0].id, topics: [groupTopic], activeTopicId: groupTopic.id,
        unread: 0, readAt: now, createdAt: now, updatedAt: now })
      await this.stageConversation(batch, { id: 'direct-dobi', type: 'direct', name: 'Dobi', agentIds: ['dobi'], topics: [dobiTopic],
        activeTopicId: dobiTopic.id, unread: 0, readAt: now, createdAt: now - 120_000, updatedAt: now - 120_000 })
      await this.stageConversation(batch, { id: 'direct-lin', type: 'direct', name: 'Lin', agentIds: ['lin'], topics: [linTopic],
        activeTopicId: linTopic.id, unread: 0, readAt: now, createdAt: now - 240_000, updatedAt: now - 240_000 })
      await batch.put(this.messageRows, messageToRecord({ id: randomUUID(), conversationId: 'crew', topicId: groupTopic.id, authorId: 'dobi', authorName: 'Dobi',
        text: 'Drop a goal here. I’ll shape the plan and pull in the right bot.', kind: 'message', createdAt: now - 75_000 }))
      await batch.put(this.messageRows, messageToRecord({ id: randomUUID(), conversationId: 'crew', topicId: groupTopic.id, authorId: 'lin', authorName: 'Lin',
        text: 'I’m ready to turn it into something you can ship.', kind: 'message', createdAt: now - 55_000 }))
      await batch.put(this.settings, { id: 'demoSeeded', value: true, updatedAt: now })
    }))
  }
}
