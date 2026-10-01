import type { AgentConfig, WorkCoordination, WorkCoordinatorDecision, WorkParticipantTurn } from '../../shared/types'
import { WORK_MAX_COORDINATOR_TURNS, WORK_MAX_PARTICIPANTS, WORK_MAX_PARTICIPANT_TURNS } from '../../shared/types'
import type { GroupDecision, GroupReply } from '../../shared/bot/group'
import type { GroupWorkflow } from '../../shared/groupWorkflow'

const bounded = (value: unknown, size = 1000): string => typeof value === 'string' ? value.trim().slice(0, size) : ''
const roleOf = (agent: Pick<AgentConfig, 'id' | 'name' | 'role'>): string => bounded(agent.role, 80) || agent.name || agent.id

export function initialWorkCoordination(coordinator: AgentConfig, candidates: AgentConfig[]): WorkCoordination {
  const participants = [coordinator, ...candidates.filter(agent => agent.id !== coordinator.id)].slice(0, WORK_MAX_PARTICIPANTS)
  return {
    mode: participants.length > 1 ? 'coordinated' : 'single', status: 'running', coordinatorAgentId: coordinator.id,
    participants: participants.map(agent => ({ agentId: agent.id, role: roleOf(agent), status: 'available', turns: 0 })),
    decisions: [], turns: [],
    limits: { participants: WORK_MAX_PARTICIPANTS, coordinatorTurns: WORK_MAX_COORDINATOR_TURNS, participantTurns: WORK_MAX_PARTICIPANT_TURNS },
    metrics: { coordinatorTurns: 0, participantTurns: 0, toolCalls: 0, elapsedMs: 0, retries: 0, rolesInvoked: [], skippedRoles: [] },
    next: participants.length > 1 ? 'Coordinator is selecting the minimal sufficient participant.' : `${roleOf(coordinator)} is executing the objective.`
  }
}

/** Convert the existing persisted group journal into bounded, role-neutral Work evidence. */
export function summarizeWorkCoordination(base: WorkCoordination, workflow: GroupWorkflow | undefined, agents: AgentConfig[], now: number): WorkCoordination {
  if (!workflow) return { ...base, status: base.status === 'running' ? 'completed' : base.status,
    metrics: { ...base.metrics, elapsedMs: Math.max(0, now - (base.turns[0]?.startedAt ?? now)) } }
  const byId = new Map(agents.map(agent => [agent.id, agent]))
  const calls = Object.entries(workflow.calls).sort((a, b) => (a[1].startedAt ?? 0) - (b[1].startedAt ?? 0))
  const decisions: WorkCoordinatorDecision[] = []
  const turns: WorkParticipantTurn[] = []
  const objectives = new Map<string, string>()
  for (const [id, call] of calls) {
    if (call.kind === 'decision' && call.status === 'done') {
      const decision = call.value as GroupDecision | undefined
      if (!decision) continue
      for (const [agentId, assignment] of Object.entries(decision.assignments ?? {})) objectives.set(agentId, bounded(assignment, 500))
      for (const task of decision.tasks ?? []) objectives.set(task.memberId, bounded(task.instruction, 500))
      const prior = decisions.flatMap(item => item.agentIds)
      const retried = decision.memberIds.some(agentId => prior.includes(agentId))
      const action: WorkCoordinatorDecision['action'] = decision.waitForHuman ? 'ask-human'
        : decision.mode === 'none' ? (workflow.status === 'completed' ? 'complete' : 'block')
          : retried ? 'retry-role' : decisions.length ? 'change-role' : 'run-role'
      decisions.push({ id, action, agentIds: decision.memberIds.slice(0, WORK_MAX_PARTICIPANTS),
        reason: decision.waitForHuman ? 'Human judgment is required.' : bounded(Object.values(decision.assignments ?? {}).join(' · '), 500) || `Coordinator selected ${decision.memberIds.length} participant${decision.memberIds.length === 1 ? '' : 's'}.`,
        at: call.finishedAt ?? call.startedAt ?? workflow.updatedAt })
      continue
    }
    if (call.kind !== 'reply' || call.status !== 'done') continue
    const reply = call.value as GroupReply | undefined
    const message = reply?.messages?.find(item => item.sender?.id)
    if (!message?.sender) continue
    const agent = byId.get(message.sender.id)
    turns.push({ id, agentId: message.sender.id, role: agent ? roleOf(agent) : message.sender.name,
      objective: objectives.get(message.sender.id) || 'Contribute the evidence requested by the coordinator.',
      status: reply?.failed ? 'failed' : 'completed', result: bounded(message.content),
      evidence: (message.artifacts ?? []).map(artifact => bounded(artifact.name, 200)).filter(Boolean).slice(0, 20),
      startedAt: call.startedAt, finishedAt: call.finishedAt })
  }
  const keptDecisions = decisions.slice(-WORK_MAX_COORDINATOR_TURNS)
  const keptTurns = turns.slice(-WORK_MAX_PARTICIPANT_TURNS)
  const count = new Map<string, number>()
  for (const turn of keptTurns) count.set(turn.agentId, (count.get(turn.agentId) ?? 0) + 1)
  const invoked = new Set(keptTurns.map(turn => turn.agentId))
  const rolesInvoked = [...new Set(keptTurns.map(turn => turn.role))]
  const skippedRoles = base.participants.filter(item => !invoked.has(item.agentId)).map(item => item.role)
  return {
    ...base,
    status: workflow.status === 'waiting' ? 'waiting' : workflow.status === 'completed' ? 'completed' : workflow.status === 'paused' ? 'blocked' : 'running',
    participants: base.participants.map(item => ({ ...item, turns: count.get(item.agentId) ?? 0,
      status: !invoked.has(item.agentId) ? (workflow.status === 'completed' ? 'skipped' : 'available')
        : keptTurns.some(turn => turn.agentId === item.agentId && turn.status === 'failed') ? 'failed' : 'completed' })),
    decisions: keptDecisions, turns: keptTurns,
    metrics: { coordinatorTurns: decisions.length, participantTurns: turns.length, toolCalls: 0,
      elapsedMs: Math.max(0, now - Math.min(...calls.map(([, call]) => call.startedAt ?? now), now)),
      retries: keptDecisions.filter(item => item.action === 'retry-role').length, rolesInvoked, skippedRoles },
    next: workflow.status === 'waiting' ? 'Waiting for human judgment.' : workflow.status === 'completed' ? 'Coordinator accepted the available evidence and completed Work.'
      : workflow.status === 'paused' ? (workflow.error || 'Coordinator blocked Work.') : 'Coordinator is evaluating the latest evidence.'
  }
}
