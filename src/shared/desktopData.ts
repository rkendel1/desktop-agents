import type { ChatMessage } from './types'
import type { UserMemoryDocument } from './userMemory'

/** Transport-neutral access to the desktop's durable memory and transcripts.
 * The main process is the only implementation; the renderer is a projection. */
export interface DesktopDataApi {
  getGroupMemory(conversationId: string): Promise<UserMemoryDocument>
  saveGroupMemory(document: UserMemoryDocument, conversationId: string): Promise<UserMemoryDocument>
  getUserMemory(agentId?: string): Promise<UserMemoryDocument>
  saveUserMemory(document: UserMemoryDocument, agentId?: string): Promise<UserMemoryDocument>
  searchMessages(conversationId: string, query: string): Promise<ChatMessage[]>
  getMessagePage(conversationId: string, topicId: string, before?: string): Promise<{ messages: ChatMessage[]; hasMore: boolean }>
}
