import { expect, it, vi } from 'vitest'
import { GroupWorkflowJournal } from './groupWorkflow'
import type { GroupWorkflow } from '../shared/groupWorkflow'

const initial = (): GroupWorkflow => ({ id: 'task', conversationId: 'group', topicId: 'topic', runId: 'run', group: { id: 'group', name: 'Team', members: [] }, user: { id: 'user', role: 'user', content: 'work' }, history: [], privateMessages: [], status: 'running', calls: {}, updatedAt: 1 })
it('replays completed steps and re-evaluates only a new decision after a restart', async () => {
  let saved = initial()
  const save = async (state: GroupWorkflow) => { saved = structuredClone(state) }
  const journal = new GroupWorkflowJournal(saved, save)
  const operation = vi.fn(async () => ({ text: 'Project review completed' }))
  await journal.call('reply:1', 'reply', operation)
  const reopened = new GroupWorkflowJournal(saved, save)
  expect(await reopened.call('reply:1', 'reply', operation)).toEqual({ text: 'Project review completed' })
  expect(operation).toHaveBeenCalledTimes(1)
  const decision = vi.fn(async () => ({ mode: 'none' }))
  await reopened.call('decision:2', 'decision', decision)
  expect(decision).toHaveBeenCalledTimes(1)
})
it('never retries an interrupted tool-bearing step, while retrying an interrupted decision is safe', async () => {
  const state = initial()
  state.calls.work = { kind: 'reply', status: 'running' }
  state.calls.route = { kind: 'decision', status: 'running' }
  const journal = new GroupWorkflowJournal(state, async () => {})
  const work = vi.fn()
  await expect(journal.call('work', 'reply', work)).rejects.toThrow('will not be repeated automatically')
  expect(work).not.toHaveBeenCalled()
  expect(await journal.call('route', 'decision', async () => 'route')).toBe('route')
})

it('records executor heartbeat separately from progress and stops the pulse on completion', async () => {
  vi.useFakeTimers()
  try {
    const state = initial()
    const save = vi.fn(async () => undefined)
    const journal = new GroupWorkflowJournal(state, save)
    let finish!: () => void
    const call = journal.call('task:a', 'reply', () => new Promise<void>(resolve => { finish = resolve }))
    await vi.advanceTimersByTimeAsync(15000)
    expect(state.calls['task:a'].heartbeatAt).toBeGreaterThan(state.calls['task:a'].startedAt!)
    expect(state.calls['task:a'].lastProgressAt).toBeUndefined()
    journal.progress('task:a')
    expect(state.calls['task:a'].lastProgressAt).toBe(Date.now())
    finish(); await call
    const saves = save.mock.calls.length
    await vi.advanceTimersByTimeAsync(30000)
    expect(save).toHaveBeenCalledTimes(saves)
  } finally { vi.useRealTimers() }
})

it('uses stable recovery slots even if parallel failures arrive in a different order', async () => {
  const { decisionSlot } = await import('../shared/groupWorkflow')
  const recovery = { slotId: 'draft', taskId: 'draft', failedMemberId: 'a', participationOnly: false, triggerMessageIds: ['u'] }
  const context = { recovery, messages: [], privateDeliveries: [], completedTurns: [], unavailableMemberIds: ['a', 'b'] }
  expect(decisionSlot(context)).toBe(decisionSlot({ ...context, unavailableMemberIds: ['b', 'a'] }))
  expect(decisionSlot(context)).not.toBe(decisionSlot({ ...context, recovery: { ...recovery, slotId: 'review' } }))
})
