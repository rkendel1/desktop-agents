import type { AgentConfig, AppSnapshot, AttentionItem, ChatMessage, Conversation, PrivateMessage, Routine, RunEvent, TaskRun } from './types'
import type { GameView } from './groupGame'
import type { GroupWorkflowView } from './groupWorkflow'

/**
 * The renderer holds a projection of the desktop, never the desktop itself.
 * FeltDB announces each durable change; the main process turns it into one of
 * these and sends it, and `applyProjection` folds it into what the renderer shows.
 *
 * A change carries the whole current value of the thing that changed (or `null`
 * once it is gone), so applying the same change twice is harmless and a
 * renderer that restarts needs nothing but a fresh initial snapshot.
 */
export type ProjectionChange =
  | { kind: 'agent'; id: string; value: AgentConfig | null }
  | { kind: 'conversation'; id: string; value: Conversation | null }
  | { kind: 'message'; id: string; value: ChatMessage | null }
  | { kind: 'privateMessage'; id: string; value: PrivateMessage | null }
  | { kind: 'routine'; id: string; value: Routine | null }
  | { kind: 'run'; id: string; value: TaskRun | null }
  | { kind: 'runEvent'; id: string; value: RunEvent | null }
  | { kind: 'attention'; id: string; value: AttentionItem | null }
  | { kind: 'groupGame'; id: string; value: GameView | null }
  | { kind: 'groupWorkflow'; id: string; value: GroupWorkflowView | null }
  /** Whole named parts of the snapshot: settings-derived state and what only exists while the app runs. */
  | { kind: 'slice'; value: Partial<AppSnapshot> }

export interface ProjectionDelta {
  /** Increases by one per delta; lets a renderer that just read an initial snapshot skip what that snapshot already contains. */
  sequence: number
  changes: ProjectionChange[]
}

export interface ProjectionSnapshot {
  snapshot: AppSnapshot
  /** The sequence of the last delta this snapshot reflects. Deltas at or below it are already included. */
  sequence: number
}

const RUNS_SHOWN = 60

function upsert<T extends { id: string }>(list: T[], id: string, value: T | null): T[] {
  const index = list.findIndex(item => item.id === id)
  if (value === null) return index < 0 ? list : list.filter((_item, position) => position !== index)
  if (index < 0) return [...list, value]
  const next = list.slice()
  next[index] = value
  return next
}

/** Keep transcripts in the order things were said, wherever a change lands. */
function insertChronological<T extends { id: string; createdAt: number }>(list: T[], value: T): T[] {
  const existing = list.findIndex(item => item.id === value.id)
  if (existing >= 0) { const next = list.slice(); next[existing] = value; return next }
  let at = list.length
  while (at > 0 && list[at - 1].createdAt > value.createdAt) at--
  return [...list.slice(0, at), value, ...list.slice(at)]
}

const topicKey = (item: { conversationId: string; topicId: string }): string => `${item.conversationId}:${item.topicId}`

export function applyProjection(snapshot: AppSnapshot, changes: ProjectionChange[]): AppSnapshot {
  let next = snapshot
  for (const change of changes) {
    switch (change.kind) {
      case 'agent': {
        const agents = upsert(next.agents, change.id, change.value)
        const agentStatuses = { ...next.agentStatuses }
        if (change.value) agentStatuses[change.id] ??= 'idle'
        else delete agentStatuses[change.id]
        next = { ...next, agents, agentStatuses }
        break
      }
      case 'conversation': {
        const conversations = upsert(next.conversations, change.id, change.value)
        if (change.value) { next = { ...next, conversations }; break }
        const groupMemberHealth = { ...(next.groupMemberHealth ?? {}) }
        delete groupMemberHealth[change.id]
        next = { ...next, conversations, groupMemberHealth,
          messages: next.messages.filter(message => message.conversationId !== change.id),
          privateMessages: next.privateMessages.filter(message => message.conversationId !== change.id),
          activity: next.activity.filter(activity => activity.conversationId !== change.id) }
        break
      }
      case 'message':
        next = { ...next, messages: change.value ? insertChronological(next.messages, change.value) : next.messages.filter(message => message.id !== change.id) }
        break
      case 'privateMessage':
        next = { ...next, privateMessages: change.value ? insertChronological(next.privateMessages, change.value) : next.privateMessages.filter(message => message.id !== change.id) }
        break
      case 'routine':
        next = { ...next, routines: upsert(next.routines, change.id, change.value).sort((a, b) => a.nextRunAt - b.nextRunAt) }
        break
      case 'run': {
        const runs = upsert(next.runs, change.id, change.value).sort((a, b) => b.createdAt - a.createdAt).slice(0, RUNS_SHOWN)
        const shown = new Set(runs.map(run => run.id))
        next = { ...next, runs, runEvents: next.runEvents.filter(event => shown.has(event.runId)) }
        break
      }
      case 'runEvent':
        // Events of runs that are no longer shown stay out; the run's own change decides what is shown.
        if (change.value && !next.runs.some(run => run.id === change.value!.runId)) break
        next = { ...next, runEvents: upsert(next.runEvents, change.id, change.value) }
        break
      case 'attention': {
        const others = (next.attention ?? []).filter(item => item.id !== change.id)
        next = { ...next, attention: change.value && change.value.resolvedAt === undefined ? [change.value, ...others] : others }
        break
      }
      case 'groupGame': {
        const others = (next.groupGames ?? []).filter(game => game.id !== change.id && (!change.value || topicKey(game) !== topicKey(change.value)))
        next = { ...next, groupGames: change.value ? [...others, change.value] : others }
        break
      }
      case 'groupWorkflow': {
        const others = (next.groupWorkflows ?? []).filter(workflow => workflow.id !== change.id && (!change.value || topicKey(workflow) !== topicKey(change.value)))
        next = { ...next, groupWorkflows: change.value ? [...others, change.value] : others }
        break
      }
      case 'slice': {
        const { groupMemberHealth, ...rest } = change.value
        next = { ...next, ...rest, ...(groupMemberHealth ? { groupMemberHealth: { ...(next.groupMemberHealth ?? {}), ...groupMemberHealth } } : {}) }
        break
      }
    }
  }
  return next
}
