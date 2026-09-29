import type { SelectedMention } from './bot/mentions'
import type { DesktopDeviceApi } from './deviceApi'
import type { DesktopDataApi } from './desktopData'
import type { CustomModelConfig, CustomProviderInput, CustomModelTest } from './customModels'
import type { ThinkingLevel } from './thinkingLevels'
import type { AgentPermissions, PermissionRequest } from './agentPermissions'
import type { ProjectionDelta, ProjectionSnapshot } from './projection'
export type AgentStatus = 'idle' | 'thinking' | 'offline'
export type ComputerStatus = 'stopped' | 'starting' | 'ready' | 'working' | 'error'
/** `interrupted`: the app stopped while the run was queued or running, so its outcome is unknown. */
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export type RunTrigger = 'chat' | 'manual' | 'schedule'

export interface LocalAgent {
  id: string
  name: string
  command: string
  /** A launchable CLI with a Douchat conversation adapter is available. */
  installed: boolean
  /** Something belonging to this agent was found, even if it was only a desktop app. */
  discovered: boolean
  path?: string
  desktopPath?: string
  version?: string
  latestVersion?: string
  updateStatus?: 'available' | 'current' | 'unknown'
  chatSupported: boolean
  status: 'ready' | 'desktop-only' | 'not-found'
  /** Authentication is deliberately checked by the CLI when the first chat runs. */
  authentication: 'unchecked'
  /** User-registered commands use the generic prompt-argument/text-output adapter. */
  custom?: boolean
  avatar?: string
  args?: string[]
}

export interface CustomLocalAgentInput {
  name: string
  /** Executable name on PATH or an absolute executable path. Never run through a shell. */
  command: string
  avatar?: string
  /** One argument per entry; custom commands may use {prompt}. */
  args?: string[]
}

export interface AgentConfig {
  /** Local record version. Not a sync cursor. */
  revision?: number
  systemFiles?: import('./agentCustomization').AgentFiles
  skills?: import('./agentCustomization').AgentSkill[]
  followDefaultModel?: boolean
  permissions?: AgentPermissions
  localAgentId?: string
  /** Snapshot of a custom local runtime's display name for durable contact labels. */
  localAgentName?: string

  id: string
  name: string
  /** Optional user-selected picture, stored locally as a compact data URL. */
  avatar?: string
  /** Optional single-grapheme emoji avatar; mutually exclusive with avatar. */
  avatarEmoji?: string
  /** Stable random seed for the built-in illustrated human avatar fallback. */
  avatarSeed?: string
  role: string
  instructions: string
  color: string
  provider: string
  model: string
  /** Reasoning depth; unset follows the default for the execution mode. */
  thinkingLevel?: ThinkingLevel
  /** Free-form labels that colour a bot's greeting and personality. */
  labels?: string
  createdAt: number
}

export interface Topic {
  contextReset?: { id: string; at: number }
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface Conversation {
  /** Local record version. Not a sync cursor. */
  revision?: number
  /** Only unnamed groups follow member names; legacy and explicitly named groups keep their names. */
  autoNamed?: boolean
  avatar?: string
  avatarEmoji?: string
  id: string
  type: 'group' | 'direct'
  name: string
  description?: string
  agentIds: string[]
  /** The visible member that opens and consolidates a group conversation. */
  leadAgentId?: string
  topics: Topic[]
  activeTopicId: string
  /** User-selected folder for local CLI agents. Used only while every member is the owner's local agent. */
  workspacePath?: string
  allowedFolders?: string[]
  savedToContacts?: boolean
  muted?: boolean
  hidden?: boolean
  manuallyUnread?: boolean
  pinned?: boolean
  sortOrder?: number
  unread: number
  readAt: number
  createdAt: number
  updatedAt: number
}

export interface MessageSource {
  kind: 'group' | 'bot'
  id: string
  name: string
  /** The private message that led to this reply. Older stored messages may
   *  only have the sender metadata. */
  content?: string
}

export interface MessageDeliveryReply {
  id: string
  senderId: string
  senderName: string
  content: string
  createdAt: number
  /** Bubbles split from the same recipient turn share this id. */
  replyGroupId?: string
  attachments?: MessageAttachment[]
  error?: string
}

export interface MessageDelivery {
  kind?: 'group-invitation'
  status?: string
  id: string
  recipientId: string
  recipientName: string
  content: string
  replies?: MessageDeliveryReply[]
}

/** A binary asset owned by Douchat. The renderer receives the bytes lazily
 * through IPC instead of exposing arbitrary local file paths. */
export interface MessageAttachment {
  quoted?: boolean
  id: string
  kind: 'image'
  name: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  size: number
}

export interface MessageFileInput {
  name: string
  data: Uint8Array
}

/** An image crossing the isolated renderer/main boundary before Douchat owns it. */
export interface MessageImageInput {
  quoted?: boolean
  name: string
  mimeType: MessageAttachment['mimeType']
  data: Uint8Array
}

/** A code file handed to a short-lived, isolated preview window. */
export interface CodeArtifactInput {
  title: string
  language: string
  code: string
}

export interface EmailConnectorAccount {
  id: string
  kind: 'email'
  name: string
  email: string
  username: string
  imapHost: string
  imapPort: number
  imapSecure: boolean
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  agentIds: string[]
  status: 'connected' | 'error'
  error?: string
  updatedAt: number
}

export interface EmailConnectorInput {
  id?: string
  name: string
  email: string
  username: string
  password?: string
  imapHost: string
  imapPort: number
  imapSecure: boolean
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  agentIds: string[]
}

export interface EmailConnectionTestResult {
  ok: boolean
  imap: { ok: boolean; error?: string }
  smtp: { ok: boolean; error?: string }
}

export interface ChatMessage {
  /** Incoming transport; absent for desktop and older messages without provenance. */
  sourceChannel?: import('./imChannels').IMProvider
  contextVersion?: string
  /** Localizable application notice; user and agent text never carry this. */
  localization?: import('./groupText').GroupNotice
  deliveryState?: 'sending' | 'confirming' | 'failed'
  id: string
  conversationId: string
  topicId: string
  authorId: 'user' | 'system' | string
  authorName: string
  text: string
  kind: 'message' | 'handoff' | 'system'
  createdAt: number
  /** @mention targets resolved when the message was written. */
  recipients?: { id: string; name: string }[]
  /** Bubbles split out of one model turn share this id. */
  replyGroupId?: string
  /** A private delivery that arrived here from a group or another bot. */
  source?: MessageSource
  /** Private or agent-to-agent envelopes this message sent out. */
  deliveries?: MessageDelivery[]
  /** Files produced by this model turn and copied into Douchat storage. */
  attachments?: MessageAttachment[]
  /** Human-readable receipts for tools that performed this reply's work. */
  actions?: MessageAction[]
  error?: string
  /** The raw failure a system message was summarised from, kept for details. */
  detail?: string
}

export interface MessageAction {
  /** The provider's tool-call id; unique within the model turn. */
  id: string
  /** Stable internal tool name. The renderer turns this into product copy. */
  tool: string
  status: 'running' | 'succeeded' | 'failed'
  /** A safe display target such as a filename, never the full argument payload. */
  target?: string
}

export interface PrivateMessage {
  contextVersion?: string
  intent?: 'inform' | 'request'
  id: string
  conversationId: string
  topicId: string
  sender: { id: string; name: string }
  recipient: { id: string; name: string }
  content: string
  createdAt: number
}

export interface RuntimeStatus {
  mode: 'live' | 'offline'
  label: string
  error?: string
}

export interface ModelOption {
  provider: string
  model: string
  label: string
}

export type ConversationPhase = 'planning' | 'replying' | 'greeting' | 'delivering'

export interface ConversationActivityState {
  planningStage?: 'health' | 'decision' | 'plan' | 'recovery'
  serviceName?: string
  localProgress?: {
    phase: 'connecting' | 'ready' | 'working' | 'waiting' | 'approval'
    elapsedSeconds: number
    silentSeconds: number
    detail?: string
  }
  conversationId: string
  topicId: string
  phase: ConversationPhase
  agentIds: string[]
  label: string
  startedAt: number
  /** The concrete tool action currently visible to the human. */
  action?: MessageAction
  /** A failed lead handed the conversation to this member. */
  takeover?: { unavailableName: string; replacementName: string }
  limited?: boolean
  failed?: boolean
}

export interface ComputerSession {
  id: string
  agentId: string
  status: ComputerStatus
  url: string
  title: string
  previewDataUrl?: string
  lastAction?: string
  error?: string
  updatedAt: number
}

export type RoutineSchedule =
  | {
      kind: 'once'
      runAt: number
    }
  | {
      kind: 'interval'
      intervalMinutes: number
    }
  | {
      kind: 'weekly'
      days: number[]
      time: string
    }

export interface Routine {
  id: string
  name: string
  agentId: string
  conversationId: string
  prompt: string
  target: 'local'
  schedule: RoutineSchedule
  timezone: string
  enabled: boolean
  nextRunAt: number
  lastRunAt?: number
  createdAt: number
  updatedAt: number
}

export interface CreateRoutineInput {
  name: string
  agentId: string
  conversationId: string
  prompt: string
  schedule: RoutineSchedule
  timezone: string
}

export interface TaskRun {
  id: string
  agentId: string
  conversationId: string
  routineId?: string
  title: string
  prompt: string
  target: 'local'
  trigger: RunTrigger
  status: RunStatus
  latestActivity?: string
  error?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
}

/** The execution lifecycle FeltDB records for every run. */
export type ExecutionEventKind = 'queued' | 'running' | 'tool_call' | 'tool_result' | 'message_delta' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export interface RunEvent {
  id: string
  runId: string
  /** How the UI groups the event; `kind` is the durable lifecycle stage. */
  type: 'status' | 'tool'
  kind?: ExecutionEventKind
  label: string
  detail?: string
  status?: RunStatus
  createdAt: number
}

/** Something the desktop is holding for the person to look at, such as a run that was cut short. */
export interface AttentionItem {
  id: string
  kind: 'interrupted-run' | 'provider-setup' | 'migration'
  title: string
  detail?: string
  sessionId?: string
  runId?: string
  createdAt: number
  resolvedAt?: number
}

/** Facts about the local desktop itself. */
export interface DesktopInfo {
  /** The welcome screen is optional; once dismissed or completed it stays away. */
  onboardingCompleted: boolean
  /** FeltDB's durable state directory. */
  databaseDirectory: string
  migration?: { status: 'complete' | 'not-needed' | 'failed'; imported: Record<string, number>; skipped: Record<string, number>; error?: string }
}

export interface AppSnapshot {
  desktop?: DesktopInfo
  /** Unresolved attention items, newest first. */
  attention?: AttentionItem[]
  groupMemberHealth?: Record<string, Record<string, { status: 'healthy' | 'unknown' | 'unavailable'; checkedAt: number }>>
  groupGames?: import('./groupGame').GameView[]
  groupWorkflows?: import('./groupWorkflow').GroupWorkflowView[]
  permissionRequests?: PermissionRequest[]
  projects?: Project[]
  codingSessions?: CodingSession[]
  /** Live state of running coding sessions. */
  codingActivity?: CodingActivity[]
  agents: AgentConfig[]
  agentStatuses: Record<string, AgentStatus>
  conversations: Conversation[]
  messages: ChatMessage[]
  privateMessages: PrivateMessage[]
  activity: ConversationActivityState[]
  computers: ComputerSession[]
  routines: Routine[]
  runs: TaskRun[]
  runEvents: RunEvent[]
  runtime: RuntimeStatus
  models: ModelOption[]
  connectors: EmailConnectorAccount[]
  userName: string
  /** The picture the user chose, already downscaled, as a data URL. */
  userAvatar: string
}

export interface CreateAgentInput {
  systemFiles?: import('./agentCustomization').AgentFiles
  thinkingLevel?: ThinkingLevel | 'default'
  customModel?: { providerId: string; model: string }
  localAgentId?: string
  localAgentName?: string

  name: string
  avatar?: string
  avatarEmoji?: string
  role: string
  instructions: string
  color: string
  labels?: string
}

/** Provider/model bindings are resolved by the main process. Built-in cloud contacts
 * remain service-owned; custom selections are validated against saved providers. */
export type ResolvedCreateAgentInput = Omit<CreateAgentInput, 'thinkingLevel'> & Pick<AgentConfig, 'provider' | 'model' | 'followDefaultModel' | 'thinkingLevel'>

export interface UpdateAgentInput {
  /** Reject a stale edit when a caller supplies its last observed version. */
  expectedRevision?: number
  expectedSystemFiles?: import('./agentCustomization').AgentFiles
  /** 'default' clears the override. */
  thinkingLevel?: ThinkingLevel | 'default'
  systemFiles?: import('./agentCustomization').AgentFiles
  skills?: import('./agentCustomization').AgentSkill[]
  followDefaultModel?: boolean
  customModel?: { providerId: string; model: string }
  permissions?: AgentPermissions
  localAgentId?: string
  localAgentName?: string

  name?: string
  avatar?: string
  avatarEmoji?: string
  role?: string
  instructions?: string
  color?: string
  provider?: string
  model?: string
  labels?: string
}

export interface CreateGroupInput {
  name: string
  description?: string
  agentIds: string[]
  leadAgentId?: string
}

export interface UpdateConversationInput {
  /** Reject a stale edit when a caller supplies its last observed version. */
  expectedRevision?: number
  avatar?: string
  avatarEmoji?: string
  savedToContacts?: boolean
  muted?: boolean
  hidden?: boolean
  manuallyUnread?: boolean
  name?: string
  description?: string
  agentIds?: string[]
  leadAgentId?: string
}

export interface UpdateProfileInput {
  name?: string
  /** A downscaled picture as a data URL. */
  image?: string
}

export type UpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  availableVersion?: string
  releaseNotes?: string
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
  busyTasks?: number
  error?: string
}

export interface DouchatApi extends DesktopDataApi, DesktopDeviceApi {
  listIMChannels(agentId: string): Promise<import('./imChannels').IMChannel[]>
  connectIMChannel(agentId: string, input: import('./imChannels').IMConnectInput): Promise<void>
  disconnectIMChannel(agentId: string, provider: import('./imChannels').IMProvider): Promise<void>
  startIMLogin(agentId: string): Promise<import('./imChannels').IMLogin>
  cancelIMLogin(agentId: string, sessionId: string): Promise<void>
  pollIMLogin(agentId: string, sessionId: string): Promise<import('./imChannels').IMLoginStatus>

  setInterfaceLanguage: (language: string) => Promise<void>
  updateProfile: (input: UpdateProfileInput) => Promise<void>
  completeOnboarding: () => Promise<void>
  resolveAttention: (id: string) => Promise<void>
  getUpdateState: () => Promise<UpdateState>
  checkForUpdates: () => Promise<UpdateState>
  installUpdate: () => Promise<UpdateState>
  listLocalAgentModels: (agentId: string) => Promise<import('./localModels').LocalModelList>
  detectLocalAgents: () => Promise<LocalAgent[]>
  maintainLocalAgent: (id: string) => Promise<boolean>
  openLocalAgentTerminal: (id: 'claude') => Promise<{ terminal: 'termany' | 'system' }>
  addCustomLocalAgent: (input: CustomLocalAgentInput) => Promise<LocalAgent[]>
  updateLocalAgent: (id: string, input: CustomLocalAgentInput) => Promise<LocalAgent[]>
  testLocalAgent: (id: string | undefined, input: CustomLocalAgentInput) => Promise<{ reply: string; durationMs: number; version?: string }>
  cancelLocalAgentTest: () => Promise<void>
  removeCustomLocalAgent: (id: string) => Promise<LocalAgent[]>
  getAttachmentData: (attachmentId: string) => Promise<string>
  getSnapshot: () => Promise<ProjectionSnapshot>
  authorizeTokenDance: () => Promise<string>
  cancelTokenDanceAuthorization: () => Promise<void>
  getCustomModels: () => Promise<CustomModelConfig>
  detectOllama: () => Promise<CustomProviderInput | null>
  getDecisionSettings: () => Promise<import('./groupDecision').DecisionSettings>
  saveDecisionSettings: (settings: import('./groupDecision').DecisionSettings) => Promise<import('./groupDecision').DecisionSettings>
  testDecisionSettings: (settings: import('./groupDecision').DecisionSettings) => Promise<{ ok: boolean; error?: string }>
  saveCustomModels: (providers: CustomProviderInput[], defaultModel: string) => Promise<CustomModelConfig>
  testCustomModel: (input: CustomModelTest) => Promise<{ ok: boolean; error?: string; model?: string }>
  createAgent: (input: CreateAgentInput) => Promise<{ agentId: string; conversationId?: string }>
  resolveAgentPermission: (id: string, allow: import('./agentPermissions').PermissionApproval) => Promise<void>
  exportAgentArchive: (agentId: string) => Promise<boolean>
  parseAgentArchive: (data: Uint8Array, root?: string) => Promise<import('./agentArchive').AgentArchivePreview>
  parseSkillArchive: (data: Uint8Array) => Promise<import('./agentCustomization').AgentSkill[]>
  updateAgent: (agentId: string, input: UpdateAgentInput) => Promise<void>
  deleteAgent: (agentId: string) => Promise<void>
  startDirectChat: (agentId: string) => Promise<{ conversationId: string }>
  createGroup: (input: CreateGroupInput) => Promise<{ conversationId: string }>
  updateConversation: (conversationId: string, input: UpdateConversationInput) => Promise<void>
  /** Opens a folder picker; resolves unchanged if cancelled. */
  openConversationWorkspace: (conversationId: string) => Promise<void>
  chooseConversationWorkspace: (conversationId: string) => Promise<void>
  clearConversationWorkspace: (conversationId: string) => Promise<void>
  openCodeArtifact: (input: CodeArtifactInput) => Promise<void>
  getCodeArtifact: (artifactId: string) => Promise<CodeArtifactInput | null>
  testEmailConnector: (input: EmailConnectorInput) => Promise<EmailConnectionTestResult>
  saveEmailConnector: (input: EmailConnectorInput) => Promise<void>
  disconnectEmailConnector: (connectorId: string) => Promise<void>
  deleteMessage: (conversationId: string, messageId: string) => Promise<boolean>
  deleteConversation: (conversationId: string) => Promise<void>
  setConversationPinned: (conversationId: string, pinned: boolean) => Promise<void>
  markConversationRead: (conversationId: string) => Promise<void>
  markAllConversationsRead: () => Promise<void>
  createTopic: (conversationId: string) => Promise<void>
  renameTopic: (conversationId: string, topicId: string, title: string) => Promise<void>
  deleteTopic: (conversationId: string, topicId: string) => Promise<void>
  setActiveTopic: (conversationId: string, topicId: string) => Promise<void>
  sendMessage: (conversationId: string, text: string, images?: MessageImageInput[], files?: MessageFileInput[], mentions?: SelectedMention[]) => Promise<void>
  stopConversation: (conversationId: string) => Promise<void>
  clearConversation: (conversationId: string) => Promise<void>
  resetConversationContext: (conversationId: string) => Promise<void>
  createRoutine: (input: CreateRoutineInput) => Promise<void>
  deleteRoutine: (routineId: string) => Promise<void>
  setRoutineEnabled: (routineId: string, enabled: boolean) => Promise<void>
  runRoutineNow: (routineId: string) => Promise<void>
  startComputer: (agentId: string) => Promise<void>
  stopComputer: (agentId: string) => Promise<void>
  showComputer: (agentId: string) => Promise<void>
  onUpdateState: (listener: (state: UpdateState) => void) => () => void
  /** Each durable or live change, as a small delta. A renderer reads `getSnapshot` once, then applies deltas whose sequence is newer. */
  onProjection: (listener: (delta: ProjectionDelta) => void) => () => void
  listProjects: () => Promise<Project[]>
  /** Opens a folder picker; resolves with the project, or undefined if cancelled. */
  chooseProject: () => Promise<Project | undefined>
  removeProject: (id: string) => Promise<boolean>
  projectGitStatus: (id: string) => Promise<GitState>
  projectGitDiff: (id: string, path?: string) => Promise<{ diff: string; truncated: boolean }>
  listCodingSessions: (projectId?: string) => Promise<CodingSession[]>
  startCodingSession: (input: { projectId: string; agentId: string; task: string }) => Promise<CodingSession>
  cancelCodingSession: (id: string) => Promise<void>
  continueCodingSession: (id: string, text?: string) => Promise<CodingSession>
  runCodingChecks: (id: string) => Promise<CommandResult | undefined>
  /** Asks the owner to confirm before saving: the command runs on this computer. */
  setProjectTestCommand: (id: string, commandLine: string) => Promise<Project | undefined>
}

/**
 * A folder on this computer that agents may work in. The repository at `path` is
 * the authority for source code; Douchat stores only that the project exists.
 */
export interface Project {
  /** Stable for a path: the same folder is the same project. */
  id: string
  name: string
  /** Absolute, resolved. */
  path: string
  isGit: boolean
  /** Owner-chosen check to run in the project, as an argument vector (never a shell string). */
  testCommand?: string[]
  createdAt: number
  updatedAt: number
}

/** One path's state in `git status --porcelain`. No file contents are ever stored. */
export interface GitChange {
  path: string
  /** Porcelain XY code, e.g. ' M', 'M ', '??', 'A ', ' D'. */
  code: string
  /** Original path for a rename or copy. */
  from?: string
  /** Identifies the file's content when the state was read (content hash, or size and time for a large file). Absent for deleted files. */
  fingerprint?: string
  /**
   * Set on a session's final changes. `before`: dirty in the same way when the session started.
   * `session`: not dirty at the start, or dirty in a different way, so something changed it while the
   * session was running. Git cannot say *who* — the agent, a person, or a tool — only when.
   */
  origin?: 'before' | 'session'
}

export interface GitState {
  /** Current branch, or undefined when detached or unborn. */
  branch?: string
  head?: string
  changes: GitChange[]
}

export interface CommandResult {
  argv: string[]
  /** null when the process was stopped by a signal. */
  exitCode: number | null
  signal?: string
  cancelled?: boolean
  timedOut?: boolean
  startedAt: number
  durationMs: number
  /** The end of each stream, bounded. */
  stdout: string
  stderr: string
}

export type CodingSessionStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'

/**
 * An agent working on a project: which project, which agent, the explicit
 * working directory, the chat that carries the conversation and its events, and
 * the outcome. The OS process is not part of it and does not survive a restart.
 */
export interface CodingSession {
  id: string
  projectId: string
  agentId: string
  /** The conversation (and topic) holding the messages and run events of this session. */
  conversationId: string
  topicId: string
  workingDirectory: string
  task: string
  status: CodingSessionStatus
  error?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  runId?: string
  /** The agent's final reply. */
  result?: string
  /** Repository state when the session began, and what changed by the end. */
  baseline: GitState
  changes: GitChange[]
  /** Paths that were dirty when the session started and are clean now. */
  cleaned?: string[]
  /** HEAD when the session last ended, to show whether commits were made meanwhile. */
  finalHead?: string
  /** Checks Douchat ran in the project for this session. */
  commands: CommandResult[]
  /** What happened, in order: meaningful outcomes only (never every progress tick). Bounded. */
  events: CodingEvent[]
}

export type CodingEventKind = 'started' | 'continued' | 'approval-requested' | 'approval-allowed' | 'approval-denied' | 'command' | 'checks' | 'changes' | 'finished' | 'interrupted'

export interface CodingEvent {
  at: number
  kind: CodingEventKind
  label: string
  detail?: string
}

/**
 * What a running session is doing right now. Live state only: it exists while the
 * app runs and is never stored; the durable outcome is the session and its events.
 */
export interface CodingActivity {
  sessionId: string
  state: 'running' | 'awaiting-approval'
  /** What the agent is doing, in words. */
  label: string
  /**
   * Where `label` comes from, so a screen never shows more than is known: `agent` — the CLI reported it itself
   * (a tool it is running, a step it is on); `douchat` — Douchat knows it (an approval, a check it is running);
   * `none` — the agent has reported nothing, and the label is only that it is running.
   */
  source: 'agent' | 'douchat' | 'none'
  since: number
  /** Present while the session waits for the owner to decide. */
  approval?: PermissionRequest
}
