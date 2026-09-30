import type { PermissionEvent } from '../agentPermissions'
import type { CodingActivity, CodingEvent, CodingSession, CommandResult, ExecutionTarget, GitDiffMode, GitState, Project, ProjectCommandOption } from '../../shared/types'
import type { LocalLauncher } from '../../shared/agentExecutor'
import { ComputeClient } from '../compute/client'
import { EnvironmentRefusal, type Admission, type EnvironmentService } from '../environment/service'
import { computeLauncher, ComputeInterruption } from '../compute/launcher'
import { PAX_OPERATIONS, runPax, type PaxInspection, type PaxOperation, type PaxRun } from '../compute/pax'
import { DEFERRED_WORK_ERROR, describeApproval, formatCommandLine, isDeferredWorkReply } from '../../shared/coding'
import type { CodingNotification } from '../../shared/codingApi'
import type { DesktopRepository } from '../desktopRepository'
import { resolveSavedWorkspace, validateWorkspaceFolder } from '../localWorkspaces'
import type { EphemeralState } from '../projection'
import { runCommand } from './commands'
import { accountChanges, gitCommit, gitDiff, gitRemoteUrl, gitRoot, gitStage, gitStatus, gitUnstage, type GitLocation } from './git'

/** What the service needs from the agent runtime: run a turn in a chat, stop it, and tell it what is going on. */
export interface CodingRuntime {
  sendMessage(conversationId: string, text: string): Promise<void>
  stopConversation(conversationId: string): Promise<void>
  ephemeralState?(): EphemeralState
  setTurnGuard?(guard: ((turn: { conversationId: string; topicId: string }) => Promise<void>) | undefined): void
  /** Withdraw an agent's pending approvals and reusable grants. */
  expirePermissions?(agentId: string): void
  /** Where a chat's agent process is started when not here (a Compute Computer). */
  setLaunchResolver?(resolver: ((turn: { conversationId: string; topicId: string }) => LocalLauncher | undefined) | undefined): void
  observePermissions?(observer: ((event: PermissionEvent) => void) | undefined): void
}

const MAX_COMMANDS = 20
const CHECK_TIMEOUT_MS = 10 * 60_000
const RESUME_PROMPT = 'Continue where you left off. Check the repository’s current state first.'
const INTERRUPTED_PROMPT = 'Your previous turn was interrupted when Foundry closed, so its process is gone. Check the repository’s current state and continue the task.'
const workPrompt = (task: string): string => `${task}\n\nFOUNDRY-WORK-CONTEXT\nThis is an executable project-work session, not a planning chat. Work directly in the current repository and complete the request in this turn. Inspect the existing project before deciding what to change. If the request calls for implementation, make the changes and verify them before replying. Do not merely announce that you are checking, reviewing, starting, or that you will provide details later. Return the concrete completed result, or a specific blocker and what remains undone.`

/** Live facts about one running session: the process side of it, gone when the app closes. */
interface Live { topicId: string; projectId: string; sessionId: string; agentId: string; conversationId: string; projectName: string; workingDirectory: string; task: string; since: number }

/**
 * Coding sessions: an agent working in a project folder.
 *
 * Coding is a mode of the ordinary agent runtime, not a second one: a session
 * runs its agent through the same chat turn (same conversation, topic, workspace
 * and native thread) that a person typing in the chat would use. The folder is the
 * authority for the code; FeltDB records that the project and the session exist,
 * which agent and chat carry it, what happened and what it produced. The OS
 * processes are transient: a session that was still running when the app closed
 * becomes `interrupted`, and continuing it starts a new turn on the same
 * conversation — never a reattachment to the old process.
 *
 * A session's working directory is fixed when it starts. While it runs, the chat
 * cannot be pointed elsewhere (the repository refuses), and every turn in the
 * session's topic is checked against it before anything is stored or started.
 */
export class CodingService {
  private readonly turns = new Map<string, Promise<CodingSession>>()
  private readonly aborts = new Map<string, Set<AbortController>>()
  private readonly cancelled = new Set<string>()
  private readonly live = new Map<string, Live>()
  private recording: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(notification: CodingNotification) => void>()

  /** A session that runs on a Compute Computer: its launcher (this turn's), and whether the Computer was lost while it ran. */
  private readonly onCompute = new Map<string, { launcher: LocalLauncher; interruption?: ComputeInterruption }>()
  private readonly compute?: ComputeClient
  private readonly environments?: EnvironmentService
  private readonly paxPath: string

  constructor(private readonly repository: DesktopRepository, private readonly runtime: CodingRuntime, private readonly onActivityChange: () => void = () => undefined, options: { compute?: ComputeClient; environments?: EnvironmentService; pax?: string } = {}) {
    this.compute = options.compute
    this.environments = options.environments
    this.paxPath = options.pax ?? process.env.FOUNDRY_PAX ?? 'pax'
    runtime.setLaunchResolver?.(turn => {
      const live = [...this.live.values()].find(item => item.conversationId === turn.conversationId && item.topicId === turn.topicId)
      return live ? this.onCompute.get(live.sessionId)?.launcher : undefined
    })
    runtime.setTurnGuard?.(turn => this.guard(turn))
    runtime.observePermissions?.(event => this.permission(event))
  }

  /**
   * Live notices about sessions, for whoever is listening now (the desktop, an AppPort host). Nothing is
   * queued or replayed: a listener that was away reads the session's durable history instead.
   */
  subscribe(listener: (notification: CodingNotification) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private announce(name: CodingNotification['name'], session: Pick<CodingSession, 'id' | 'projectId'>, payload: CodingNotification['payload'] = {}): void {
    if (!this.listeners.size) return
    const notification: CodingNotification = { name, sessionId: session.id, projectId: session.projectId, at: Date.now(), origin: 'douchat', payload }
    for (const listener of [...this.listeners]) { try { listener(notification) } catch { /* a listener never affects a session */ } }
  }

  /** Sessions the last run left `running` are `interrupted`; tell whoever is already listening. */
  announceInterrupted(sessions: readonly CodingSession[]): void {
    for (const session of sessions) this.announce('session.interrupted', session, { status: 'interrupted' })
  }

  // ───────────────────────────── projects ─────────────────────────────

  /** Register a folder as a project. The same folder is the same project. */
  async addProject(path: string, name?: string): Promise<Project> {
    const directory = validateWorkspaceFolder(path)
    const root = await gitRoot(directory)
    return this.repository.addProject({ path: directory, name: name?.trim() || directory.split(/[\\/]/).filter(Boolean).at(-1) || directory, isGit: root !== undefined })
  }

  private async requireProject(id: string): Promise<{ project: Project; directory: string }> {
    const project = await this.repository.project(id)
    if (!project) throw new Error('Project not found')
    // A project folder may have moved or been deleted since it was added; it is never recreated.
    return { project, directory: resolveSavedWorkspace(project.path) }
  }

  // ───────────────────────────── the repository, as it is right now ─────────────────────────────

  /** Where Git is asked for a project — or, for a session that runs on a Compute Computer, for that session: the checkout on the Computer. */
  private async gitWhere(projectId: string, sessionId?: string): Promise<GitLocation> {
    const { directory } = await this.requireProject(projectId)
    const session = sessionId ? await this.repository.codingSession(sessionId) : undefined
    return session?.execution?.kind === 'compute' && session.projectId === projectId ? this.remoteGit(session.execution) : directory
  }

  async gitStatus(projectId: string, sessionId?: string): Promise<GitState> {
    return gitStatus(await this.gitWhere(projectId, sessionId), undefined, { fingerprints: true })
  }

  async gitDiff(projectId: string, path?: string, sessionId?: string, mode?: GitDiffMode): Promise<{ diff: string; truncated: boolean }> {
    return gitDiff(await this.gitWhere(projectId, sessionId), { path, mode })
  }

  /**
   * The developer's own Git actions on the project's folder. Git is the only authority: these run `git add`, `git restore --staged` and
   * `git commit` and return what Git then says. They are refused while a coding session runs in the project, because staging or committing
   * under a running agent would change what the session's change accounting compares against.
   */
  private async gitWritable(projectId: string): Promise<string> {
    const { project, directory } = await this.requireProject(projectId)
    if (!project.isGit) throw new Error('This project is not a Git repository.')
    if ((await this.repository.codingSessions(projectId)).some(session => session.status === 'running')) {
      throw new Error('A coding session is running in this project. Stage and commit when it has finished, or cancel it first.')
    }
    return directory
  }

  async gitStage(projectId: string, paths: string[]): Promise<GitState> { return gitStage(await this.gitWritable(projectId), paths) }
  async gitUnstage(projectId: string, paths: string[]): Promise<GitState> { return gitUnstage(await this.gitWritable(projectId), paths) }
  async gitCommit(projectId: string, message: string): Promise<{ state: GitState; commit: string; summary: string }> { return gitCommit(await this.gitWritable(projectId), message) }

  // ───────────────────────────── running on a Compute Computer ─────────────────────────────

  private requireCompute(): ComputeClient {
    if (!this.compute) throw new Error('Compute is not available in this build.')
    return this.compute
  }

  /** Git, asked on the Computer: the same commands, run in the repository's checkout there as Compute jobs. */
  private remoteGit(target: Extract<ExecutionTarget, { kind: 'compute' }>): GitLocation {
    const compute = this.requireCompute()
    return { execute: (argv, options) => compute.exec(target.environment, argv, { repository: target.repository, signal: options.signal, timeoutMs: 60_000 }) }
  }

  /** What Foundry asks PAX about the session's project, run where the session runs (the Computer, or here). Answers are PAX's, untouched. */
  async pax(sessionId: string, command: PaxInspection | PaxOperation, options: { dryRun?: boolean; tool?: string } = {}): Promise<PaxRun> {
    const session = await this.repository.codingSession(sessionId)
    if (!session) throw new Error('Coding session not found')
    if (session.execution?.kind === 'compute') {
      const target = session.execution
      const compute = this.requireCompute()
      return runPax((argv, o) => compute.exec(target.environment, argv, { repository: target.repository, signal: o.signal, timeoutMs: 10 * 60_000 }), this.paxPath, command, options)
    }
    return runPax((argv, o) => runCommand(argv, { cwd: session.workingDirectory, signal: o.signal, timeoutMs: 10 * 60_000 }), this.paxPath, command, options)
  }

  /** PAX's read-only answer about the project folder on this computer (`info`, `drift`). Not installed → a plain message, not a failure of the workbench. */
  async paxProject(projectId: string, command: 'info' | 'drift'): Promise<PaxRun> {
    const { directory } = await this.requireProject(projectId)
    try { return await runPax((argv, o) => runCommand(argv, { cwd: directory, signal: o.signal, timeoutMs: 30_000 }), this.paxPath, command) }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || /ENOENT|not found|spawn/i.test(error instanceof Error ? error.message : '')) throw new Error('PAX is not installed, so project tooling is not shown.')
      throw error
    }
  }

  /** Ask PAX which native verification commands this project supports. Dry-run plans are discovery only; nothing executes. */
  async discoverProjectCommands(projectId: string): Promise<ProjectCommandOption[]> {
    const { directory } = await this.requireProject(projectId)
    try {
      const runs = await Promise.all(PAX_OPERATIONS.map(operation => runPax(
        (argv, options) => runCommand(argv, { cwd: directory, signal: options.signal, timeoutMs: 30_000 }),
        this.paxPath,
        operation,
        { dryRun: true }
      )))
      return runs.flatMap((run): ProjectCommandOption[] => {
        const plan = run.json as { command?: unknown; tool?: unknown; evidence?: unknown; supported?: unknown } | undefined
        if (run.exitCode !== 0 || plan?.supported === false || !Array.isArray(plan?.command) || !plan.command.length || !plan.command.every(part => typeof part === 'string')) return []
        return [{
          operation: run.command as ProjectCommandOption['operation'],
          command: plan.command as string[],
          ...(typeof plan.tool === 'string' ? { tool: plan.tool } : {}),
          ...(Array.isArray(plan.evidence) && plan.evidence.every(item => typeof item === 'string') ? { evidence: plan.evidence as string[] } : {})
        }]
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || /ENOENT|not found|spawn/i.test(error instanceof Error ? error.message : '')) throw new Error('PAX is not installed, so project commands cannot be discovered.')
      throw error
    }
  }

  /**
   * A workload runs on the project's development environment or not at all. The environment must exist, be the one this project references,
   * and be one Compute says admits workloads (ready); otherwise this throws the reason and nothing runs — here or anywhere else.
   */
  private async admit(projectId: string, named?: string): Promise<Admission> {
    if (!this.environments) throw new Error('Compute environments are not available in this build.')
    const admission = await this.environments.admit(projectId)
    if (named && named !== admission.environment) throw new EnvironmentRefusal('mismatch', `“${named}” is not this project's environment (that is “${admission.environment}”).`, admission.view.state)
    return admission
  }

  /**
   * Make the project available on the Computer through Compute's own mechanism — a repository in the environment, checked out at
   * a revision — and return what Foundry records: a reference, never the Computer's state. Uncommitted local changes are not on
   * the Computer, and the session says so.
   */
  private async prepareCompute(project: Project, directory: string, environment: string): Promise<{ target: Extract<ExecutionTarget, { kind: 'compute' }>; workingDirectory: string; notes: string[] }> {
    const compute = this.requireCompute()
    const computer = await compute.computer(environment)
    if (computer.observed !== 'running') throw new Error(`The Computer for environment "${environment}" is ${computer.observed}${computer.explanation ? ` (${computer.explanation})` : ''}. Start it in Compute first.`)
    const repository = `foundry-${project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'project'}-${project.id.slice(-8)}`
    const notes: string[] = []
    const local = project.isGit ? await gitStatus(directory).catch(() => undefined) : undefined
    if (!computer.repositories[repository]) {
      if (!project.isGit) throw new Error('Only a Git project can be checked out on a Computer.')
      const origin = await gitRemoteUrl(directory)
      await compute.addRepository(environment, repository, origin ?? `file://${directory}`, local?.branch ?? local?.head ?? 'HEAD')
      const deadline = Date.now() + 90_000
      for (;;) {
        const now = await compute.computer(environment)
        if (now.repositories[repository]?.commit) break
        if (Date.now() > deadline) throw new Error(`The repository did not appear in the Computer within 90 seconds (environment "${environment}").`)
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
    const there = (await compute.computer(environment)).repositories[repository]
    if (local?.changes.length) notes.push(`${local.changes.length} uncommitted local file${local.changes.length === 1 ? ' is' : 's are'} not on the Computer`)
    if (local?.head && there?.commit && local.head !== there.commit) notes.push(`the Computer's checkout is at ${there.commit.slice(0, 8)}, local HEAD is ${local.head.slice(0, 8)}`)
    const target = { kind: 'compute' as const, environment, environmentId: computer.environmentId, repository }
    const pwd = await compute.exec(environment, ['pwd'], { repository, timeoutMs: 30_000 })
    return { target, workingDirectory: pwd.stdout.trim(), notes }
  }

  /** This turn's launcher: agents started through it run on the Computer, in the session's checkout. */
  private async computeLauncherFor(session: CodingSession): Promise<LocalLauncher | undefined> {
    if (session.execution?.kind !== 'compute') return undefined
    const compute = this.requireCompute()
    const target = session.execution
    // Every turn is admitted again: the environment may have been stopped, lost, or replaced since the last one.
    const admitted = await this.admit(session.projectId).catch(error => { if (error instanceof EnvironmentRefusal) throw new ComputeInterruption(`${error.message} The task did not start.`, error.state); throw error })
    if (admitted.environment !== target.environment) throw new ComputeInterruption(`This project's environment is now “${admitted.environment}”, not “${target.environment}”, where this session ran. The task did not start.`, 'replaced')
    const computer = await compute.computer(target.environment)
    if (computer.observed !== 'running') throw new ComputeInterruption(`The Computer for environment "${target.environment}" is ${computer.observed}. The task did not start.`, computer.observed)
    const pwd = await compute.exec(target.environment, ['pwd'], { repository: target.repository, timeoutMs: 30_000 })
    const holder: { launcher: LocalLauncher; interruption?: ComputeInterruption } = {
      launcher: computeLauncher(compute, { environment: target.environment, repository: target.repository, workingDirectory: pwd.stdout.trim() }, session.id, error => { holder.interruption = error })
    }
    this.onCompute.set(session.id, holder)
    return holder.launcher
  }

  // ───────────────────────────── the pinned folder ─────────────────────────────

  /**
   * Called before every turn in any chat. If the turn is in a coding session's
   * topic, the chat's folder must still be the session's; otherwise it is refused.
   */
  private async guard(turn: { conversationId: string; topicId: string }): Promise<void> {
    const session = (await this.repository.codingSessions()).find(item => item.conversationId === turn.conversationId && item.topicId === turn.topicId)
    if (!session) return
    const conversation = await this.repository.conversation(turn.conversationId)
    if (conversation?.workspacePath !== session.workingDirectory) {
      throw new Error(`This coding session is pinned to ${session.workingDirectory}, but the chat's folder is ${conversation?.workspacePath ?? 'not set'}. Refusing to run in a different folder.`)
    }
  }

  // ───────────────────────────── sessions ─────────────────────────────

  /**
   * Start an agent on a project. Returns as soon as the session exists; the turn
   * runs on, and `settled` resolves with the finished session. Each session gets
   * its own topic, so its conversation stays apart from the agent's other chats.
   */
  async start(input: { projectId: string; agentId: string; task: string; execution?: { kind: 'local' } | { kind: 'compute'; environment?: string } }): Promise<CodingSession> {
    const task = input.task.trim()
    if (!task) throw new Error('Describe the task for the agent.')
    const { project, directory } = await this.requireProject(input.projectId)
    const agent = await this.repository.agent(input.agentId)
    if (!agent) throw new Error('Agent not found')
    if ((await this.repository.codingSessions()).some(session => session.agentId === agent.id && session.status === 'running')) {
      throw new Error('This agent is already working on a coding session.')
    }
    // An explicit Compute choice is honoured or refused, before anything else is created: it never becomes a local session.
    let execution: ExecutionTarget | undefined
    let where: GitLocation = directory
    const notes: string[] = []
    if (input.execution?.kind === 'compute') {
      let prepared: Awaited<ReturnType<CodingService['prepareCompute']>>
      try { prepared = await this.prepareCompute(project, directory, (await this.admit(project.id, input.execution.environment)).environment) }
      catch (error) { throw new Error(`Compute was selected, so nothing was started on this computer. ${error instanceof Error ? error.message : String(error)}`) }
      execution = prepared.target; where = this.remoteGit(prepared.target); notes.push(`runs on Computer "${prepared.target.environment}" in ${prepared.workingDirectory}`, ...prepared.notes)
    }
    const { conversation } = await this.repository.ensureDirectConversation(agent.id)
    // The runtime takes its working directory from the chat, so the chat is pointed at the project first.
    if (conversation.workspacePath !== directory) await this.repository.setConversationWorkspace(conversation.id, directory)
    const topic = await this.repository.createTopic(conversation.id)
    if (!topic) throw new Error('Could not open a topic for this session.')
    await this.repository.renameTopic(conversation.id, topic.id, `Coding: ${task}`.slice(0, 80))
    const baseline = project.isGit || execution ? await gitStatus(where, undefined, { fingerprints: true }) : { changes: [] }
    const session = await this.repository.createCodingSession({
      projectId: project.id, agentId: agent.id, conversationId: conversation.id, topicId: topic.id, workingDirectory: directory,
      task, status: 'running', startedAt: Date.now(), baseline, ...(execution ? { execution } : {}),
      events: [{ at: Date.now(), kind: 'started', label: execution ? 'Agent started on Compute' : 'Agent started', detail: `${task.slice(0, 200)}${baseline.changes.length ? ` — ${baseline.changes.length} file${baseline.changes.length === 1 ? ' was' : 's were'} already modified` : ''}${notes.length ? ` — ${notes.join('; ')}` : ''}` }]
    })
    this.announce('session.started', session, { task: task.slice(0, 200), agentId: agent.id, alreadyModified: baseline.changes.length, execution: execution ? 'compute' : 'local' })
    this.turns.set(session.id, this.execute(session, project, directory, task))
    return session
  }

  /**
   * Another turn in a finished session — same project, agent, chat, topic and folder.
   * For an interrupted session this is the way back: the old process is gone, so a
   * new one starts, and Codex/Claude pick the conversation up from their native thread.
   */
  async continue(id: string, text?: string): Promise<CodingSession> {
    const existing = await this.repository.codingSession(id)
    if (!existing) throw new Error('Coding session not found')
    const { project, directory } = await this.requireProject(existing.projectId)
    if (directory !== existing.workingDirectory) throw new Error(`This session is pinned to ${existing.workingDirectory}, which is no longer the project's folder.`)
    // Another session in this chat may have moved the folder since; the session's own folder is the authority, and it is restored.
    const conversation = await this.repository.conversation(existing.conversationId)
    if (!conversation) throw new Error('The conversation of this session no longer exists.')
    if (conversation.workspacePath !== directory) await this.repository.setConversationWorkspace(conversation.id, directory)
    const prompt = text?.trim() || (existing.status === 'interrupted' ? INTERRUPTED_PROMPT : RESUME_PROMPT)
    const session = await this.repository.resumeCodingSession(id)
    this.announce('session.continued', session, { after: existing.status })
    this.turns.set(session.id, this.execute(session, project, directory, prompt))
    return session
  }

  /** Resolves with the finished session. */
  settled(id: string): Promise<CodingSession | undefined> {
    return this.turns.get(id) ?? this.repository.codingSession(id)
  }

  private async execute(session: CodingSession, project: Project, directory: string, prompt: string): Promise<CodingSession> {
    const started = session.startedAt ?? Date.now()
    this.live.set(session.id, { topicId: session.topicId, projectId: session.projectId, sessionId: session.id, agentId: session.agentId, conversationId: session.conversationId, projectName: project.name, workingDirectory: directory, task: session.task, since: started })
    this.onActivityChange()
    let failure: string | undefined
    // Whatever an earlier session was granted or asked is withdrawn: an approval belongs to one running session.
    this.runtime.expirePermissions?.(session.agentId)
    let launchFailure: ComputeInterruption | undefined
    try {
      // On a Compute session the agent's process is started on the Computer; the Computer must be there.
      await this.computeLauncherFor(session).catch(error => { if (error instanceof ComputeInterruption) { launchFailure = error; return undefined }; throw error })
      // The folder is checked, never changed, before the turn: a mismatch stops the session instead of retargeting it.
      const conversation = await this.repository.conversation(session.conversationId)
      if (conversation?.workspacePath !== directory) throw new Error(`The chat's folder (${conversation?.workspacePath ?? 'not set'}) no longer matches this session's (${directory}). Refusing to run in a different folder.`)
      await this.repository.setActiveTopic(session.conversationId, session.topicId)
      // Cancelled before the agent was ever started: there is nothing to stop.
      if (launchFailure) throw launchFailure
      if (!this.cancelled.has(session.id)) await this.runtime.sendMessage(session.conversationId, workPrompt(prompt))
    } catch (error) { failure = error instanceof Error ? error.message : String(error) }
    // The session is over, so anything still waiting for an answer can no longer be approved.
    this.runtime.expirePermissions?.(session.agentId)
    const run = (await this.repository.runs()).filter(item => item.conversationId === session.conversationId && item.createdAt >= started).sort((a, b) => b.createdAt - a.createdAt)[0]
    const reply = (await this.repository.topicMessages(session.conversationId, session.topicId)).filter(message => message.authorId === session.agentId && message.kind === 'message' && message.createdAt >= started).at(-1)
    let status: CodingSession['status'] = 'succeeded'
    if (this.cancelled.has(session.id) || run?.status === 'cancelled') status = 'cancelled'
    else if (this.onCompute.get(session.id)?.interruption || launchFailure) status = 'interrupted'
    else if (failure || !run || run.status === 'failed' || run.status === 'interrupted') status = 'failed'
    // Compared with the state at the start of the *first* turn: what was already dirty is never credited to the session.
    const whereNow: GitLocation = session.execution?.kind === 'compute' ? this.remoteGit(session.execution) : directory
    const finalState = project.isGit || session.execution ? await gitStatus(whereNow, undefined, { fingerprints: true }).catch(() => undefined) : undefined
    const { changes, cleaned } = finalState ? accountChanges(session.baseline.changes, finalState.changes) : { changes: session.changes, cleaned: session.cleaned ?? [] }
    this.cancelled.delete(session.id)
    const interruption = this.onCompute.get(session.id)?.interruption ?? launchFailure
    this.onCompute.delete(session.id)
    const during = changes.filter(change => change.origin === 'session').length
    const already = changes.length - during
    const headMoved = finalState?.head !== undefined && session.baseline.head !== undefined && finalState.head !== session.baseline.head
    const toolSucceeded = reply?.actions?.some(action => action.status === 'succeeded') === true
    let completionFailure: string | undefined
    if (status === 'succeeded' && !during && !cleaned.length && !headMoved && !toolSucceeded && isDeferredWorkReply(reply?.text ?? '')) {
      status = 'failed'
      completionFailure = DEFERRED_WORK_ERROR
    }
    const error = interruption?.message ?? failure ?? run?.error ?? completionFailure
    this.announce('files.changed', session, { during, alreadyModified: already, cleaned: cleaned.length, headMoved })
    await this.record(session.id, { kind: 'changes', label: during ? `${during} file${during === 1 ? '' : 's'} changed during this session` : 'No files changed during this session',
      detail: [already ? `${already} already modified before it started` : '', cleaned.length ? `${cleaned.length} modified before, clean now` : '', headMoved ? 'HEAD moved to a new commit' : ''].filter(Boolean).join(' · ') || undefined })
    await this.record(session.id, { kind: status === 'interrupted' ? 'interrupted' : 'finished', label: status === 'succeeded' ? 'Agent finished' : status === 'cancelled' ? 'Cancelled' : status === 'interrupted' ? 'Interrupted: the Computer stopped answering' : 'Failed', ...(error ? { detail: error.slice(0, 300) } : {}) })
    const finished = await this.repository.updateCodingSession(session.id, {
      status, finishedAt: Date.now(), changes, cleaned, ...(finalState?.head ? { finalHead: finalState.head } : {}), ...(run ? { runId: run.id } : {}), ...(reply ? { result: reply.text } : {}), ...(error ? { error } : { error: undefined })
    })
    this.live.delete(session.id)
    this.announce('session.finished', session, { status, ...(error ? { error: error.slice(0, 300) } : {}) })
    this.onActivityChange()
    return finished ?? session
  }

  /**
   * Stop a session: the agent's turn and any command Foundry is running for it.
   * Their whole process trees are killed; the session ends `cancelled`.
   */
  async cancel(id: string): Promise<void> {
    const session = await this.repository.codingSession(id)
    if (!session || session.status !== 'running') return
    this.cancelled.add(id)
    for (const abort of this.aborts.get(id) ?? []) abort.abort()
    // The turn may still be starting, before the runtime has anything to stop, so keep stopping until it has ended.
    const turn = this.turns.get(id)
    let ended = false
    void turn?.then(() => { ended = true }, () => { ended = true })
    while (turn && !ended) {
      await this.runtime.stopConversation(session.conversationId)
      await Promise.race([turn.catch(() => undefined), new Promise(resolve => setTimeout(resolve, 100))])
    }
  }

  // ───────────────────────────── commands and checks ─────────────────────────────

  /** Run a program in the session's working directory and record the result with the session. */
  async runCommand(id: string, argv: string[], options: { timeoutMs?: number; event?: 'command' | 'checks' } = {}): Promise<CommandResult> {
    const session = await this.repository.codingSession(id)
    if (!session) throw new Error('Coding session not found')
    this.announce('check.started', session, { command: formatCommandLine(argv), kind: options.event ?? 'command' })
    const controller = new AbortController()
    const set = this.aborts.get(id) ?? new Set<AbortController>()
    set.add(controller); this.aborts.set(id, set)
    try {
      const result = session.execution?.kind === 'compute'
        ? await this.requireCompute().exec(session.execution.environment, argv, { repository: session.execution.repository, signal: controller.signal, timeoutMs: options.timeoutMs ?? CHECK_TIMEOUT_MS })
        : await runCommand(argv, { cwd: session.workingDirectory, signal: controller.signal, timeoutMs: options.timeoutMs ?? CHECK_TIMEOUT_MS })
      // Read again: the session may have changed while the command ran.
      const latest = (await this.repository.codingSession(id)) ?? session
      await this.repository.updateCodingSession(id, { commands: [...latest.commands, result].slice(-MAX_COMMANDS) })
      const ok = result.exitCode === 0
      await this.record(id, { kind: options.event ?? 'command', label: `${options.event === 'checks' ? 'Tests' : 'Command'} completed ${ok ? '✓' : '✗'}`,
        detail: `${formatCommandLine(argv)} — ${result.cancelled ? 'cancelled' : result.timedOut ? 'timed out' : `exit ${result.exitCode ?? result.signal}`}` })
      this.announce('check.completed', session, { command: formatCommandLine(argv), kind: options.event ?? 'command', ok, exitCode: result.exitCode, cancelled: result.cancelled === true, timedOut: result.timedOut === true })
      return result
    } finally { set.delete(controller); if (!set.size) this.aborts.delete(id) }
  }

  /** Run the project's own check (its `testCommand`), if it has one. */
  async runChecks(id: string): Promise<CommandResult | undefined> {
    const session = await this.repository.codingSession(id)
    const project = session && await this.repository.project(session.projectId)
    if (!project?.testCommand?.length) return undefined
    return this.runCommand(id, project.testCommand, { event: 'checks' })
  }

  // ───────────────────────────── live activity ─────────────────────────────

  /** What each running session is doing right now, from the runtime's live state. Never stored. */
  activity(): CodingActivity[] {
    const state = this.runtime.ephemeralState?.()
    return [...this.live.values()].map((live): CodingActivity => {
      const approval = state?.permissionRequests.find(request => request.agentId === live.agentId)
      if (approval) {
        const { verb, target } = describeApproval(approval)
        return { sessionId: live.sessionId, state: 'awaiting-approval', label: `Waiting for approval: ${verb} ${target}`.slice(0, 200), since: approval.createdAt, source: 'douchat',
          approval: { ...approval, codingSession: { id: live.sessionId, projectName: live.projectName, workingDirectory: live.workingDirectory, task: live.task } } }
      }
      const conversation = state?.activity.find(item => item.conversationId === live.conversationId)
      // Only what the agent itself reported is shown as its activity; with nothing reported, the label says so.
      const reported = conversation?.localProgress?.detail || (conversation?.action ? `Running ${conversation.action.tool}` : undefined)
      if (reported) return { sessionId: live.sessionId, state: 'running', label: String(reported).slice(0, 200), source: 'agent', since: live.since }
      return { sessionId: live.sessionId, state: 'running', label: 'Running…', source: 'none', since: live.since }
    })
  }

  /** A permission request for an agent that is coding becomes part of that session's history. */
  private permission(event: PermissionEvent): void {
    const live = [...this.live.values()].find(item => item.agentId === event.request.agentId)
    if (!live) return
    const { verb, target } = describeApproval(event.request, live.workingDirectory)
    const target_ = { id: live.sessionId, projectId: live.projectId }
    if (event.kind === 'requested') this.announce('approval.requested', target_, { approvalId: event.request.id, action: `${verb} ${target}` })
    else this.announce('approval.resolved', target_, { approvalId: event.request.id, outcome: event.outcome, action: `${verb} ${target}` })
    if (event.kind === 'requested') void this.record(live.sessionId, { kind: 'approval-requested', label: 'Approval requested', detail: `${verb} ${target}` })
    else if (event.outcome === 'allowed') void this.record(live.sessionId, { kind: 'approval-allowed', label: 'Allowed', detail: `${verb} ${target}` })
    else void this.record(live.sessionId, { kind: 'approval-denied', label: event.outcome === 'declined' ? 'Denied' : `Approval ${event.outcome}`, detail: `${verb} ${target}` })
  }

  /** Events are stored in the order they happened. */
  private record(id: string, event: Omit<CodingEvent, 'at'>): Promise<void> {
    this.recording = this.recording.then(() => this.repository.addCodingEvent(id, event)).catch(() => undefined)
    return this.recording
  }

  /** Everything started so far has finished, including recorded events. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.turns.values()])
    await this.recording
  }

  /** For shutdown: stop every running session so each records its final state. */
  async cancelAll(): Promise<void> {
    const running = (await this.repository.codingSessions()).filter(session => session.status === 'running')
    await Promise.allSettled(running.map(session => this.cancel(session.id)))
  }
}
