import { afterEach, describe, expect, it } from 'vitest'
import type { RecordChange } from './felt/database'
import { createTestDesktop, disposeTestDesktops } from './testSupport'

afterEach(disposeTestDesktops)

const input = (name: string) => ({ name, role: '', instructions: '', color: '#0b5cff', provider: 'test', model: 'fixture' })

describe('DesktopRepository transactions', () => {
  it('commits the records of one operation together', async () => {
    const { repository } = await createTestDesktop()
    const a = await repository.createAgent(input('A'))
    const b = await repository.createAgent(input('B'))
    const group = await repository.createGroup({ name: 'Crew', agentIds: [a.id, b.id] })
    // One call wrote the group's session, its record, its members and its first topic.
    const felt = repository.felt
    expect(await felt.collection('Session').has(group.id)).toBe(true)
    expect(await felt.collection('Group').has(group.id)).toBe(true)
    expect((await felt.collection('GroupMember').where({ groupId: group.id } as never)).map(row => (row as unknown as { agentId: string }).agentId).sort()).toEqual([a.id, b.id].sort())
    expect((await felt.collection('Topic').where({ sessionId: group.id } as never)).length).toBeGreaterThan(0)
  })

  it('removes a conversation with its topics and messages, or not at all', async () => {
    const { repository } = await createTestDesktop()
    const agent = await repository.createAgent(input('A'))
    const { conversation } = await repository.ensureDirectConversation(agent.id)
    for (let i = 0; i < 5; i++) await repository.addMessage({ conversationId: conversation.id, topicId: conversation.activeTopicId, authorId: 'user', authorName: 'You', text: `m${i}`, kind: 'message' })
    await repository.deleteConversation(conversation.id)
    expect(await repository.conversation(conversation.id)).toBeUndefined()
    expect(await repository.messages()).toEqual([])
    expect(await repository.felt.collection('Topic').where({ sessionId: conversation.id } as never)).toEqual([])
  })

  it('leaves no partial state when a later step of the operation fails', async () => {
    const { repository } = await createTestDesktop()
    const agent = await repository.createAgent(input('A'))
    const { conversation } = await repository.ensureDirectConversation(agent.id)
    const before = { agents: await repository.agents(), conversations: await repository.conversations(), messages: await repository.messages() }
    const messages = repository.felt.collection<{ id: string }>('Message')
    const sessions = repository.felt.collection<{ id: string }>('Session')
    await expect(repository.felt.transaction(async batch => {
      const session = (await sessions.get(conversation.id))!
      await batch.put(sessions, { ...session, name: 'changed in a failed operation' } as never)
      await batch.put(messages, { id: 'never-committed', sessionId: conversation.id, topicId: 't', role: 'user', authorId: 'user', authorName: 'You', content: 'x', kind: 'message', timestamp: 1 } as never)
      throw new Error('the operation failed after staging two writes')
    })).rejects.toThrow('the operation failed')
    expect({ agents: await repository.agents(), conversations: await repository.conversations(), messages: await repository.messages() }).toEqual(before)
    expect(await messages.has('never-committed')).toBe(false)
  })

  it('rejects a whole operation whose record breaks desktop.flow', async () => {
    const { repository } = await createTestDesktop()
    const settings = repository.felt.collection<{ id: string }>('Setting')
    await expect(repository.felt.transaction(async batch => {
      await batch.put(settings, { id: 'valid', value: 1, updatedAt: 1 } as never)
      await batch.put(settings, { id: 'invalid' } as never)
    })).rejects.toThrow()
    expect(await settings.has('valid')).toBe(false)
  })
})

describe('project conversations', () => {
  it('creates one durable project-scoped group with workspace and message provenance', async () => {
    const desktop = await createTestDesktop()
    const firstAgent = await desktop.repository.createAgent(input('Forge'))
    const project = await desktop.repository.addProject({ path: '/tmp/foundry-project-conversation', name: 'Foundry', isGit: true })
    const conversation = await desktop.repository.ensureProjectConversation(project.id)
    expect(conversation).toMatchObject({ id: `project-${project.id}`, projectId: project.id, type: 'group', workspacePath: project.path, hidden: true, agentIds: [firstAgent.id] })
    const same = await desktop.repository.ensureProjectConversation(project.id)
    expect(same.id).toBe(conversation.id)
    const message = await desktop.repository.addMessage({ conversationId: conversation.id, topicId: conversation.activeTopicId, authorId: 'user', authorName: 'You', text: 'Make Projects the workbench.', kind: 'message' })
    expect(message).toMatchObject({ projectId: project.id, sessionId: conversation.id, origin: 'user' })
    const agentMessage = await desktop.repository.addMessage({ conversationId: conversation.id, topicId: conversation.activeTopicId, authorId: firstAgent.id, authorName: firstAgent.name, text: 'Ready', kind: 'message' })
    expect(agentMessage).toMatchObject({ projectId: project.id, sessionId: conversation.id, agentId: firstAgent.id, origin: 'agent' })

    const reopened = await desktop.restart()
    expect(await reopened.ensureProjectConversation(project.id)).toMatchObject({ id: conversation.id, projectId: project.id, workspacePath: project.path })
    expect((await reopened.messages()).find(item => item.id === message.id)).toMatchObject({ projectId: project.id, sessionId: conversation.id, origin: 'user' })
  })

  it('adds newly created agents without replacing the project conversation', async () => {
    const { repository } = await createTestDesktop()
    const project = await repository.addProject({ path: '/tmp/foundry-project-members', name: 'Foundry', isGit: false })
    const before = await repository.ensureProjectConversation(project.id)
    const agent = await repository.createAgent(input('Atlas'))
    const after = await repository.ensureProjectConversation(project.id)
    expect(after.id).toBe(before.id)
    expect(after.agentIds).toContain(agent.id)
  })
})

describe('DesktopRepository reactivity', () => {
  it('announces every record a single operation changes, across collections', async () => {
    const { repository } = await createTestDesktop()
    const a = await repository.createAgent(input('A'))
    const b = await repository.createAgent(input('B'))
    const seen: RecordChange[] = []
    const stop = repository.subscribe(change => seen.push(change))
    const group = await repository.createGroup({ name: 'Crew', agentIds: [a.id, b.id] })
    stop()
    const collections = new Set(seen.map(change => change.collection))
    expect(collections).toEqual(new Set(['Session', 'Group', 'GroupMember', 'Topic']))
    expect(seen.filter(change => change.collection === 'GroupMember')).toHaveLength(2)
    expect(seen.every(change => change.type === 'insert')).toBe(true)
    expect(seen.some(change => change.collection === 'Session' && change.id === group.id)).toBe(true)
  })

  it('announces a write only once it is durable', async () => {
    const { repository, restart } = await createTestDesktop()
    let observed: number | undefined
    repository.subscribe(change => { if (change.collection === 'Setting' && change.id === 'k') observed = (change.record as { value: number }).value })
    await repository.setSetting('k', 7)
    expect(observed).toBe(7)
    const reopened = await restart()
    expect(await reopened.setting('k')).toBe(7)
  })
})

describe('message-heavy sessions', () => {
  it('append one message at a time without rewriting the conversation', async () => {
    const { repository } = await createTestDesktop()
    const agent = await repository.createAgent(input('A'))
    const { conversation } = await repository.ensureDirectConversation(agent.id)
    for (let i = 0; i < 1000; i++) await repository.addMessage({ conversationId: conversation.id, topicId: conversation.activeTopicId, authorId: 'user', authorName: 'You', text: `m${i}`, kind: 'message' })
    const seen: RecordChange[] = []
    repository.subscribe(change => seen.push(change))
    await repository.addMessage({ conversationId: conversation.id, topicId: conversation.activeTopicId, authorId: 'user', authorName: 'You', text: 'one more', kind: 'message' })
    // One message in the thousand-message session: one Message change, nothing that re-sends the rest.
    expect(seen.filter(change => change.collection === 'Message')).toHaveLength(1)
    expect(seen.length).toBeLessThanOrEqual(3)
    expect((await repository.recentMessages()).length).toBeGreaterThan(0)
    expect((await repository.topicMessages(conversation.id, conversation.activeTopicId)).at(-1)?.text).toBe('one more')
  }, 60_000)
})
