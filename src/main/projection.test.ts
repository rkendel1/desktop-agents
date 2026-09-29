import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectionDelta } from '../shared/projection'
import { applyProjection } from '../shared/projection'
import type { AppSnapshot } from '../shared/types'
import { DesktopProjection } from './projection'
import { createTestDesktop, disposeTestDesktops } from './testSupport'
import type { DesktopRepository } from './desktopRepository'

afterEach(disposeTestDesktops)

const sources = {
  ephemeral: () => ({ agentStatuses: {}, activity: [], permissionRequests: [], computers: [] }),
  runtimeStatus: () => ({ mode: 'offline' as const, label: 'No model connected' }),
  availableModels: () => [],
  connectors: async () => []
}

/** What the renderer holds: one snapshot read, then only the deltas the projection sends. */
async function renderer(repository: DesktopRepository) {
  const deltas: ProjectionDelta[] = []
  const projection = new DesktopProjection(repository, sources, delta => deltas.push(delta))
  projection.start()
  const initial = await projection.snapshot()
  let sequence = initial.sequence
  let state: AppSnapshot = initial.snapshot
  const flush = async (): Promise<void> => {
    await projection.settled()
    for (const delta of deltas.splice(0)) if (delta.sequence > sequence) { sequence = delta.sequence; state = applyProjection(state, delta.changes) }
  }
  return { projection, flush, state: () => state }
}

const byId = <T extends { id: string }>(items: T[] | undefined): T[] => [...(items ?? [])].sort((a, b) => a.id.localeCompare(b.id))
const durable = (snapshot: AppSnapshot) => ({
  agents: byId(snapshot.agents), conversations: byId(snapshot.conversations), messages: byId(snapshot.messages),
  privateMessages: byId(snapshot.privateMessages), routines: byId(snapshot.routines), runs: byId(snapshot.runs), runEvents: byId(snapshot.runEvents)
})

describe('renderer projection', () => {
  it('is built from FeltDB alone: a renderer that restarts sees exactly the current durable state', async () => {
    const { repository } = await createTestDesktop()
    const first = await renderer(repository)
    const agent = await repository.createAgent({ name: 'Ada', role: 'Engineer', instructions: '', color: '#123456', provider: 'test', model: 'fixture' })
    const { conversation } = await repository.ensureDirectConversation(agent.id)
    await repository.addMessage({ conversationId: conversation.id, topicId: conversation.activeTopicId, authorId: 'user', authorName: 'You', text: 'hello', kind: 'message' })
    await first.flush()
    // The first renderer followed along through deltas.
    expect(first.state().messages.map(message => message.text)).toEqual(['hello'])

    // A second renderer starts from nothing but FeltDB and arrives at the same state.
    const second = await renderer(repository)
    expect(durable(second.state())).toEqual(durable(first.state()))
    await first.projection.stop(); await second.projection.stop()
  })

  it('reconstructs a transaction that changes several collections, from deltas alone', async () => {
    const { repository } = await createTestDesktop()
    const live = await renderer(repository)
    const a = await repository.createAgent({ name: 'A', role: '', instructions: '', color: '', provider: 'test', model: 'fixture' })
    const b = await repository.createAgent({ name: 'B', role: '', instructions: '', color: '', provider: 'test', model: 'fixture' })
    // Creating a group writes its session, group, members and topic together.
    const group = await repository.createGroup({ name: 'Crew', agentIds: [a.id, b.id] })
    await repository.addMessage({ conversationId: group.id, topicId: group.activeTopicId, authorId: a.id, authorName: 'A', text: 'first', kind: 'message' })
    await repository.deleteMessage(group.id, (await repository.messages()).at(-1)!.id)
    await repository.updateConversation(group.id, { name: 'Crew renamed' })
    await live.flush()

    const restarted = await renderer(repository)
    expect(durable(live.state())).toEqual(durable(restarted.state()))
    expect(live.state().conversations.find(item => item.id === group.id)).toMatchObject({ name: 'Crew renamed', agentIds: [a.id, b.id] })
    expect(live.state().messages).toEqual([])
    await live.projection.stop(); await restarted.projection.stop()
  })

  it('sends one delta per burst of writes, in increasing sequence, and never a whole snapshot', async () => {
    const { repository } = await createTestDesktop()
    const deltas: ProjectionDelta[] = []
    const projection = new DesktopProjection(repository, sources, delta => deltas.push(delta))
    projection.start()
    const agent = await repository.createAgent({ name: 'Ada', role: '', instructions: '', color: '', provider: 'test', model: 'fixture' })
    const { conversation } = await repository.ensureDirectConversation(agent.id)
    await projection.settled()
    deltas.length = 0
    for (let i = 0; i < 50; i++) await repository.addMessage({ conversationId: conversation.id, topicId: conversation.activeTopicId, authorId: 'user', authorName: 'You', text: `m${i}`, kind: 'message' })
    await projection.settled()
    const sequences = deltas.map(delta => delta.sequence)
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
    expect(new Set(sequences).size).toBe(sequences.length)
    // Appending a message announces that message (and the chat it changed), not every message.
    const messageChanges = deltas.flatMap(delta => delta.changes).filter(change => change.kind === 'message')
    expect(messageChanges).toHaveLength(50)
    expect(deltas.flatMap(delta => delta.changes).every(change => change.kind !== 'slice' || !('messages' in change.value))).toBe(true)
    await projection.stop()
  })

  it('applies a delta twice with the same result', async () => {
    const { repository } = await createTestDesktop()
    const live = await renderer(repository)
    const agent = await repository.createAgent({ name: 'Ada', role: '', instructions: '', color: '', provider: 'test', model: 'fixture' })
    await live.flush()
    const once = live.state()
    const change = { kind: 'agent' as const, id: agent.id, value: (await repository.agent(agent.id))! }
    expect(applyProjection(once, [change, change])).toEqual(applyProjection(once, [change]))
    await live.projection.stop()
  })
})
