import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { LocalLauncher } from '../../shared/agentExecutor'
import type { ComputeClient, ComputeProcessState } from './client'

/** Raised when the Computer stopped answering or went away while an agent was running on it. Not a failure of the agent: an interruption of its execution. */
export class ComputeInterruption extends Error {
  constructor(message: string, readonly observed: string) {
    super(message)
    this.name = 'ComputeInterruption'
  }
}

const POLL_MS = 1000

/**
 * The agent's process as Foundry's runtime sees it, backed by a process Compute runs in the Computer.
 *
 * Compute starts the process (`environment agent add`, inside the repository's checkout), owns its lifecycle and reports its state,
 * and Foundry reads that report (`environment computer`) and the process log (`environment logs`). Foundry does not supervise,
 * restart or re-implement any of it: the exit status it reports is the one Compute observed, "stopped" is Compute's stop,
 * and a Computer that is unreachable or lost is reported as an interruption — never as the agent finishing.
 */
export class ComputeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new PassThrough()
  /** The pid *on the Computer*. Deliberately not `pid`: it means nothing on this machine, and must never be signalled from here. */
  remotePid?: number
  private emitted = 0
  private log = ''
  private ended = false
  private stopping = false
  private timer?: ReturnType<typeof setTimeout>
  private polls = 0

  constructor(
    private readonly client: ComputeClient,
    private readonly target: { environment: string; repository: string },
    readonly processName: string,
    private readonly argv: string[],
    private readonly interrupted: (error: ComputeInterruption) => void,
    /** `process`: a plain command (a CI step). `agent`: an agent. Both are Compute processes; both are stopped, read and removed the same way. */
    private readonly role: 'agent' | 'process' = 'agent'
  ) {
    super()
    this.stdin.resume()
    void this.begin()
  }

  private async begin(): Promise<void> {
    try {
      const start = this.role === 'process' ? this.client.startProcess.bind(this.client) : this.client.startAgent.bind(this.client)
      await start(this.target.environment, this.processName, this.argv, { repository: this.target.repository })
    } catch (error) {
      this.finish(() => { this.emit('error', error instanceof Error ? error : new Error(String(error))); this.emit('close', null, null) })
      return
    }
    this.schedule()
  }

  private schedule(): void {
    if (this.ended) return
    this.timer = setTimeout(() => { void this.poll() }, POLL_MS)
  }

  private async poll(): Promise<void> {
    if (this.ended) return
    try {
      const computer = await this.client.computer(this.target.environment)
      if (computer.observed !== 'running' && computer.observed !== 'reconciling' && computer.observed !== 'starting') {
        const reason = `The Computer for environment "${this.target.environment}" is ${computer.observed}${computer.explanation ? `: ${computer.explanation}` : ''}. The agent's execution was interrupted; the task did not complete.`
        const interruption = new ComputeInterruption(reason, computer.observed)
        this.interrupted(interruption)
        this.finish(() => { this.emit('error', interruption); this.emit('close', null, null) })
        return
      }
      const state = computer.processes[this.processName]
      if (state?.pid) this.remotePid = state.pid
      if ((++this.polls % 2 === 0) || (state && this.terminal(state))) await this.pump()
      if (state && this.terminal(state) && !this.stopping && state.state !== 'stopped' && (state.exitCode === undefined || state.exitCode === null)) {
        // Compute has no exit status for the process — it never ran to an exit (for example the target stopped answering for the job).
        // That is the execution being interrupted, not the agent failing or finishing, and no status is invented for it.
        const interruption = new ComputeInterruption(`Compute could not report how the agent ended (${state.message ?? state.reason ?? state.state}). The agent's execution was interrupted; the task did not complete.`, state.state)
        this.interrupted(interruption)
        this.finish(() => { this.emit('error', interruption); this.emit('close', null, null) })
        return
      }
      if (state && this.terminal(state)) {
        const code = this.exitCode(state)
        // Compute's process log is one stream. A process that failed has its output — and Compute's exit status — reported as diagnostics,
        // the way the runtime reads a local process's stderr.
        if (code !== 0 && code !== null) this.stderr.write(`${this.log.slice(-1200)}\n(exit status ${code}${state.message ? `: ${state.message}` : ''})`)
        this.finish(() => this.emit('close', code, null))
        return
      }
    } catch (error) {
      // Compute itself stopped answering: that is an interruption too, not a result.
      const interruption = new ComputeInterruption(`Compute stopped answering while the agent was running: ${error instanceof Error ? error.message : String(error)}. The task did not complete.`, 'unreachable')
      this.interrupted(interruption)
      this.finish(() => { this.emit('error', interruption); this.emit('close', null, null) })
      return
    }
    this.schedule()
  }

  private terminal = (state: ComputeProcessState): boolean => ['exited', 'failed', 'stopped'].includes(state.state)

  /** Compute reports the exit status of the process it ran. `stopped` is Compute's stop, not an exit. */
  private exitCode(state: ComputeProcessState): number | null {
    if (this.stopping || state.state === 'stopped') return null
    return state.exitCode ?? 0
  }

  /** New log text since the last read, written to stdout. */
  private async pump(): Promise<void> {
    const text = await this.client.logs(this.target.environment, this.processName).catch(() => '')
    if (text.length > this.emitted) { this.stdout.write(text.slice(this.emitted)); this.emitted = text.length }
    this.log = text
  }

  private finish(then: () => void): void {
    if (this.ended) return
    this.ended = true
    if (this.timer) clearTimeout(this.timer)
    this.stdout.end(); this.stderr.end()
    then()
    void this.client.removeProcess(this.target.environment, this.processName)
  }

  /** Compute's own stop of the process; the report is read until it says the process is no longer running. */
  stop(): void {
    if (this.ended || this.stopping) return
    this.stopping = true
    void (async () => {
      try {
        await this.client.stopProcess(this.target.environment, this.processName)
        for (let i = 0; i < 30 && !this.ended; i++) {
          const state = (await this.client.computer(this.target.environment)).processes[this.processName]
          if (!state || state.state !== 'running') break
          await new Promise(resolve => setTimeout(resolve, 300))
        }
        await this.pump()
      } catch { /* the close below still reports that it was stopped */ }
      this.finish(() => this.emit('close', null, 'SIGTERM'))
    })()
  }
}

/** A launcher for one session: agents started through it run in the session's Compute repository checkout. */
export function computeLauncher(client: ComputeClient, target: { environment: string; repository: string; workingDirectory: string }, session: string, interrupted: (error: ComputeInterruption) => void): LocalLauncher {
  let turn = 0
  return {
    workingDirectory: target.workingDirectory,
    spawn(file, args) {
      const name = `foundry-${session.slice(0, 8)}-${++turn}`
      return new ComputeChild(client, target, name, [file, ...args], interrupted) as unknown as ChildProcessWithoutNullStreams & { stop(): void }
    }
  }
}
