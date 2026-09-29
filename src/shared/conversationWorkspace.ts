import type { Conversation } from './types'

type Target = Pick<Conversation, 'type' | 'agentIds'>

/** A folder can be assigned to a chat with at least one agent; a direct chat has exactly one. */
export function canAssignConversationWorkspace(conversation: Target | undefined): boolean {
  if (!conversation) return false
  return conversation.agentIds.length > 0 && !(conversation.type === 'direct' && conversation.agentIds.length !== 1)
}
