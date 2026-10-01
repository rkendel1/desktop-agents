import { describe, expect, it } from 'vitest'
import type { AgentConfig } from '../../shared/types'
import type { GroupWorkflow } from '../../shared/groupWorkflow'
import { initialWorkCoordination, summarizeWorkCoordination } from './coordinator'

const agent = (id: string, role: string): AgentConfig => ({ id, name: role, role, instructions: '', color: '#000', provider: 'local', model: id, localAgentId: 'codex', createdAt: 1 })
const agents = [agent('lead', 'Coordinator'), agent('code', 'Coder'), agent('test', 'Tester'), agent('review', 'Reviewer')]
const workflow = (calls: GroupWorkflow['calls'], status: GroupWorkflow['status'] = 'completed'): GroupWorkflow => ({
  id: 'workflow', conversationId: 'work-project-1', topicId: 'topic', runId: 'run', status, calls, updatedAt: 100,
  group: { id: 'group', name: 'Work', leadMemberId: 'lead', members: agents.map(item => ({ id: item.id, name: item.name })) },
  user: { id: 'user', role: 'user', content: 'Fix it' }, history: [], privateMessages: []
})
const decision = (id: string, at: number, memberIds: string[], extra: Record<string, unknown> = {}) => [id, { status: 'done' as const, kind: 'decision' as const, startedAt: at, finishedAt: at + 1, value: { mode: memberIds.length ? 'single' : 'none', memberIds, triggerMessageIds: ['user'], leaderMemberId: 'lead', ...extra } }]
const reply = (id: string, at: number, memberId: string, content: string, failed = false) => [id, { status: 'done' as const, kind: 'reply' as const, startedAt: at, finishedAt: at + 1, value: { failed, messages: [{ id, role: 'assistant', sender: { id: memberId, name: memberId }, content }] } }]

describe('Work coordinator projection', () => {
  it('uses only the coordinator for a simple task and records skipped candidates', () => {
    const base = initialWorkCoordination(agents[0], agents.slice(1))
    const result = summarizeWorkCoordination(base, workflow(Object.fromEntries([
      decision('d1', 1, ['lead'], { assignments: { lead: 'Rename the variable and verify it.' } }), reply('r1', 2, 'lead', 'Renamed and verified.'), decision('d2', 3, [])
    ])), agents, 10)
    expect(result.metrics.rolesInvoked).toEqual(['Coordinator'])
    expect(result.metrics.skippedRoles).toEqual(['Coder', 'Tester', 'Reviewer'])
    expect(result.status).toBe('completed')
  })

  it('records dynamic multi-role execution, retry, failure evidence, and completion', () => {
    const result = summarizeWorkCoordination(initialWorkCoordination(agents[0], agents.slice(1)), workflow(Object.fromEntries([
      decision('d1', 1, ['code'], { assignments: { code: 'Implement the fix.' } }), reply('r1', 2, 'code', 'Implemented.'),
      decision('d2', 3, ['test'], { assignments: { test: 'Run focused tests.' } }), reply('r2', 4, 'test', 'One test failed.', true),
      decision('d3', 5, ['code'], { assignments: { code: 'Repair the failing case.' } }), reply('r3', 6, 'code', 'Repaired.'),
      decision('d4', 7, ['test']), reply('r4', 8, 'test', 'Tests pass.'), decision('d5', 9, ['review']), reply('r5', 10, 'review', 'Approved.'), decision('d6', 11, [])
    ])), agents, 20)
    expect(result.metrics.rolesInvoked).toEqual(['Coder', 'Tester', 'Reviewer'])
    expect(result.metrics.retries).toBeGreaterThan(0)
    expect(result.turns.some(turn => turn.status === 'failed')).toBe(true)
  })

  it('stops for human judgment and remains bounded when the journal is oversized', () => {
    const entries = Array.from({ length: 20 }, (_, index) => index % 2
      ? reply(`r${index}`, index, 'code', `result ${index}`)
      : decision(`d${index}`, index, ['code'], index === 18 ? { waitForHuman: true } : {}))
    const result = summarizeWorkCoordination(initialWorkCoordination(agents[0], agents.slice(1)), workflow(Object.fromEntries(entries), 'waiting'), agents, 30)
    expect(result.status).toBe('waiting')
    expect(result.decisions.length).toBeLessThanOrEqual(result.limits.coordinatorTurns)
    expect(result.turns.length).toBeLessThanOrEqual(result.limits.participantTurns)
    expect(result.next).toMatch(/human/i)
  })
})
