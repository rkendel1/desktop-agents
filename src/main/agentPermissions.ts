import { randomUUID } from 'node:crypto'
import { agentPermissions, type PermissionApproval, type PermissionRequest, type SensitiveCapability } from '../shared/agentPermissions'
import type { AgentConfig } from '../shared/types'
import type { NativeAppSession } from '../shared/agentExecutor'

/** Scopes come from known tool contracts, never model-supplied approval labels.
 * Writes to existing files, sending, scheduling, clicks and native execution
 * intentionally remain single-use. */
function reusableScope(input: Pick<PermissionRequest, 'capability' | 'operation' | 'details'>): string | undefined {
  let args: Record<string, unknown>
  try { args = JSON.parse(input.details); if (!args || Array.isArray(args) || typeof args !== 'object') return } catch { return }
  if (['computer_open', 'native_web_fetch'].includes(input.operation) && ['network', 'browserControl'].includes(input.capability)) {
    try { const url = new URL(String(args.url)); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.origin } catch { return }
  }
  if (input.capability === 'filesRead' && ['computer_list_files', 'computer_open_file', 'native_read_file'].includes(input.operation)) {
    if (typeof args.path === 'string' && args.path.startsWith('/') && !args.path.split('/').includes('..')) return args.path
    if (input.operation === 'computer_list_files' && args.path === undefined) return 'Downloads / Desktop / Documents: directory listing'
  }
  if (input.capability === 'filesWrite' && input.operation === 'create_file') return 'New files in task output storage'
  if (input.capability === 'accountRead' && ['email_search', 'email_read'].includes(input.operation) && typeof args.accountId === 'string' && args.accountId) {
    return JSON.stringify({ account: args.accountId, folder: args.folder || 'INBOX' })
  }
  return undefined
}

/** Only native protocols with explicit read-only tool contracts are classified.
 * Free-form command descriptions and Computer Use requests cannot grant a scope. */
export function nativeReadPermission(runtime: string | undefined, details: string): { capability: SensitiveCapability; operation: string; details: string } | undefined {
  if (runtime !== 'claude') return
  try {
    const request = JSON.parse(details)
    if (request.tool === 'Read' && typeof request.input?.file_path === 'string') return { capability: 'filesRead', operation: 'native_read_file', details: JSON.stringify({ path: request.input.file_path }) }
    if (request.tool === 'WebFetch' && typeof request.input?.url === 'string') return { capability: 'network', operation: 'native_web_fetch', details: JSON.stringify({ url: request.input.url }) }
  } catch { return }
}

export function toolCapability(name: string): SensitiveCapability {
  if (name === 'list_workspace_files' || name === 'read_workspace_file' || name === 'computer_list_files' || name === 'computer_open_file' || name === 'read_skill_file' || name === 'list_skill_files') return 'filesRead'
  if (['write_workspace_file', 'computer_make_directory', 'computer_move_file', 'create_file'].includes(name)) return 'filesWrite'
  if (name === 'computer_open') return 'network'
  if (name.startsWith('computer_')) return 'browserControl'
  if (/^(email|mail)_/.test(name)) return /send|delete|move|mark|draft|reply/.test(name) ? 'accountWrite' : 'accountRead'
  if (name === 'create_routine') return 'automation'
  return 'otherTools'
}

export type PermissionEvent =
  | { kind: 'requested'; request: PermissionRequest }
  | { kind: 'settled'; request: PermissionRequest; outcome: 'allowed' | 'declined' | 'expired' | 'cancelled' }

/** Decisions live in the owner main process, never in model arguments or requester IPC. */
export class AgentPermissionBroker {
  private nativeSessions = new Map<string, { agentId: string; signal: AbortSignal; grants: Set<string>; dispose: () => void }>()
  private tasks = new Map<string, { agentId: string; requesterId?: string; grants: Set<string> }>()
  private pending = new Map<string, { sessionId?: string; sessionGrant?: string; taskId?: string; grant?: string; request: PermissionRequest; finish: (result: 'allowed' | 'declined' | 'expired' | 'cancelled') => void }>()
  private observer?: (event: PermissionEvent) => void
  constructor(private readonly changed: () => void) {}
  /** Told when a request appears and how it ends. Memory-only: it never grants or blocks anything. */
  observe(observer: ((event: PermissionEvent) => void) | undefined): void { this.observer = observer }
  private notify(event: PermissionEvent): void { try { this.observer?.(event) } catch { /* an observer never affects a decision */ } }
  snapshot(): PermissionRequest[] { return [...this.pending.values()].map((p) => p.request) }
  hasPending(agentId: string): boolean { return [...this.pending.values()].some((entry) => entry.request.agentId === agentId) }
  beginTask(agentId: string, requesterId?: string): string {
    const id = randomUUID()
    this.tasks.set(id, { agentId, requesterId, grants: new Set() })
    return id
  }
  endTask(id: string): void {
    this.tasks.delete(id)
    for (const entry of this.pending.values()) if (entry.taskId === id) entry.finish('cancelled')
  }
  resolve(id: string, allow: PermissionApproval): void {
    const entry = this.pending.get(id)
    if (!entry) throw new Error('Permission request is no longer available')
    if (allow !== true && allow !== false && allow !== 'task' && allow !== 'session') throw new Error('Invalid permission approval')
    if (allow === 'session') {
      const session = entry.sessionId ? this.nativeSessions.get(entry.sessionId) : undefined
      if (!session || session.signal.aborted || !entry.sessionGrant || !entry.request.sessionScope) throw new Error('Session approval is unavailable for this operation')
      session.grants.add(entry.sessionGrant)
      for (const pending of this.pending.values()) if (pending.sessionId === entry.sessionId && pending.sessionGrant === entry.sessionGrant) pending.finish('allowed')
    } else if (allow === 'task') {
      const task = entry.taskId ? this.tasks.get(entry.taskId) : undefined
      if (!task || !entry.grant || !entry.request.taskScope) throw new Error('Task approval is unavailable for this operation')
      task.grants.add(entry.grant)
      for (const pending of this.pending.values()) if (pending.taskId === entry.taskId && pending.grant === entry.grant) pending.finish('allowed')
    } else entry.finish(allow ? 'allowed' : 'declined')
  }
  cancelAgent(id: string): void {
    for (const session of this.nativeSessions.values()) if (session.agentId === id) session.dispose()
    for (const [taskId, task] of this.tasks) if (task.agentId === id) this.endTask(taskId)
    for (const entry of this.pending.values()) if (entry.request.agentId === id) entry.finish('cancelled')
  }
  async authorize(config: AgentConfig, input: Pick<PermissionRequest, 'requester' | 'requesterId' | 'requesterKind' | 'roomName' | 'capability' | 'operation' | 'details' | 'context'>, signal?: AbortSignal, forceAsk = false, taskId?: string, native?: NativeAppSession): Promise<void> {
    signal?.throwIfAborted()
    if (input.details.length > 64000) throw new Error('Operation is too large to review; split it into smaller requests')
    const policy = agentPermissions(config.permissions)
    const rule = input.capability === 'groupHumans' || input.capability === 'groupAgents' ? policy[input.capability] : policy.sensitive[input.capability]
    if (rule === 'deny') throw new Error('The owner has disabled this permission')
    if (rule === 'allow' && !forceAsk) return
    const task = taskId ? this.tasks.get(taskId) : undefined
    if (taskId && (!task || task.agentId !== config.id || task.requesterId !== input.requesterId)) throw new Error('Permission task changed')
    let sessionGrant: string | undefined
    if (native) {
      native.signal.throwIfAborted()
      let session = this.nativeSessions.get(native.id)
      if (session && (session.agentId !== config.id || session.signal !== native.signal)) throw new Error('Native session changed')
      if (!session) {
        const dispose = (): void => {
          this.nativeSessions.delete(native.id)
          native.signal.removeEventListener('abort', dispose)
          for (const pending of this.pending.values()) if (pending.sessionId === native.id) pending.finish('cancelled')
        }
        session = { agentId: config.id, signal: native.signal, grants: new Set(), dispose }
        this.nativeSessions.set(native.id, session)
        native.signal.addEventListener('abort', dispose, { once: true })
      }
      sessionGrant = JSON.stringify([native.appId, input.capability, input.requesterId, input.requesterKind, input.context, input.roomName])
      if (session.grants.has(sessionGrant)) return
    }
    const scope = !forceAsk && task ? reusableScope(input) : undefined
    const grant = scope ? JSON.stringify([input.capability, ['email_read', 'email_search'].includes(input.operation) ? 'email_read' : input.operation, scope, input.requesterKind, input.context, input.roomName]) : undefined
    if (grant && task?.grants.has(grant)) return
    if (this.pending.size >= 20) throw new Error('Too many permission requests')
    let requestRef: PermissionRequest | undefined
    const result = await new Promise<'allowed' | 'declined' | 'expired' | 'cancelled'>((resolve) => {
      const id = randomUUID()
      let timer: ReturnType<typeof setTimeout>
      const abort = (): void => finish('cancelled')
      const finish = (result: 'allowed' | 'declined' | 'expired' | 'cancelled'): void => {
        if (!this.pending.delete(id)) return
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        const entry = requestRef!
        resolve(result)
        this.notify({ kind: 'settled', request: entry, outcome: result })
        this.changed()
      }
      timer = setTimeout(() => finish('expired'), 10 * 60_000)
      const request: PermissionRequest = { ...input, ...(scope ? { taskScope: scope } : {}),
        ...(native ? { sessionScope: native.appName, nativeApp: { id: native.appId, name: native.appName } } : {}),
        id, agentId: config.id, agentName: config.name, createdAt: Date.now(), details: input.details }
      requestRef = request
      this.pending.set(id, { sessionId: native?.id, sessionGrant, taskId, grant, request, finish })
      signal?.addEventListener('abort', abort, { once: true })
      this.notify({ kind: 'requested', request })
      if (signal?.aborted) abort()
      this.changed()
    })
    signal?.throwIfAborted()
    if (result === 'declined') throw new Error('The owner declined this request')
    if (result === 'expired') throw new Error('Permission request expired')
    if (result === 'cancelled') throw new Error('Permission request cancelled')
    native?.signal.throwIfAborted()
  }
}
