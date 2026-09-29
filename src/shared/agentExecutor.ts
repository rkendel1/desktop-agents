import type { AgentConfig, LocalAgent, MessageAttachment } from './types'

export interface LocalProgress {
  phase: 'connecting' | 'ready' | 'working' | 'waiting' | 'approval'
  elapsedSeconds: number
  silentSeconds: number
  detail?: string
}
export type ProgressListener = (progress: LocalProgress) => void
/** Host-generated lifetime, never accepted from model arguments or renderer IPC. */
export interface NativeAppSession {
  id: string
  appId: string
  appName: string
  signal: AbortSignal
}
export interface LocalToolApproval { message: string; details: string; nativeSession?: NativeAppSession }
export type LocalApprovalHandler = (request: LocalToolApproval, signal: AbortSignal) => Promise<void>

export interface LocalAgentImage {
  name: string
  mimeType: MessageAttachment['mimeType']
  data: Uint8Array
}

export interface LocalAgentReply {
  text: string
  images: LocalAgentImage[]
}

export interface LocalRunOptions {
  /** Validated, unsaved settings used only by the connection test. */
  agentOverride?: LocalAgent
  /** Read-only controllers must not gain image generation through MCP. */
  imageToolsAllowed?: boolean
  /** Validated user-selected folder for this chat. */
  workspaceDirectory?: string
  sessionKey?: string
  /** Internal planning/probes must not retain workspace or thread history. */
  transient?: boolean
  /** Full transcript is needed only when a connection is cold. */
  continuationPrompt?: string
  onProgress?: ProgressListener
  onApproval?: LocalApprovalHandler
  /** Internal retry for the specific Claude account-login configuration conflict. */
  claudeAccountLogin?: boolean
  /** Retry only a rejected resume, before any model turn can have executed. */
  freshSessionRetry?: boolean
}
/** Device execution boundary. Implementations own their sessions and lifecycle.
 * Transport, authentication and routing remain responsibilities of the host. */
export interface AgentExecutor {
  run(config: AgentConfig, prompt: string, signal?: AbortSignal, images?: LocalAgentImage[], options?: LocalRunOptions): Promise<LocalAgentReply>
  releaseIdleConnections?(conversationId: string, directAgentIds?: string[]): void
  disposeAgent(agentId: string): void
  resetConversation(conversationId: string, topicId?: string, directAgentIds?: string[]): Promise<void>
}
