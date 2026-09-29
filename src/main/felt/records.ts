import type { CodingSession, Project, AgentConfig, ExecutionEventKind, ChatMessage, Conversation, PrivateMessage, RunEvent, Routine, TaskRun, Topic } from '../../shared/types'

/** The stored shapes declared in desktop.flow, and the domain types they compose. */

export interface AgentRecord {
  id: string; name: string; provider: string; model: string; createdAt: number
  revision?: number; localAgentId?: string; config?: Record<string, unknown>
}
export interface AgentProfileRecord {
  id: string; agentId: string; files?: { systemFiles?: AgentConfig['systemFiles']; skills?: AgentConfig['skills'] }; updatedAt: number
}
export interface SessionRecord {
  id: string; kind: 'direct' | 'group'; title: string; status: 'active' | 'hidden'
  agentId?: string; workspaceId?: string; provider?: string; model?: string
  activeTopicId: string; createdAt: number; updatedAt: number; revision?: number
  meta?: Record<string, unknown>
}
export interface TopicRecord {
  id: string; topicId: string; sessionId: string; title: string; createdAt: number; updatedAt: number
  contextResetId?: string; contextResetAt?: number
}
export interface GroupRecord { id: string; sessionId: string; name: string; description?: string; leadAgentId?: string; autoNamed?: boolean }
export interface GroupMemberRecord { id: string; groupId: string; agentId: string; position: number }
/** A folder on this computer. With a `name` it is a registered project. */
export interface WorkspaceRecord { id: string; path: string; createdAt: number; name?: string; isGit?: boolean; testCommand?: string[]; updatedAt?: number }
export interface AgentProcessRow { id: string; pid: number; role: 'agent' | 'connection' | 'command'; identity: string; cwd?: string; startedAt: number }
export interface LocalAgentDefinitionRecord { id: string; name: string; command: string; args?: string[]; avatar?: string; position: number; updatedAt: number }
export interface CodingSessionRecord {
  id: string; workspaceId: string; agentId: string; sessionId: string; topicId: string; cwd: string; task: string; status: string
  createdAt: number; startedAt?: number; finishedAt?: number; runId?: string; error?: string; result?: string
  baseline?: unknown; changes?: unknown; commands?: unknown; events?: unknown; cleaned?: string[]; finalHead?: string
}
export interface MessageRecord {
  id: string; sessionId: string; topicId: string; role: 'user' | 'assistant' | 'system'
  authorId: string; authorName: string; content: string; kind: string; timestamp: number
  metadata?: Record<string, unknown>
}
export interface PrivateMessageRecord {
  id: string; sessionId: string; topicId: string; senderId: string; recipientId: string
  content: string; timestamp: number; metadata?: Record<string, unknown>
}
export interface RunRecord {
  id: string; agentId: string; sessionId: string; scheduleId?: string; status: string; title: string
  createdAt: number; startedAt?: number; finishedAt?: number; metadata?: Record<string, unknown>
}
export interface ExecutionEventRecord {
  id: string; runId: string; sessionId?: string; type: string; label: string; status?: string; detail?: string; timestamp: number
}
export interface ScheduleRecord {
  id: string; agentId: string; sessionId: string; name: string; enabled: boolean
  nextRunAt: number; createdAt: number; updatedAt: number; definition: Record<string, unknown>
}
export interface AttachmentRecord {
  id: string; kind: 'image' | 'document'; name: string; size: number; mimeType?: string; blob: string; createdAt: number
}

export function agentToRecord(agent: AgentConfig): { agent: AgentRecord; profile?: AgentProfileRecord } {
  const { id, name, provider, model, createdAt, revision, localAgentId, systemFiles, skills, ...config } = agent
  const profile = systemFiles || skills
    ? { id, agentId: id, files: { ...(systemFiles ? { systemFiles } : {}), ...(skills ? { skills } : {}) }, updatedAt: Date.now() }
    : undefined
  return {
    agent: { id, name, provider, model, createdAt, ...(revision !== undefined ? { revision } : {}), ...(localAgentId ? { localAgentId } : {}), config },
    profile
  }
}

export function agentFromRecord(record: AgentRecord, profile?: AgentProfileRecord): AgentConfig {
  return {
    ...(record.config ?? {}),
    ...(profile?.files?.systemFiles ? { systemFiles: profile.files.systemFiles } : {}),
    ...(profile?.files?.skills ? { skills: profile.files.skills } : {}),
    id: record.id, name: record.name, provider: record.provider, model: record.model, createdAt: record.createdAt,
    ...(record.revision !== undefined ? { revision: record.revision } : {}),
    ...(record.localAgentId ? { localAgentId: record.localAgentId } : {})
  } as AgentConfig
}

export function messageToRecord(message: ChatMessage): MessageRecord {
  const { id, conversationId, topicId, authorId, authorName, text, kind, createdAt, ...metadata } = message
  return {
    id, sessionId: conversationId, topicId,
    role: authorId === 'user' ? 'user' : authorId === 'system' || kind === 'system' ? 'system' : 'assistant',
    authorId, authorName, content: text, kind, timestamp: createdAt,
    ...(Object.keys(metadata).length ? { metadata } : {})
  }
}

export function messageFromRecord(record: MessageRecord): ChatMessage {
  return {
    ...(record.metadata ?? {}),
    id: record.id, conversationId: record.sessionId, topicId: record.topicId,
    authorId: record.authorId, authorName: record.authorName, text: record.content,
    kind: record.kind as ChatMessage['kind'], createdAt: record.timestamp
  }
}

export function privateMessageToRecord(message: PrivateMessage): PrivateMessageRecord {
  const { id, conversationId, topicId, sender, recipient, content, createdAt, ...rest } = message
  return {
    id, sessionId: conversationId, topicId, senderId: sender.id, recipientId: recipient.id, content, timestamp: createdAt,
    metadata: { sender, recipient, ...rest }
  }
}

export function privateMessageFromRecord(record: PrivateMessageRecord): PrivateMessage {
  const { sender, recipient, ...rest } = (record.metadata ?? {}) as { sender: PrivateMessage['sender']; recipient: PrivateMessage['recipient'] }
  return {
    ...rest, id: record.id, conversationId: record.sessionId, topicId: record.topicId,
    sender, recipient, content: record.content, createdAt: record.timestamp
  }
}

export function topicToRecord(sessionId: string, topic: Topic): TopicRecord {
  return {
    id: `${sessionId}/${topic.id}`, topicId: topic.id, sessionId, title: topic.title, createdAt: topic.createdAt, updatedAt: topic.updatedAt,
    ...(topic.contextReset ? { contextResetId: topic.contextReset.id, contextResetAt: topic.contextReset.at } : {})
  }
}

export function topicFromRecord(record: TopicRecord): Topic {
  return {
    id: record.topicId, title: record.title, createdAt: record.createdAt, updatedAt: record.updatedAt,
    ...(record.contextResetId !== undefined ? { contextReset: { id: record.contextResetId, at: record.contextResetAt ?? 0 } } : {})
  }
}

export function conversationParts(conversation: Conversation, workspaceId: string | undefined, binding?: { provider: string; model: string }): {
  session: SessionRecord; group?: GroupRecord; members: GroupMemberRecord[]; topics: TopicRecord[]
} {
  const { id, type, name, agentIds, leadAgentId, description, autoNamed, topics, activeTopicId, workspacePath: _workspacePath, revision, createdAt, updatedAt, ...meta } = conversation
  const session: SessionRecord = {
    id, kind: type, title: name, status: conversation.hidden ? 'hidden' : 'active',
    ...(type === 'direct' && agentIds[0] ? { agentId: agentIds[0] } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(binding ? { provider: binding.provider, model: binding.model } : {}),
    activeTopicId, createdAt, updatedAt, ...(revision !== undefined ? { revision } : {}),
    meta
  }
  return {
    session,
    group: type === 'group'
      ? { id, sessionId: id, name, ...(description !== undefined ? { description } : {}), ...(leadAgentId ? { leadAgentId } : {}), ...(autoNamed !== undefined ? { autoNamed } : {}) }
      : undefined,
    members: type === 'group' ? agentIds.map((agentId, position) => ({ id: `${id}:${agentId}`, groupId: id, agentId, position })) : [],
    topics: topics.map(topic => topicToRecord(id, topic))
  }
}

export function conversationFromParts(input: {
  session: SessionRecord; group?: GroupRecord; members: GroupMemberRecord[]; topics: TopicRecord[]; workspacePath?: string
}): Conversation {
  const { session, group, members, topics, workspacePath } = input
  return {
    ...((session.meta ?? {}) as Partial<Conversation>),
    id: session.id, type: session.kind, name: session.title,
    ...(group?.description !== undefined ? { description: group.description } : {}),
    agentIds: session.kind === 'direct' ? (session.agentId ? [session.agentId] : []) : [...members].sort((a, b) => a.position - b.position).map(member => member.agentId),
    ...(group?.leadAgentId ? { leadAgentId: group.leadAgentId } : {}),
    ...(group?.autoNamed !== undefined ? { autoNamed: group.autoNamed } : {}),
    topics: topics.map(topicFromRecord), activeTopicId: session.activeTopicId,
    ...(workspacePath ? { workspacePath } : {}),
    ...(session.revision !== undefined ? { revision: session.revision } : {}),
    createdAt: session.createdAt, updatedAt: session.updatedAt
  } as Conversation
}

export function routineToRecord(routine: Routine): ScheduleRecord {
  const { id, agentId, conversationId, name, enabled, nextRunAt, createdAt, updatedAt, ...definition } = routine
  return { id, agentId, sessionId: conversationId, name, enabled, nextRunAt, createdAt, updatedAt, definition }
}

export function routineFromRecord(record: ScheduleRecord): Routine {
  return {
    ...(record.definition as Partial<Routine>),
    id: record.id, agentId: record.agentId, conversationId: record.sessionId, name: record.name,
    enabled: record.enabled, nextRunAt: record.nextRunAt, createdAt: record.createdAt, updatedAt: record.updatedAt
  } as Routine
}

export function runToRecord(run: TaskRun): RunRecord {
  const { id, agentId, conversationId, routineId, status, title, createdAt, startedAt, finishedAt, ...metadata } = run
  return {
    id, agentId, sessionId: conversationId, ...(routineId ? { scheduleId: routineId } : {}), status, title, createdAt,
    ...(startedAt !== undefined ? { startedAt } : {}), ...(finishedAt !== undefined ? { finishedAt } : {}), metadata
  }
}

export function runFromRecord(record: RunRecord): TaskRun {
  return {
    ...(record.metadata ?? {}),
    id: record.id, agentId: record.agentId, conversationId: record.sessionId,
    ...(record.scheduleId ? { routineId: record.scheduleId } : {}),
    status: record.status as TaskRun['status'], title: record.title, createdAt: record.createdAt,
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {})
  } as TaskRun
}

/** A run event's place in the durable execution lifecycle. */
export function lifecycleKind(event: Pick<RunEvent, 'type' | 'status' | 'label' | 'kind'>): ExecutionEventKind {
  if (event.kind) return event.kind
  if (event.type === 'tool') return /\b(?:succeeded|failed)$/.test(event.label) ? 'tool_result' : 'tool_call'
  switch (event.status) {
    case 'queued': return 'queued'
    case 'succeeded': return 'completed'
    case 'failed': return 'failed'
    case 'cancelled': return 'cancelled'
    case 'interrupted': return 'interrupted'
    default: return 'running'
  }
}

export function eventToRecord(event: RunEvent, sessionId?: string): ExecutionEventRecord {
  return {
    id: event.id, runId: event.runId, ...(sessionId ? { sessionId } : {}), type: lifecycleKind(event), label: event.label,
    ...(event.status ? { status: event.status } : {}), ...(event.detail !== undefined ? { detail: event.detail } : {}), timestamp: event.createdAt
  }
}

export function eventFromRecord(record: ExecutionEventRecord): RunEvent {
  return {
    id: record.id, runId: record.runId, kind: record.type as ExecutionEventKind,
    type: ['tool_call', 'tool_result'].includes(record.type) ? 'tool' : 'status', label: record.label,
    ...(record.detail !== undefined ? { detail: record.detail } : {}),
    ...(record.status ? { status: record.status as RunEvent['status'] } : {}), createdAt: record.timestamp
  }
}

export function projectFromRecord(record: WorkspaceRecord): Project {
  return { id: record.id, name: record.name ?? record.path, path: record.path, isGit: record.isGit === true,
    ...(record.testCommand ? { testCommand: record.testCommand } : {}), createdAt: record.createdAt, updatedAt: record.updatedAt ?? record.createdAt }
}

export function codingSessionToRecord(session: CodingSession): CodingSessionRecord {
  return { id: session.id, workspaceId: session.projectId, agentId: session.agentId, sessionId: session.conversationId, topicId: session.topicId,
    cwd: session.workingDirectory, task: session.task, status: session.status, createdAt: session.createdAt,
    ...(session.startedAt !== undefined ? { startedAt: session.startedAt } : {}), ...(session.finishedAt !== undefined ? { finishedAt: session.finishedAt } : {}),
    ...(session.runId ? { runId: session.runId } : {}), ...(session.error ? { error: session.error } : {}), ...(session.result ? { result: session.result } : {}),
    baseline: session.baseline, changes: session.changes, commands: session.commands, events: session.events,
    ...(session.cleaned ? { cleaned: session.cleaned } : {}), ...(session.finalHead ? { finalHead: session.finalHead } : {}) }
}

export function codingSessionFromRecord(record: CodingSessionRecord): CodingSession {
  return { id: record.id, projectId: record.workspaceId, agentId: record.agentId, conversationId: record.sessionId, topicId: record.topicId,
    workingDirectory: record.cwd, task: record.task, status: record.status as CodingSession['status'], createdAt: record.createdAt,
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}), ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
    ...(record.runId ? { runId: record.runId } : {}), ...(record.error ? { error: record.error } : {}), ...(record.result ? { result: record.result } : {}),
    baseline: (record.baseline as CodingSession['baseline']) ?? { changes: [] }, changes: (record.changes as CodingSession['changes']) ?? [],
    commands: (record.commands as CodingSession['commands']) ?? [], events: (record.events as CodingSession['events']) ?? [],
    ...(record.cleaned ? { cleaned: record.cleaned } : {}), ...(record.finalHead ? { finalHead: record.finalHead } : {}) }
}
