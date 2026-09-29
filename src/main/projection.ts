import { gameView, type GameState } from '../shared/groupGame'
import { workflowView, type GroupWorkflow } from '../shared/groupWorkflow'
import type { ProjectionChange, ProjectionDelta, ProjectionSnapshot } from '../shared/projection'
import type { PermissionRequest } from '../shared/agentPermissions'
import type { AgentStatus, AppSnapshot, ComputerSession, ConversationActivityState, ModelOption, RuntimeStatus } from '../shared/types'
import type { DesktopRepository, RecordChange } from './desktopRepository'
import {
  eventFromRecord, messageFromRecord, privateMessageFromRecord, routineFromRecord, runFromRecord,
  type ExecutionEventRecord, type MessageRecord, type PrivateMessageRecord, type RunRecord, type ScheduleRecord
} from './felt/records'

/** What exists only while the app runs, and so is never in FeltDB. */
export interface EphemeralState {
  agentStatuses: Record<string, AgentStatus>
  activity: ConversationActivityState[]
  permissionRequests: PermissionRequest[]
  computers: ComputerSession[]
}

export interface ProjectionSources {
  /** Live, in-memory state of the running desktop. */
  ephemeral(): EphemeralState
  /** What the running desktop can currently do, given its agents. */
  runtimeStatus(agents: AppSnapshot['agents']): RuntimeStatus
  availableModels(): ModelOption[]
  connectors(): Promise<AppSnapshot['connectors']>
}

const RUNS_SHOWN = 60

/**
 * Turns FeltDB's change announcements into what the renderer needs.
 *
 * It owns no state about the desktop. Each announcement names one record; for
 * the record's own kind the change is forwarded as it arrived, and for things
 * composed from several records (an agent, a conversation) only that one thing
 * is read again. Nothing here scans a collection because something was written.
 */
export class DesktopProjection {
  private sequence = 0
  private unsubscribe?: () => void
  private direct: ProjectionChange[] = []
  private agents = new Set<string>()
  private conversations = new Set<string>()
  private health = new Set<string>()
  private slices = new Set<'desktop' | 'profile' | 'connectors' | 'runtime' | 'ephemeral'>()
  private scheduled = false
  private flushing: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(private readonly repository: DesktopRepository, private readonly sources: ProjectionSources, private readonly send: (delta: ProjectionDelta) => void) {}

  start(): void {
    this.unsubscribe = this.repository.subscribe(change => this.observe(change))
  }

  /** Stop announcing, and let a flush already under way finish. */
  async stop(): Promise<void> {
    this.stopped = true
    this.unsubscribe?.()
    await this.flushing
  }

  /** Every change announced so far has been turned into a delta and sent. */
  async settled(): Promise<void> {
    // Announcements arrive inside the writer's own call, so by now the flush is scheduled; let it start, then wait for it.
    await Promise.resolve()
    do { await this.flushing } while (this.scheduled)
  }

  /** Something that lives only in memory changed. */
  ephemeralChanged(): void {
    this.slices.add('ephemeral')
    this.schedule()
  }

  /** Everything the renderer shows, read from FeltDB, for a renderer that has just connected. */
  async snapshot(): Promise<ProjectionSnapshot> {
    const sequence = this.sequence
    const [agents, conversations, messages, privateMessages, routines, runs, runEvents, attention, games, workflows, connectors, userName, userAvatar, desktop] = await Promise.all([
      this.repository.agents(), this.repository.conversations(), this.repository.recentMessages(), this.repository.privateMessages(), this.repository.routines(),
      this.repository.runs(), this.repository.runEvents(), this.repository.attentionItems(), this.repository.groupGames(), this.repository.groupWorkflows(),
      this.sources.connectors(), this.repository.userName(), this.repository.userAvatar(), this.desktopInfo()
    ])
    const conversationIds = new Set(conversations.map(conversation => conversation.id))
    const shownRuns = [...runs].sort((a, b) => b.createdAt - a.createdAt).slice(0, RUNS_SHOWN)
    const runIds = new Set(shownRuns.map(run => run.id))
    const ephemeral = this.sources.ephemeral()
    const health = await Promise.all(conversations.filter(conversation => conversation.type === 'group').map(async conversation => [conversation.id, await this.groupHealth(conversation.id, conversation.agentIds)] as const))
    return {
      sequence,
      snapshot: {
        agents,
        groupMemberHealth: Object.fromEntries(health),
        groupGames: [...new Map(games.map(game => [`${game.conversationId}:${game.topicId}`, gameView(game)])).values()],
        groupWorkflows: [...new Map(workflows.map(workflow => [`${workflow.conversationId}:${workflow.topicId}`, workflowView(workflow)])).values()],
        conversations,
        messages: messages.filter(message => conversationIds.has(message.conversationId)),
        privateMessages: privateMessages.filter(message => conversationIds.has(message.conversationId)),
        routines: [...routines].sort((a, b) => a.nextRunAt - b.nextRunAt),
        runs: shownRuns,
        runEvents: runEvents.filter(event => runIds.has(event.runId) && event.kind !== 'message_delta'),
        attention,
        desktop,
        runtime: this.sources.runtimeStatus(agents),
        models: this.sources.availableModels(),
        connectors, userName, userAvatar,
        agentStatuses: Object.fromEntries(agents.map(agent => [agent.id, ephemeral.agentStatuses[agent.id] ?? 'idle'])),
        activity: ephemeral.activity.filter(activity => conversationIds.has(activity.conversationId)),
        permissionRequests: ephemeral.permissionRequests,
        computers: ephemeral.computers.filter(computer => agents.some(agent => agent.id === computer.agentId))
      }
    }
  }

  private async desktopInfo(): Promise<NonNullable<AppSnapshot['desktop']>> {
    const [onboarding, agents, migration] = await Promise.all([
      this.repository.setting<{ completed?: boolean }>('onboarding'), this.repository.agents(), this.repository.migration()
    ])
    return {
      onboardingCompleted: onboarding?.completed === true || agents.length > 0,
      databaseDirectory: this.repository.felt.directory,
      ...(migration ? { migration: (({ status, imported, skipped, error }) => ({ status, imported, skipped, error }))(migration as never) } : {})
    }
  }

  private async groupHealth(conversationId: string, memberIds: string[]): Promise<Record<string, { status: 'healthy' | 'unknown' | 'unavailable'; checkedAt: number }>> {
    const health = await this.repository.groupHealth(conversationId)
    return Object.fromEntries(Object.entries(health).filter(([id]) => memberIds.includes(id)).map(([id, item]) => [id, { status: item.status, checkedAt: item.checkedAt }]))
  }

  // ───────────────────────────── announcements ─────────────────────────────

  private observe(change: RecordChange): void {
    if (this.stopped) return
    const record = change.record
    switch (change.collection) {
      case 'Agent':
      case 'AgentProfile':
        this.agents.add(change.collection === 'AgentProfile' ? (record?.agentId as string | undefined) ?? change.id : change.id)
        this.slices.add('runtime')
        break
      case 'Session':
      case 'Group':
        this.conversations.add(change.id)
        break
      case 'Topic':
        this.conversations.add((record?.sessionId as string | undefined) ?? change.id.slice(0, change.id.indexOf('/')))
        break
      case 'GroupMember':
        this.conversations.add((record?.groupId as string | undefined) ?? change.id.slice(0, change.id.lastIndexOf(':')))
        break
      case 'Message':
        this.direct.push({ kind: 'message', id: change.id, value: record ? messageFromRecord(record as unknown as MessageRecord) : null })
        break
      case 'PrivateMessage':
        this.direct.push({ kind: 'privateMessage', id: change.id, value: record ? privateMessageFromRecord(record as unknown as PrivateMessageRecord) : null })
        break
      case 'Schedule':
        this.direct.push({ kind: 'routine', id: change.id, value: record ? routineFromRecord(record as unknown as ScheduleRecord) : null })
        break
      case 'Run':
        this.direct.push({ kind: 'run', id: change.id, value: record ? runFromRecord(record as unknown as RunRecord) : null })
        break
      case 'ExecutionEvent': {
        const event = record ? eventFromRecord(record as unknown as ExecutionEventRecord) : undefined
        // A reply still being written is a draft for recovery, not something to show.
        if (!event || event.kind !== 'message_delta') this.direct.push({ kind: 'runEvent', id: change.id, value: event ?? null })
        break
      }
      case 'AttentionItem':
        this.direct.push({ kind: 'attention', id: change.id, value: record ? record as never : null })
        break
      case 'GroupState': {
        const state = record as { kind?: string; document?: unknown } | undefined
        if (state?.kind === 'game') this.direct.push({ kind: 'groupGame', id: change.id, value: gameView(state.document as GameState) })
        else if (state?.kind === 'workflow') this.direct.push({ kind: 'groupWorkflow', id: change.id, value: workflowView(state.document as GroupWorkflow) })
        else { this.direct.push({ kind: 'groupGame', id: change.id, value: null }, { kind: 'groupWorkflow', id: change.id, value: null }) }
        break
      }
      case 'Setting':
        if (change.id === 'connectors') this.slices.add('connectors')
        else if (change.id === 'onboarding') this.slices.add('desktop')
        else if (change.id === 'defaultModel') this.slices.add('runtime')
        else if (change.id.startsWith('groupHealth:')) this.health.add(change.id.slice('groupHealth:'.length))
        break
      case 'Desktop':
        this.slices.add('profile'); this.slices.add('desktop')
        break
      case 'Provider':
        this.slices.add('runtime')
        break
      default:
        return
    }
    this.schedule()
  }

  private schedule(): void {
    if (this.scheduled || this.stopped) return
    this.scheduled = true
    // One flush per turn of the event loop: a burst of writes is one delta.
    queueMicrotask(() => {
      this.scheduled = false
      this.flushing = this.flushing.then(() => this.flush()).catch(() => undefined)
    })
  }

  private async flush(): Promise<void> {
    if (this.stopped) return
    const changes: ProjectionChange[] = this.direct
    this.direct = []
    const agents = [...this.agents], conversations = [...this.conversations], health = [...this.health], slices = new Set(this.slices)
    this.agents.clear(); this.conversations.clear(); this.health.clear(); this.slices.clear()
    for (const id of agents) changes.push({ kind: 'agent', id, value: (await this.repository.agent(id)) ?? null })
    for (const id of conversations) changes.push({ kind: 'conversation', id, value: (await this.repository.conversation(id)) ?? null })
    if (health.length) {
      const groupMemberHealth: NonNullable<AppSnapshot['groupMemberHealth']> = {}
      for (const id of health) {
        const conversation = await this.repository.conversation(id)
        if (conversation?.type === 'group') groupMemberHealth[id] = await this.groupHealth(id, conversation.agentIds)
      }
      changes.push({ kind: 'slice', value: { groupMemberHealth } })
    }
    const slice: Partial<AppSnapshot> = {}
    if (slices.has('profile')) { slice.userName = await this.repository.userName(); slice.userAvatar = await this.repository.userAvatar() }
    if (slices.has('desktop')) slice.desktop = await this.desktopInfo()
    if (slices.has('connectors')) slice.connectors = await this.sources.connectors()
    if (slices.has('runtime')) { const all = await this.repository.agents(); slice.runtime = this.sources.runtimeStatus(all); slice.models = this.sources.availableModels() }
    if (slices.has('ephemeral')) Object.assign(slice, this.sources.ephemeral())
    if (Object.keys(slice).length) changes.push({ kind: 'slice', value: slice })
    if (!changes.length || this.stopped) return
    this.send({ sequence: ++this.sequence, changes })
  }
}
