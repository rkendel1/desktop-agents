import type { DesktopDataApi } from '../shared/desktopData'
import type { UserMemoryDocument } from '../shared/userMemory'
import type { DesktopRepository } from './desktopRepository'

/** The main process's implementation of the renderer's data API. Everything is read from and written to FeltDB. */
export class LocalDesktopData implements DesktopDataApi {
  constructor(private readonly store: DesktopRepository) {}

  private async authorize(conversationId?: string): Promise<void> {
    if (conversationId !== undefined && !(await this.store.conversation(conversationId))) throw new Error('Chat not found')
  }

  async getUserMemory(agentId?: string) {
    return this.store.userMemories.read(agentId)
  }
  async saveUserMemory(document: UserMemoryDocument, agentId?: string) {
    return this.store.userMemories.save(document, agentId)
  }
  async getGroupMemory(conversationId: string) {
    await this.authorize(conversationId)
    return this.store.groupMemories.read(conversationId)
  }
  async saveGroupMemory(document: UserMemoryDocument, conversationId: string) {
    await this.authorize(conversationId)
    return this.store.groupMemories.save(document, conversationId)
  }
  async searchMessages(conversationId: string, query: string) {
    await this.authorize(conversationId)
    return this.store.searchMessages(conversationId, query)
  }
  async getMessagePage(conversationId: string, topicId: string, before?: string) {
    await this.authorize(conversationId)
    if (!(await this.store.conversation(conversationId))?.topics.some(topic => topic.id === topicId)) throw new Error('Topic not found')
    return this.store.messagePage(conversationId, topicId, before)
  }
}
