import { describe, expect, it } from 'vitest'
import { canAssignConversationWorkspace } from './conversationWorkspace'
import type { Conversation } from './types'

const chat = (input: Partial<Conversation>): Conversation => ({ id: 'c', type: 'group', name: 'c', agentIds: [], topics: [], activeTopicId: '', unread: 0, readAt: 0, createdAt: 0, updatedAt: 0, ...input })

describe('canAssignConversationWorkspace', () => {
  it('allows a direct chat with one agent or a group with at least one', () => {
    expect(canAssignConversationWorkspace(chat({ type: 'direct', agentIds: ['codex'] }))).toBe(true)
    expect(canAssignConversationWorkspace(chat({ agentIds: ['codex', 'claude'] }))).toBe(true)
    expect(canAssignConversationWorkspace(chat({ agentIds: ['codex'] }))).toBe(true)
  })
  it('rejects empty chats, malformed direct chats and a missing chat', () => {
    expect(canAssignConversationWorkspace(chat({ agentIds: [] }))).toBe(false)
    expect(canAssignConversationWorkspace(chat({ type: 'direct', agentIds: ['a', 'b'] }))).toBe(false)
    expect(canAssignConversationWorkspace(undefined)).toBe(false)
  })
})
