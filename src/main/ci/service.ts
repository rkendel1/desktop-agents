import { randomBytes } from 'node:crypto'
import type { CiFailureKind, CiOperationResult, CiPlan, CiPlannedOperation, CiRun, CommandResult, Project } from '../../shared/types'
import { runCommand } from '../coding/commands'
import { gitRemoteUrl, gitRevisionIsPublished, gitStatus } from '../coding/git'
import { ComputeClient, ComputeError, type ComputeComputer } from '../compute/client'
import { ComputeChild, ComputeInterruption } from '../compute/launcher'
import { runPax, type PaxOperation, type PaxRun } from '../compute/pax'
import type { DesktopRepository } from '../desktopRepository'
import { resolveSavedWorkspace } from '../localWorkspaces'

/** The most of each output stream a CI operation keeps: its tail. The rest is Compute's log on the Computer, which is gone after release. */
export const CI_OUTPUT_LIMIT = 16 * 1024
/** The order CI asks PAX for. Which of them run — and with what tool and command — is PAX's answer for the project. */
const CHECKS = ['typecheck', 'lint', 'test', 'build'] as const
const PREPARE = 'install'

export interface CiOptions {
  compute?: ComputeClient
  /** The `pax` executable. Default: `$FOUNDRY_PAX`, else `pax`. */
  pax?: string
  /** What the Computer needs. Compute places it; an unsatisfiable request is Compute's error to report. */
  cpu?: number
  memory?: string
  operationTimeoutMs?: number
  runTimeoutMs?: number
  /** Compute expires an unreleased ephemeral Computer after this long: the backstop for a Foundry that died. */
  ttlSeconds?: number
}

class CiStop extends Error {
  constructor(readonly kind: CiFailureKind, message: string, readonly operation?: string, readonly status: CiRun['status'] = 'failed') { super(message) }
}

const tail = (text: string, limit: number): { text: string; truncated: boolean } => text.length > limit ? { text: `…${text.slice(-limit)}`, truncated: true } : { text, truncated: false }
const firstLine = (text: string): string => text.split('\n').map(line => line.trim()).find(Boolean) ?? ''

/** A URL without credentials: what is recorded and shown is never a token. */
function redact(url: string): string {
  try { const parsed = new URL(url); if (parsed.username || parsed.password) { parsed.username = ''; parsed.password = '' } return parsed.toString().replace(/\/$/, url.endsWith('/') ? '/' : '') } catch { return url }
}

/**
 * CI on an ephemeral Compute Computer.
 *
 *   PAX plans → Compute acquires a Computer → the revision is checked out on it → PAX's operations run there as Compute processes
 *   → evidence is captured → the Computer is released.
 *
 * This is the coding-session Compute path with a different workload, not an engine of its own: Computers, environments, processes
 * and their logs are Compute's (`environment create --ephemeral`, `repo add`, `process add`, `process stop`, `destroy`), what a
 * project's operations are and which tool runs them is PAX's, and Foundry keeps the run — what was tested, what PAX planned, what
 * each operation printed (bounded) and whether the Computer was released — in the shared flow. The release is in a `finally`: success,
 * a failing operation, cancellation, timeout, a Compute error and Foundry closing all end with the Computer destroyed.
 */
export class CiService {
  private readonly compute?: ComputeClient
  private readonly pax: string
  private readonly options: Required<Pick<CiOptions, 'cpu' | 'memory' | 'operationTimeoutMs' | 'runTimeoutMs'>> & { ttlSeconds: number }
  private readonly active = new Map<string, { abort: AbortController; reason?: 'cancelled' | 'timeout' | 'shutdown'; done: Promise<void> }>()

  constructor(private readonly repository: DesktopRepository, options: CiOptions = {}) {
    this.compute = options.compute
    this.pax = options.pax ?? process.env.FOUNDRY_PAX ?? 'pax'
    const runTimeoutMs = options.runTimeoutMs ?? 30 * 60_000
    this.options = { cpu: options.cpu ?? 1, memory: options.memory ?? '1Gi', operationTimeoutMs: options.operationTimeoutMs ?? 15 * 60_000, runTimeoutMs, ttlSeconds: options.ttlSeconds ?? Math.ceil(runTimeoutMs / 1000) + 15 * 60 }
  }

  private requireCompute(): ComputeClient {
    if (!this.compute) throw new Error('Compute is not available in this build.')
    return this.compute
  }

  private async requireProject(id: string): Promise<{ project: Project; directory: string }> {
    const project = await this.repository.project(id)
    if (!project) throw new Error('Project not found')
    return { project, directory: resolveSavedWorkspace(project.path) }
  }

  // ───────────────────────────── what would run ─────────────────────────────

  /** PAX's plan for a folder: `pax --dry-run --json` for each operation, read as PAX wrote it. Nothing executes. */
  private async paxPlan(directory: string, tool: string | undefined, execute: (argv: string[], options: { signal?: AbortSignal }) => Promise<CommandResult>): Promise<{ operations: CiPlannedOperation[]; runs: PaxRun[]; ambiguous: boolean }> {
    const runs = await Promise.all(([PREPARE, ...CHECKS] as PaxOperation[]).map(operation => runPax(execute, this.pax, operation, { dryRun: true, ...(tool ? { tool } : {}) })))
    let ambiguous = false
    const operations = runs.map((run): CiPlannedOperation => {
      const plan = run.json as { tool?: string; command?: string[]; evidence?: string[]; selection_reason?: string; supported?: boolean } | undefined
      if (run.exitCode === 0 && plan?.command && plan.supported !== false) {
        return { operation: run.command, supported: true, ...(plan.tool ? { tool: plan.tool } : {}), command: plan.command, ...(plan.selection_reason ? { selectionReason: plan.selection_reason } : {}), ...(plan.evidence ? { evidence: plan.evidence } : {}) }
      }
      if (run.findings.failedClosed) ambiguous = true
      return { operation: run.command, supported: false, reason: firstLine(run.stderr) || firstLine(run.stdout) || `pax ${run.command} exited ${run.exitCode}` }
    })
    return { operations, runs, ambiguous }
  }

  private localExecute = (directory: string) => (argv: string[], options: { signal?: AbortSignal }): Promise<CommandResult> =>
    runCommand(argv, { cwd: directory, signal: options.signal, timeoutMs: 60_000 })

  /** The source state CI would test — or why there is none. Uncommitted local state is never tested. */
  private async sourceOf(directory: string): Promise<{ source?: CiRun['source']; blockers: string[] }> {
    const state = await gitStatus(directory).catch(() => undefined)
    if (!state) return { blockers: ['This folder is not a Git repository. CI tests a committed revision.'] }
    if (!state.head) return { blockers: ['The repository has no commits yet. CI tests a committed revision.'] }
    if (state.changes.length) return { blockers: [`${state.changes.length} uncommitted file${state.changes.length === 1 ? '' : 's'} in the project. CI tests a committed revision, never local state: commit or stash ${state.changes.length === 1 ? 'it' : 'them'} first.`] }
    const origin = await gitRemoteUrl(directory)
    const published = origin ? await gitRevisionIsPublished(directory, state.head) : false
    return { blockers: [], source: { repository: published && origin ? redact(origin) : `file://${directory}`, revision: state.head, ...(state.branch ? { branch: state.branch } : {}), workspaceSource: 'committed-revision' } }
  }

  /** What Run CI would do, before it does anything. */
  async plan(projectId: string, tool?: string): Promise<CiPlan> {
    const { project, directory } = await this.requireProject(projectId)
    const result: CiPlan = { projectId, projectName: project.name, ready: false, blockers: [], computer: { lifecycle: 'ephemeral' } }
    const compute = this.compute
    if (!compute) result.blockers.push('Compute is not available in this build.')
    else {
      try {
        result.platform = (await compute.platform()).platform
        if (!(await compute.reachable())) result.blockers.push(`The Compute daemon is not answering at ${compute.daemon}. Start it with \`compute start\`.`)
      } catch (error) { result.blockers.push(error instanceof Error ? error.message : String(error)) }
    }
    const { source, blockers } = project.isGit ? await this.sourceOf(directory) : { source: undefined, blockers: ['This folder is not a Git repository. CI tests a committed revision.'] }
    result.blockers.push(...blockers)
    if (source) {
      result.source = source
      const planned = await this.paxPlan(directory, tool, this.localExecute(directory))
      result.plan = { operations: planned.operations, ...(tool ? { tool } : {}), ambiguous: planned.ambiguous, drift: false }
      if (planned.ambiguous) result.blockers.push('PAX cannot choose one native tool for this project (ambiguous). Choose a tool explicitly to run CI.')
      else if (!planned.operations.some(item => item.supported && CHECKS.includes(item.operation as typeof CHECKS[number]))) result.blockers.push('PAX plans no CI operation (typecheck, lint, test or build) for this project.')
    }
    result.ready = result.blockers.length === 0
    return result
  }

  // ───────────────────────────── runs ─────────────────────────────

  async list(projectId?: string): Promise<CiRun[]> {
    return (await this.repository.ciRuns(projectId)).sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): Promise<CiRun | undefined> { return this.repository.ciRun(id) }

  /** Start CI for a project. Returns as soon as the run exists; it proceeds on its own and its result is read from the run. */
  async start(input: { projectId: string; tool?: string }): Promise<CiRun> {
    const compute = this.requireCompute()
    const { directory } = await this.requireProject(input.projectId)
    const { source, blockers } = await this.sourceOf(directory)
    if (!source) throw new Error(blockers[0])
    const { platform } = await compute.platform()
    if (!(await compute.reachable())) throw new Error(`The Compute daemon is not answering at ${compute.daemon}. Start it with \`compute start\`.`)
    const run = await this.repository.createCiRun({ projectId: input.projectId, status: 'running', phase: 'planning', startedAt: Date.now(), source, platform,
      events: [{ at: Date.now(), label: 'CI started', detail: `${source.revision.slice(0, 8)} from ${source.repository}` }] })
    const abort = new AbortController()
    const entry: { abort: AbortController; reason?: 'cancelled' | 'timeout' | 'shutdown'; done: Promise<void> } = { abort, done: Promise.resolve() }
    this.active.set(run.id, entry)
    const timer = setTimeout(() => { entry.reason ??= 'timeout'; abort.abort() }, this.options.runTimeoutMs)
    entry.done = this.execute(run, directory, input.tool, abort.signal, () => entry.reason).catch(() => undefined).finally(() => { clearTimeout(timer); this.active.delete(run.id) })
    return run
  }

  /** Stop the workload, keep the evidence, release the Computer. Resolves when that has been asked for; the run ends when it is done. */
  async cancel(id: string): Promise<void> {
    const entry = this.active.get(id)
    if (!entry) {
      const run = await this.repository.ciRun(id)
      if (!run) throw new Error('CI run not found')
      throw new Error(run.status === 'running' ? 'This CI run is not being driven by this app; it is released when the app next starts.' : 'This CI run has already finished.')
    }
    entry.reason ??= 'cancelled'
    entry.abort.abort()
  }

  /** The run has ended (its Computer released) — for callers that need to wait. */
  async settled(id: string): Promise<CiRun | undefined> {
    await this.active.get(id)?.done
    return this.repository.ciRun(id)
  }

  /** Foundry is closing: every running workload is stopped and every Computer released before it goes. */
  async shutdown(timeoutMs = 90_000): Promise<void> {
    const pending = [...this.active.values()]
    for (const entry of pending) { entry.reason ??= 'shutdown'; entry.abort.abort() }
    await Promise.race([Promise.allSettled(pending.map(entry => entry.done)), new Promise(resolve => setTimeout(resolve, timeoutMs))])
  }

  /**
   * At start-up: a run still `running` belonged to a Foundry that is gone. Its Computer is released through Compute (idempotent — a Computer
   * already gone is released) and the run becomes `interrupted`. If Compute cannot be asked, the run says so: the Computer is ephemeral, and
   * Compute expires it when its lifetime ends.
   */
  async recover(): Promise<CiRun[]> {
    const recovered: CiRun[] = []
    for (const run of await this.repository.ciRuns()) {
      if (run.status !== 'running' || this.active.has(run.id)) continue
      let computer = run.computer
      let note = 'Foundry closed while this run was in progress. Its workload did not survive.'
      if (computer && !computer.released) {
        const released = this.compute ? await this.compute.release(computer.environment).catch(error => ({ released: false, observed: 'unknown', note: error instanceof Error ? error.message : String(error) })) : { released: false, observed: 'unknown', note: 'Compute is not available.' }
        computer = { ...computer, released: released.released, ...(released.released ? { releasedAt: Date.now() } : {}), ...(released.note ? { releaseNote: released.note } : {}) }
        note += released.released ? ' The Computer was released.' : ` The Computer could not be released now (${released.note ?? released.observed}); Compute expires it after its lifetime.`
      }
      const next = await this.repository.updateCiRun(run.id, { status: 'interrupted', phase: 'done', finishedAt: Date.now(), ...(computer ? { computer } : {}), failure: { kind: 'interrupted', message: note } }, { label: 'Interrupted when Foundry closed', detail: note })
      if (next) recovered.push(next)
    }
    return recovered
  }

  // ───────────────────────────── one run ─────────────────────────────

  private async execute(run: CiRun, directory: string, tool: string | undefined, signal: AbortSignal, reason: () => 'cancelled' | 'timeout' | 'shutdown' | undefined): Promise<void> {
    const compute = this.requireCompute()
    const save = (patch: Parameters<DesktopRepository['updateCiRun']>[1], event?: Parameters<DesktopRepository['updateCiRun']>[2]): Promise<unknown> => this.repository.updateCiRun(run.id, patch, event)
    const results: CiOperationResult[] = []
    let computer: NonNullable<CiRun['computer']> | undefined
    let plan: CiRun['plan']
    let status: CiRun['status'] = 'failed'
    let failure: CiRun['failure']
    const stopped = (): CiStop | undefined => {
      const why = reason()
      if (!signal.aborted && !why) return undefined
      if (why === 'timeout') return new CiStop('timeout', `The run took longer than ${Math.round(this.options.runTimeoutMs / 60000)} minutes and was stopped.`, undefined, 'failed')
      if (why === 'shutdown') return new CiStop('interrupted', 'Foundry closed while this run was in progress. The workload was stopped.', undefined, 'interrupted')
      return new CiStop('cancelled', 'Cancelled.', undefined, 'cancelled')
    }
    try {
      // 1 ── PAX plans the project. Ambiguity stops the run before any Computer exists.
      const planned = await this.paxPlan(directory, tool, this.localExecute(directory))
      plan = { operations: planned.operations, ...(tool ? { tool } : {}), ambiguous: planned.ambiguous, drift: false }
      await save({ plan }, { label: 'PAX planned the project', detail: planned.operations.filter(item => item.supported).map(item => `${item.operation}: ${item.command?.join(' ')}`).join('\n') || 'no supported operation' })
      if (planned.ambiguous) throw new CiStop('ambiguous', `PAX cannot choose one native tool for this project: ${planned.operations.find(item => !item.supported && item.reason)?.reason ?? 'ambiguous'}. Nothing was started. Choose a tool explicitly to run CI.`, undefined, 'blocked')
      const checks = CHECKS.filter(name => planned.operations.some(item => item.operation === name && item.supported))
      if (!checks.length) throw new CiStop('plan', 'PAX plans no CI operation (typecheck, lint, test or build) for this project. Nothing was started.', undefined, 'blocked')
      const stop0 = stopped(); if (stop0) throw stop0

      // 2 ── Acquire an ephemeral Computer from Compute. The reference is stored *before* the request, so a Foundry that dies mid-request can still release it.
      const environment = `foundry-ci-${run.number}-${randomBytes(3).toString('hex')}`
      computer = { environment, lifecycle: 'ephemeral', ttlSeconds: this.options.ttlSeconds, released: false }
      await save({ phase: 'acquiring', computer }, { label: 'Acquiring an ephemeral Computer', detail: environment })
      let acquired: ComputeComputer
      try { acquired = await compute.acquireEphemeral(environment, { cpu: this.options.cpu, memory: this.options.memory, ttlSeconds: this.options.ttlSeconds, signal }) }
      catch (error) { const s = stopped(); if (s) throw s; throw error }
      computer = { ...computer, environmentId: acquired.environmentId, ...(acquired.target ? { target: acquired.target } : {}) }
      await save({ computer }, { label: 'Computer running', detail: `${environment}${acquired.target ? ` on ${acquired.target}` : ''}` })
      const stop1 = stopped(); if (stop1) throw stop1

      // 3 ── Prepare the workspace: Compute checks the committed revision out on the Computer, and Foundry verifies that is what is there.
      await save({ phase: 'preparing' })
      const repository = `ci-${run.projectId.slice(-8)}`
      await compute.addRepository(environment, repository, run.source.repository, run.source.revision)
      const deadline = Date.now() + 120_000
      let commit: string | undefined
      for (;;) {
        const s = stopped(); if (s) throw s
        commit = (await compute.computer(environment)).repositories[repository]?.commit
        if (commit) break
        if (Date.now() > deadline) throw new CiStop('source', `The revision did not appear on the Computer within 2 minutes (${run.source.repository}).`)
        await new Promise(resolve => setTimeout(resolve, 400))
      }
      if (commit !== run.source.revision) throw new CiStop('source', `The Computer checked out ${commit?.slice(0, 12)} but CI was asked to test ${run.source.revision.slice(0, 12)}.`)
      computer = { ...computer, repository }
      await save({ computer }, { label: 'Revision checked out on the Computer', detail: `${run.source.revision.slice(0, 12)} → ${repository}` })

      // PAX runs on the Computer against the real checkout and must plan what it planned here.
      const remote = (argv: string[], options: { signal?: AbortSignal }): Promise<CommandResult> => compute.exec(environment, argv, { repository, signal: options.signal, timeoutMs: 120_000 })
      const there = await this.paxPlan(directory, tool, remote)
      for (const local of planned.operations) {
        const other = there.operations.find(item => item.operation === local.operation)
        if (local.supported !== other?.supported || local.command?.join('\0') !== other?.command?.join('\0') || local.tool !== other?.tool) {
          throw new CiStop('plan', `PAX on the Computer planned ${local.operation} differently from PAX here (${local.command?.join(' ') ?? 'unsupported'} vs ${other?.command?.join(' ') ?? other?.reason ?? 'unsupported'}).`, local.operation)
        }
      }
      plan = { ...plan, note: 'PAX on the Computer planned the same commands.' }
      await save({ plan }, { label: 'PAX on the Computer agrees with the plan' })

      // 4 ── Materialise dependencies the way PAX says, then ask PAX whether declared, resolved and installed still agree. Drift is reported, never repaired.
      await save({ phase: 'executing' })
      const timeouts = { operation: this.options.operationTimeoutMs }
      const prepare = planned.operations.find(item => item.operation === PREPARE && item.supported)
      const runStep = async (operation: string, kind: 'prepare' | 'check', planned_: CiPlannedOperation): Promise<void> => {
        const result = await this.step(compute, environment, repository, { operation, kind, tool: planned_.tool, command: planned_.command ?? [], argv: [this.pax, ...(tool ? ['--tool', tool] : []), operation] }, signal, timeouts.operation)
        results.push(result)
        await save({ operations: [...results] }, { label: `${operation} ${result.status}`, detail: result.exitCode === null ? undefined : `exit ${result.exitCode}` })
        const s = stopped()
        if (result.status === 'interrupted') throw new CiStop('interrupted', result.stderr || 'The Computer stopped answering; the operation did not complete.', operation, 'interrupted')
        if (result.status === 'timed-out') throw new CiStop('timeout', `${operation} did not finish within ${Math.round(timeouts.operation / 60000)} minutes and was stopped.`, operation)
        if (result.status === 'cancelled') throw s ?? new CiStop('cancelled', 'Cancelled.', operation, 'cancelled')
        if (result.status === 'failed') throw new CiStop('operation', `${operation} failed (exit ${result.exitCode}).`, operation)
      }
      if (prepare) await runStep(PREPARE, 'prepare', prepare)
      const drift = await runPax(remote, this.pax, 'drift')
      // `pax drift` does not take --tool (measured): a package-manager ambiguity is still reported when the person has chosen the tool. That choice
      // is the resolution, so it is recorded as such; every other finding stays what PAX said.
      const issues = (drift.json as { issues?: { status: string; expected: string; actual: string }[] } | undefined)?.issues ?? []
      const describe = (list: typeof issues): string => list.map(issue => `${issue.expected}: ${issue.actual}`).join('; ')
      const ambiguities = issues.filter(issue => issue.status === 'ambiguous'), drifted = issues.filter(issue => issue.status === 'drift')
      if (drift.findings.ambiguous && !tool) {
        plan = { ...plan, ambiguous: true }
        await save({ plan })
        throw new CiStop('ambiguous', `PAX reports the project state on the Computer as ambiguous (${describe(ambiguities) || firstLine(drift.stderr) || 'see PAX drift'}). Nothing was run.`, undefined, 'blocked')
      }
      if (tool && ambiguities.length) plan = { ...plan, note: `${plan.note ?? ''} PAX still reports "${describe(ambiguities)}" as ambiguous; the person chose ${tool}.`.trim() }
      if (tool ? drifted.length : drift.findings.drift) {
        plan = { ...plan, drift: true, note: `${plan.note ?? ''} PAX reports drift on the Computer: ${describe(drifted) || 'see PAX drift'}.`.trim() }
        await save({ plan })
        throw new CiStop('drift', `PAX reports drift between what the project declares and what is installed on the Computer. ${describe(drifted)}. It was not repaired.`.trim())
      }

      // 5 ── PAX's operations, in order, as Compute processes on the Computer. The first failure ends the run.
      for (const name of checks) await runStep(name, 'check', planned.operations.find(item => item.operation === name)!)
      status = 'passed'
    } catch (error) {
      const stop = error instanceof CiStop ? error : stopped()
      if (stop) { status = stop.status; failure = { kind: stop.kind, message: stop.message, ...(stop.operation ? { operation: stop.operation } : {}) } }
      else if (error instanceof ComputeInterruption) { status = 'interrupted'; failure = { kind: 'interrupted', message: error.message } }
      else { status = 'failed'; failure = { kind: error instanceof ComputeError || !(error instanceof CiStop) ? 'compute' : 'source', message: error instanceof Error ? error.message : String(error) } }
    } finally {
      // 6 ── Release. Whatever happened above, the Computer is destroyed; what Compute then observes is what is recorded.
      if (computer) {
        await save({ phase: 'releasing' }, { label: 'Releasing the Computer', detail: computer.environment }).catch(() => undefined)
        const released = await compute.release(computer.environment).catch(error => ({ released: false, observed: 'unknown', note: error instanceof Error ? error.message : String(error) }))
        computer = { ...computer, released: released.released, ...(released.released ? { releasedAt: Date.now() } : {}), ...(released.note ? { releaseNote: released.note } : {}) }
      }
      const label = status === 'passed' ? 'CI passed' : status === 'cancelled' ? 'CI cancelled' : status === 'blocked' ? 'CI blocked' : status === 'interrupted' ? 'CI interrupted' : 'CI failed'
      await save({ status, phase: 'done', finishedAt: Date.now(), ...(computer ? { computer } : {}), ...(plan ? { plan } : {}), operations: results, ...(failure ? { failure } : {}) },
        { label, detail: [failure?.message, computer ? (computer.released ? 'The Computer was released.' : `The Computer was NOT confirmed released${computer.releaseNote ? `: ${computer.releaseNote}` : ''}. Compute expires it after ${Math.round(computer.ttlSeconds / 60)} minutes.`) : 'No Computer was acquired.'].filter(Boolean).join(' ') })
    }
  }

  /** One PAX operation as a Compute process on the Computer, waited for. Stopping it is Compute's stop of that process. */
  private async step(compute: ComputeClient, environment: string, repository: string, spec: { operation: string; kind: 'prepare' | 'check'; tool?: string; command: string[]; argv: string[] }, signal: AbortSignal, timeoutMs: number): Promise<CiOperationResult> {
    const startedAt = Date.now()
    let timedOut = false
    let interruption: ComputeInterruption | undefined
    const child = new ComputeChild(compute, { environment, repository }, `foundry-ci-${spec.operation}-${randomBytes(3).toString('hex')}`, spec.argv, error => { interruption = error }, 'process')
    let out = '', err = ''
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { out = (out + chunk).slice(-CI_OUTPUT_LIMIT * 2) })
    child.stderr.on('data', (chunk: string) => { err = (err + chunk).slice(-CI_OUTPUT_LIMIT * 2) })
    const closed = new Promise<{ code: number | null }>(resolve => { child.once('error', () => undefined); child.once('close', code => resolve({ code })) })
    const onAbort = (): void => child.stop()
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) child.stop()
    const timer = setTimeout(() => { timedOut = true; child.stop() }, timeoutMs)
    const { code } = await closed
    clearTimeout(timer); signal.removeEventListener('abort', onAbort)
    const status: CiOperationResult['status'] = interruption ? 'interrupted' : code === 0 ? 'passed' : timedOut ? 'timed-out' : signal.aborted ? 'cancelled' : code === null ? 'cancelled' : 'failed'
    const stdout = tail(out, CI_OUTPUT_LIMIT), stderr = tail(interruption ? interruption.message : err, CI_OUTPUT_LIMIT)
    return { operation: spec.operation, kind: spec.kind, ...(spec.tool ? { tool: spec.tool } : {}), command: spec.command, status, exitCode: code, startedAt, durationMs: Date.now() - startedAt,
      stdout: stdout.text, stderr: stderr.text, truncated: stdout.truncated || stderr.truncated }
  }
}
