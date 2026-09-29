import type { BotGroup, GroupDecisionContext, GroupMessage, GroupReply } from './bot/group'
import type { PrivateDelivery } from './bot/privateMessages'

export interface GroupWorkflow {
  schedulingVersion?: number
  decisionSettings?: import('./groupDecision').DecisionSettings
  lastLeaderMemberId?: string
  id: string
  conversationId: string
  topicId: string
  runId: string
  group: BotGroup
  user: GroupMessage
  history: GroupMessage[]
  privateMessages: PrivateDelivery[]
  status: 'running' | 'waiting' | 'completed' | 'paused' | 'cancelled'
  error?: string
  calls: Record<string, { status: 'running' | 'done'; kind: 'decision' | 'reply'; value?: unknown; startedAt?: number; heartbeatAt?: number; lastProgressAt?: number; finishedAt?: number }>
  updatedAt: number
}
export interface GroupWorkflowView {
  id: string; conversationId: string; topicId: string; status: GroupWorkflow['status']; error?: string; completedSteps: number
}
export function workflowView(workflow: GroupWorkflow): GroupWorkflowView {
  return { id: workflow.id, conversationId: workflow.conversationId, topicId: workflow.topicId,
    status: workflow.status, error: workflow.error,
    completedSteps: Object.values(workflow.calls).filter(call => call.kind === 'reply' && call.status === 'done' && !(call.value as GroupReply)?.failed).length }
}

/** IDs describe causal progress, not wall time, so a replay addresses the same slots. */
export function decisionSlot(context: GroupDecisionContext, version = 2): string {
  if (version >= 2 && context.recovery?.slotId) return `decision:recovery:${context.recovery.slotId}:${context.recovery.failedMemberId}:${context.recovery.triggerMessageIds.join(',')}`
  return `decision:${context.completedTurns.map(turn => `${turn.round}/${turn.memberId}`).join(',')}:${(context.unavailableMemberIds ?? []).join(',')}${context.recovery ? ':recovery:' + context.recovery.failedMemberId + ':' + context.recovery.triggerMessageIds.join(',') : ''}`
}
