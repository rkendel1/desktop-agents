import type { CodingSession, CommandResult, GitState, Project } from '../../shared/types'
import type { DesktopRepository } from '../desktopRepository'
import { resolveSavedWorkspace, validateWorkspaceFolder } from '../localWorkspaces'
import { runCommand } from './commands'
import { gitDiff, gitRoot, gitStatus } from './git'

/** What the service needs from the agent runtime: run a turn in a chat, and stop it. */
export interface CodingRuntime {
  sendMessage(conversationId: string, text: string): Promise<void>
  stopConversation(conversationId: string): Promise<void>
}

const MAX_COMMANDS = 20
const CHECK_TIMEOUT_MS = 10 * 60_000

/**
 * Coding sessions: an agent working in a project folder.
 *
 * The folder is the authority for the code; FeltDB records that the project and
 * the session exist, which agent and chat carry it, and what it produced. A
 * session runs the agent through the ordinary chat runtime, so its messages,
 * run and events are the chat's own. The OS processes are transient: nothing
 * here keeps a handle across a restart, and a session that was still running
 * when the app closed is marked `interrupted`.
 */
export class CodingService {
  private readonly turns = new Map<string, Promise<CodingSession>>()
  private readonly aborts = new Map<string, Set<AbortController>>()
  private readonly cancelled = new Set<string>()

  constructor(private readonly repository: DesktopRepository, private readonly runtime: CodingRuntime) {}

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

  async gitStatus(projectId: string): Promise<GitState> {
    const { directory } = await this.requireProject(projectId)
    return gitStatus(directory)
  }

  async gitDiff(projectId: string, path?: string): Promise<{ diff: string; truncated: boolean }> {
    const { directory } = await this.requireProject(projectId)
    return gitDiff(directory, { path })
  }

  // ───────────────────────────── sessions ─────────────────────────────

  /**
   * Start an agent on a project. Returns as soon as the session exists; the turn
   * runs on, and `settled` resolves with the finished session. Each session gets
   * its own topic, so its conversation stays apart from the agent's other chats.
   */
  async start(input: { projectId: string; agentId: string; task: string }): Promise<CodingSession> {
    const task = input.task.trim()
    if (!task) throw new Error('Describe the task for the agent.')
    const { project, directory } = await this.requireProject(input.projectId)
    const agent = await this.repository.agent(input.agentId)
    if (!agent) throw new Error('Agent not found')
    if ((await this.repository.codingSessions()).some(session => session.agentId === agent.id && session.status === 'running')) {
      throw new Error('This agent is already working on a coding session.')
    }
    const { conversation } = await this.repository.ensureDirectConversation(agent.id)
    // The runtime takes its working directory from the chat, so the chat is pointed at the project first.
    if (conversation.workspacePath !== directory) await this.repository.setConversationWorkspace(conversation.id, directory)
    const topic = await this.repository.createTopic(conversation.id)
    if (!topic) throw new Error('Could not open a topic for this session.')
    await this.repository.renameTopic(conversation.id, topic.id, `Coding: ${task}`.slice(0, 80))
    const baseline = project.isGit ? await gitStatus(directory) : { changes: [] }
    const session = await this.repository.createCodingSession({
      projectId: project.id, agentId: agent.id, conversationId: conversation.id, topicId: topic.id, workingDirectory: directory,
      task, status: 'running', startedAt: Date.now(), baseline
    })
    this.turns.set(session.id, this.execute(session, project, directory))
    return session
  }

  /** Resolves with the finished session. */
  settled(id: string): Promise<CodingSession | undefined> {
    return this.turns.get(id) ?? this.repository.codingSession(id)
  }

  private async execute(session: CodingSession, project: Project, directory: string): Promise<CodingSession> {
    const started = session.startedAt ?? Date.now()
    let failure: string | undefined
    try {
      // The chat may have been re-pointed since the session began; the session's directory is the one that counts.
      const conversation = await this.repository.conversation(session.conversationId)
      if (conversation?.workspacePath !== directory) await this.repository.setConversationWorkspace(session.conversationId, directory)
      await this.repository.setActiveTopic(session.conversationId, session.topicId)
      // Cancelled before the agent was ever started: there is nothing to stop.
      if (!this.cancelled.has(session.id)) await this.runtime.sendMessage(session.conversationId, session.task)
    } catch (error) { failure = error instanceof Error ? error.message : String(error) }
    const runs = (await this.repository.runs()).filter(run => run.conversationId === session.conversationId && run.createdAt >= started).sort((a, b) => b.createdAt - a.createdAt)
    const run = runs[0]
    const reply = (await this.repository.topicMessages(session.conversationId, session.topicId)).filter(message => message.authorId === session.agentId && message.kind === 'message').at(-1)
    let status: CodingSession['status'] = 'succeeded'
    if (this.cancelled.has(session.id) || run?.status === 'cancelled') status = 'cancelled'
    else if (failure || !run || run.status === 'failed' || run.status === 'interrupted') status = 'failed'
    const changes = project.isGit ? await gitStatus(directory).then(state => state.changes, () => session.changes) : []
    this.cancelled.delete(session.id)
    const finished = await this.repository.updateCodingSession(session.id, {
      status, finishedAt: Date.now(), changes, ...(run ? { runId: run.id } : {}), ...(reply ? { result: reply.text } : {}),
      ...(failure || run?.error ? { error: failure ?? run?.error } : {})
    })
    return finished ?? session
  }

  /**
   * Stop a session: the agent's turn and any command Douchat is running for it.
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

  /** Run a program in the session's working directory and record the result with the session. */
  async runCommand(id: string, argv: string[], options: { timeoutMs?: number } = {}): Promise<CommandResult> {
    const session = await this.repository.codingSession(id)
    if (!session) throw new Error('Coding session not found')
    const controller = new AbortController()
    const set = this.aborts.get(id) ?? new Set<AbortController>()
    set.add(controller); this.aborts.set(id, set)
    try {
      const result = await runCommand(argv, { cwd: session.workingDirectory, signal: controller.signal, timeoutMs: options.timeoutMs ?? CHECK_TIMEOUT_MS })
      // Read again: the session may have changed while the command ran.
      const latest = (await this.repository.codingSession(id)) ?? session
      await this.repository.updateCodingSession(id, { commands: [...latest.commands, result].slice(-MAX_COMMANDS) })
      return result
    } finally { set.delete(controller); if (!set.size) this.aborts.delete(id) }
  }

  /** Run the project's own check (its `testCommand`), if it has one. */
  async runChecks(id: string): Promise<CommandResult | undefined> {
    const session = await this.repository.codingSession(id)
    const project = session && await this.repository.project(session.projectId)
    if (!project?.testCommand?.length) return undefined
    return this.runCommand(id, project.testCommand)
  }

  /** Everything started so far has finished. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.turns.values()])
  }

  /** For shutdown: stop every running session so each records its final state. */
  async cancelAll(): Promise<void> {
    const running = (await this.repository.codingSessions()).filter(session => session.status === 'running')
    await Promise.allSettled(running.map(session => this.cancel(session.id)))
  }
}
