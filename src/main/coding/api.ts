import { describeApproval } from '../../shared/coding'
import { activityOrigin, checkView, projectView, type ApprovalView, type CodingNotification, type GitStateView, type ProjectView, type SessionView } from '../../shared/codingApi'
import type { CiPlan, CiRun, CodingSession, DevelopmentEnvironmentDetail, DevelopmentEnvironmentView, Project, RecipeResolutionView, RecipeSummary } from '../../shared/types'
import { EnvironmentError, EnvironmentRefusal, type EnvironmentService } from '../environment/service'
import type { CiService } from '../ci/service'
import type { DesktopRepository } from '../desktopRepository'
import type { ComputeClient } from '../compute/client'
import { PAX_INSPECTIONS, type PaxInspection, type PaxRun } from '../compute/pax'
import type { ComputeInventory } from '../../shared/types'
import { gitRemoteUrl } from './git'
import type { CodingService } from './service'

/** Why a request to the coding service was refused. The transport maps these onto its own error codes. */
export type CodingApiErrorCode = 'invalid' | 'not-found' | 'conflict'

export class CodingApiError extends Error {
  constructor(readonly code: CodingApiErrorCode, message: string) {
    super(message)
    this.name = 'CodingApiError'
  }
}

const MAX_TASK = 20_000

/** The service's own errors are plain messages; sort them into what the caller did wrong. */
function classify(error: unknown): CodingApiError {
  if (error instanceof CodingApiError) return error
  if (error instanceof EnvironmentError) return new CodingApiError(error.code === 'compute' ? 'invalid' : error.code, error.message)
  if (error instanceof EnvironmentRefusal) return new CodingApiError('conflict', error.message)
  const message = error instanceof Error ? error.message : String(error)
  if (/not found|no longer exists/i.test(message)) return new CodingApiError('not-found', message)
  if (/already (running|working|has a CI run)|in progress|pinned|no longer the project|refusing to run/i.test(message)) return new CodingApiError('conflict', message)
  return new CodingApiError('invalid', message)
}

/**
 * The coding service as a client sees it: projects, sessions, approvals and notices, in plain views.
 *
 * This is the application boundary that a remote client (through AppPort) uses. It owns no state:
 * everything it returns is read from the coding service, FeltDB and the runtime, and everything it
 * changes is changed by calling the coding service. Approvals are answered through the same
 * permission broker the desktop's own prompt uses.
 */
export class CodingApi {
  constructor(
    private readonly repository: DesktopRepository,
    private readonly coding: CodingService,
    /** The runtime's permission answer — the one path desktop and remote approvals share. */
    private readonly answer: (approvalId: string, allow: boolean) => void,
    /** Compute, when installed: read for the inventory of Computers a session can run on. */
    private readonly compute?: ComputeClient,
    /** CI on ephemeral Computers: the same service the desktop calls. */
    private readonly ci?: CiService,
    /** The project's development environment: the same service the desktop calls. */
    private readonly environments?: EnvironmentService
  ) {}

  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try { return await work() } catch (error) { throw classify(error) }
  }

  // ───────────────────────────── projects ─────────────────────────────

  async listProjects(): Promise<ProjectView[]> {
    return (await this.repository.projects()).map(projectView)
  }

  async getProject(id: string): Promise<ProjectView> {
    return projectView(await this.requireProject(id))
  }

  async projectConversation(id: string): Promise<{ id: string; projectId: string; workspace: string; agentIds: string[]; activeTopicId: string }> {
    await this.requireProject(id)
    const conversation = await this.repository.ensureProjectConversation(id)
    return { id: conversation.id, projectId: id, workspace: conversation.workspacePath!, agentIds: conversation.agentIds, activeTopicId: conversation.activeTopicId }
  }

  async addProject(path: string, name?: string): Promise<ProjectView> {
    if (typeof path !== 'string' || !path.trim()) throw new CodingApiError('invalid', 'A project needs a folder path.')
    try { return projectView(await this.coding.addProject(path, name)) } catch (error) { throw new CodingApiError('invalid', error instanceof Error ? error.message : String(error)) }
  }

  /** The project's `origin` URL as Git reports it (undefined when there is none). */
  async remoteUrl(projectId: string): Promise<string | undefined> {
    const project = await this.requireProject(projectId)
    return gitRemoteUrl(project.path)
  }

  async gitState(projectId: string): Promise<GitStateView> {
    await this.requireProject(projectId)
    return this.guarded(async () => {
      const state = await this.coding.gitStatus(projectId)
      return { projectId, ...(state.branch ? { branch: state.branch } : {}), ...(state.head ? { head: state.head } : {}),
        ...(state.upstream ? { upstream: state.upstream, ahead: state.ahead ?? 0, behind: state.behind ?? 0 } : {}),
        changes: state.changes.map(change => ({ path: change.path, code: change.code, ...(change.from ? { from: change.from } : {}) })) }
    })
  }

  private async requireProject(id: string): Promise<Project> {
    if (typeof id !== 'string' || !id) throw new CodingApiError('invalid', 'A project id is required.')
    const project = await this.repository.project(id)
    if (!project) throw new CodingApiError('not-found', 'Project not found')
    return project
  }

  /** The agents a session can be started with: identity only. */
  async listAgents(): Promise<{ id: string; name: string; local: boolean }[]> {
    return (await this.repository.agents()).map(agent => ({ id: agent.id, name: agent.name, local: agent.provider === 'local' }))
  }

  // ───────────────────────────── sessions ─────────────────────────────

  async listSessions(filter: { projectId?: string; status?: CodingSession['status'] } = {}): Promise<SessionView[]> {
    if (filter.projectId !== undefined) await this.requireProject(filter.projectId)
    const sessions = (await this.repository.codingSessions(filter.projectId)).filter(session => !filter.status || session.status === filter.status)
    sessions.sort((a, b) => b.createdAt - a.createdAt)
    return Promise.all(sessions.map(session => this.view(session)))
  }

  async getSession(id: string): Promise<SessionView> {
    return this.view(await this.requireSession(id))
  }

  async startSession(input: { projectId: string; agentId: string; task: string; execution?: { kind: 'local' | 'compute'; environment?: string } }): Promise<SessionView> {
    if (typeof input.task !== 'string' || !input.task.trim()) throw new CodingApiError('invalid', 'Describe the task for the agent.')
    if (input.task.length > MAX_TASK) throw new CodingApiError('invalid', `The task is too long (at most ${MAX_TASK} characters).`)
    await this.requireProject(input.projectId)
    if (typeof input.agentId !== 'string' || !(await this.repository.agent(input.agentId))) throw new CodingApiError('not-found', 'Agent not found')
    // Compute execution means the project's development environment; a client may name it, but it must be that one.
    const execution = input.execution?.kind === 'compute' ? { kind: 'compute' as const, ...(input.execution.environment ? { environment: input.execution.environment } : {}) } : undefined
    return this.guarded(async () => this.view(await this.coding.start({ projectId: input.projectId, agentId: input.agentId, task: input.task, ...(execution ? { execution } : {}) })))
  }

  async continueSession(id: string, text?: string): Promise<SessionView> {
    const session = await this.requireSession(id)
    if (session.status === 'running') throw new CodingApiError('conflict', 'This coding session is already running.')
    if (text !== undefined && (typeof text !== 'string' || text.length > MAX_TASK)) throw new CodingApiError('invalid', 'The instruction is too long.')
    return this.guarded(async () => this.view(await this.coding.continue(id, text)))
  }

  /** Stops a running session; the response is the session once it has ended. Disconnecting never does this. */
  async cancelSession(id: string): Promise<SessionView> {
    const session = await this.requireSession(id)
    if (session.status !== 'running') throw new CodingApiError('conflict', `This coding session is ${session.status}, not running.`)
    await this.guarded(() => this.coding.cancel(id))
    await this.coding.settled(id)
    return this.getSession(id)
  }

  private async requireSession(id: string): Promise<CodingSession> {
    if (typeof id !== 'string' || !id) throw new CodingApiError('invalid', 'A session id is required.')
    const session = await this.repository.codingSession(id)
    if (!session) throw new CodingApiError('not-found', 'Coding session not found')
    return session
  }

  // ───────────────────────────── Compute and PAX ─────────────────────────────

  /** What Compute reports: the installed product's platform label, and the Computers a session can run on. Read from Compute; nothing is kept. */
  async computeInventory(): Promise<ComputeInventory> {
    if (!this.compute) return { available: false, reason: 'Compute is not available in this build.', daemon: { endpoint: '', reachable: false }, environments: [] }
    return this.compute.inventory()
  }

  /** A read-only PAX inspection of the session's project, run where the session runs. PAX's answer, untouched. */
  async pax(sessionId: string, command: PaxInspection): Promise<PaxRun> {
    await this.requireSession(sessionId)
    if (!PAX_INSPECTIONS.includes(command)) throw new CodingApiError('invalid', `PAX inspection must be one of ${PAX_INSPECTIONS.join(', ')}.`)
    return this.guarded(() => this.coding.pax(sessionId, command))
  }

  // ───────────────────────────── the development environment ─────────────────────────────

  private requireEnvironments(): EnvironmentService {
    if (!this.environments) throw new CodingApiError('invalid', 'Compute environments are not available in this build.')
    return this.environments
  }

  private async requireProjectId(projectId: string): Promise<void> {
    if (typeof projectId !== 'string' || !projectId) throw new CodingApiError('invalid', 'A project id is required.')
    await this.requireProject(projectId)
  }

  /** The project's environment as Compute reports it now (a reference is all Foundry keeps). */
  async environment(projectId: string): Promise<DevelopmentEnvironmentView> {
    await this.requireProjectId(projectId)
    return this.guarded(() => this.requireEnvironments().view(projectId))
  }

  async environmentDetail(projectId: string): Promise<DevelopmentEnvironmentDetail> {
    await this.requireProjectId(projectId)
    return this.guarded(() => this.requireEnvironments().detail(projectId))
  }

  environmentRecipes(): Promise<RecipeSummary[]> { return this.guarded(() => this.requireEnvironments().recipes()) }

  environmentResolve(recipe: string, version?: number): Promise<RecipeResolutionView> {
    if (typeof recipe !== 'string' || !recipe) throw new CodingApiError('invalid', 'Name a recipe.')
    return this.guarded(() => this.requireEnvironments().resolve(recipe, version))
  }

  async createEnvironment(input: { projectId: string; recipe: string; version?: number }): Promise<DevelopmentEnvironmentView> {
    await this.requireProjectId(input.projectId)
    if (typeof input.recipe !== 'string' || !input.recipe) throw new CodingApiError('invalid', 'Name a recipe.')
    return this.guarded(() => this.requireEnvironments().create(input))
  }

  /** Restart, stop, start, retry or destroy. The response is Compute's state after the action, not the requested one. */
  async environmentAct(projectId: string, action: 'restart' | 'stop' | 'start' | 'retry' | 'destroy'): Promise<DevelopmentEnvironmentView> {
    await this.requireProjectId(projectId)
    if (!['restart', 'stop', 'start', 'retry', 'destroy'].includes(action)) throw new CodingApiError('invalid', 'Unknown environment action.')
    return this.guarded(() => this.requireEnvironments().act(projectId, action))
  }

  // ───────────────────────────── CI ─────────────────────────────

  private requireCi(): CiService {
    if (!this.ci) throw new CodingApiError('invalid', 'CI is not available in this build.')
    return this.ci
  }

  /** What Run CI would do for a project: its revision, the platform Compute states and PAX's plan — before anything runs. */
  ciPlan(projectId: string, tool?: string): Promise<CiPlan> {
    if (typeof projectId !== 'string' || !projectId) throw new CodingApiError('invalid', 'A project id is required.')
    return this.guarded(() => this.requireCi().plan(projectId, tool))
  }

  startCi(input: { projectId: string; tool?: string }): Promise<CiRun> {
    if (typeof input.projectId !== 'string' || !input.projectId) throw new CodingApiError('invalid', 'A project id is required.')
    return this.guarded(() => this.requireCi().start(input))
  }

  async getCi(id: string): Promise<CiRun> {
    const run = await this.requireCi().get(id)
    if (!run) throw new CodingApiError('not-found', 'CI run not found')
    return run
  }

  listCi(input: { projectId?: string; status?: CiRun['status'] } = {}): Promise<CiRun[]> {
    return this.requireCi().list(input.projectId).then(runs => input.status ? runs.filter(run => run.status === input.status) : runs)
  }

  /** Stops the workload, keeps the evidence and releases the Computer; the response is the run once it has ended. */
  async cancelCi(id: string): Promise<CiRun> {
    const run = await this.getCi(id)
    if (run.status !== 'running') throw new CodingApiError('conflict', `This CI run is ${run.status}, not running.`)
    await this.guarded(() => this.requireCi().cancel(id))
    return (await this.requireCi().settled(id)) ?? this.getCi(id)
  }

  // ───────────────────────────── approvals ─────────────────────────────

  /** What is waiting for an answer right now. Held by the runtime's broker, never stored. */
  async pendingApprovals(sessionId?: string): Promise<ApprovalView[]> {
    if (sessionId !== undefined) await this.requireSession(sessionId)
    const approvals: ApprovalView[] = []
    for (const activity of this.coding.activity()) {
      const request = activity.approval
      if (!request?.codingSession || (sessionId && activity.sessionId !== sessionId)) continue
      const { verb, target } = describeApproval(request, request.codingSession.workingDirectory)
      approvals.push({ id: request.id, sessionId: activity.sessionId, projectId: (await this.repository.codingSession(activity.sessionId))?.projectId ?? '', projectName: request.codingSession.projectName,
        agentId: request.agentId, agentName: request.agentName, workingDirectory: request.codingSession.workingDirectory, action: { verb, target }, requestedAt: request.createdAt })
    }
    return approvals
  }

  /**
   * Answer one approval, once. It must be pending *now* and belong to the session named: an approval
   * that expired (the session ended, was continued, or Foundry restarted) or that belongs to another
   * session is refused, and authorizes nothing.
   */
  async resolveApproval(input: { approvalId: string; sessionId: string; decision: 'approve' | 'deny' }): Promise<{ approvalId: string; decision: 'approve' | 'deny' }> {
    if (typeof input.approvalId !== 'string' || typeof input.sessionId !== 'string') throw new CodingApiError('invalid', 'An approval id and its session id are required.')
    if (input.decision !== 'approve' && input.decision !== 'deny') throw new CodingApiError('invalid', 'The decision is approve or deny.')
    const pending = await this.pendingApprovals()
    const approval = pending.find(item => item.id === input.approvalId)
    if (!approval) throw new CodingApiError('not-found', 'That approval is no longer pending.')
    if (approval.sessionId !== input.sessionId) throw new CodingApiError('conflict', 'That approval belongs to a different coding session.')
    try { this.answer(input.approvalId, input.decision === 'approve') } catch { throw new CodingApiError('not-found', 'That approval is no longer pending.') }
    return { approvalId: input.approvalId, decision: input.decision }
  }

  // ───────────────────────────── notices ─────────────────────────────

  subscribe(listener: (notification: CodingNotification) => void): () => void {
    return this.coding.subscribe(listener)
  }

  // ───────────────────────────── views ─────────────────────────────

  private async view(session: CodingSession): Promise<SessionView> {
    const [project, agent] = await Promise.all([this.repository.project(session.projectId), this.repository.agent(session.agentId)])
    const activity = session.status === 'running' ? this.coding.activity().find(item => item.sessionId === session.id) : undefined
    const pending = activity?.approval ? (await this.pendingApprovals(session.id))[0] : undefined
    return {
      id: session.id,
      project: { id: session.projectId, name: project?.name ?? session.projectId, path: project?.path ?? session.workingDirectory, isGit: project?.isGit ?? false, ...(session.baseline.branch ? { branch: session.baseline.branch } : {}) },
      agent: { id: session.agentId, name: agent?.name ?? session.agentId },
      task: session.task, status: session.status, workingDirectory: session.workingDirectory, createdAt: session.createdAt,
      ...(session.startedAt !== undefined ? { startedAt: session.startedAt } : {}), ...(session.finishedAt !== undefined ? { finishedAt: session.finishedAt } : {}),
      ...(session.result ? { result: session.result } : {}), ...(session.error ? { error: session.error } : {}),
      ...(activity ? { activity: { label: activity.label, origin: activityOrigin(activity.source), since: activity.since } } : {}),
      ...(pending ? { pendingApproval: pending } : {}),
      ...(session.execution ? { execution: session.execution.kind === 'compute' ? { kind: 'compute' as const, environment: session.execution.environment, repository: session.execution.repository } : { kind: 'local' as const } } : {}),
      changedFiles: session.changes.map(change => ({ path: change.path, code: change.code, ...(change.from ? { from: change.from } : {}), ...(change.origin ? { origin: change.origin } : {}) })),
      cleanedFiles: session.cleaned ?? [],
      ...(session.baseline.head ? { headAtStart: session.baseline.head } : {}), ...(session.finalHead ? { headAtEnd: session.finalHead } : {}),
      checks: session.commands.map(checkView),
      history: session.events.map(event => ({ at: event.at, kind: event.kind, label: event.label, ...(event.detail ? { detail: event.detail } : {}) }))
    }
  }
}
