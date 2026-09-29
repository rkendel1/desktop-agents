export const sensitiveCapabilities = ['filesRead', 'filesWrite', 'network', 'browserControl', 'accountRead', 'accountWrite', 'automation', 'localExecution', 'otherTools'] as const
export type SensitiveCapability = typeof sensitiveCapabilities[number]
export type PermissionDecision = 'allow' | 'ask' | 'deny'
export type PermissionApproval = boolean | 'task' | 'session'
export interface AgentPermissions {
  groupHumans: PermissionDecision
  groupAgents: PermissionDecision
  sensitive: Record<SensitiveCapability, PermissionDecision>
}
export function agentPermissions(value?: unknown): AgentPermissions {
  const source = value && typeof value === 'object' ? value as Partial<AgentPermissions> : {}
  const decision = (v: unknown, fallback: PermissionDecision): PermissionDecision =>
    v === 'allow' || v === 'ask' || v === 'deny' ? v : v === undefined ? fallback : 'deny'
  return {
    groupHumans: decision(source.groupHumans, 'allow'),
    groupAgents: decision(source.groupAgents, 'allow'),
    sensitive: Object.fromEntries(sensitiveCapabilities.map((key) => [key, decision(source.sensitive?.[key], 'ask')])) as AgentPermissions['sensitive']
  }
}
export const permissionLabels: Record<SensitiveCapability | 'groupHumans' | 'groupAgents', string> = {
  groupHumans: 'Group members', groupAgents: 'Other members’ agents',
  filesRead: 'Read local files', filesWrite: 'Modify local files', network: 'Access the web',
  browserControl: 'Operate the browser', accountRead: 'Read connected accounts', accountWrite: 'Send or modify account data',
  automation: 'Create scheduled tasks', localExecution: 'Run the local agent program', otherTools: 'Other tools'
}
export interface PermissionRequest {
  taskScope?: string
  sessionScope?: string
  nativeApp?: { id: string; name: string }
  context?: 'direct' | 'group'
  id: string
  agentId: string
  agentName: string
  requester: string
  requesterId?: string
  requesterKind?: 'person' | 'agent'
  roomName: string
  capability: SensitiveCapability | 'groupHumans' | 'groupAgents'
  operation: string
  details: string
  createdAt: number
  /** Set on approvals asked during a coding session: exactly which session and folder it is for. */
  codingSession?: { id: string; projectName: string; workingDirectory: string; task: string }
}
