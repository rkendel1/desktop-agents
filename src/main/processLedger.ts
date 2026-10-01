import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * A record of an agent or command process Foundry started. Operating-system
 * processes are ephemeral, so this is not their state: it is a note of which
 * ones Foundry is responsible for, kept so that a process that outlives the app
 * (a crash, a kill -9, a power cut) is stopped the next time Foundry starts
 * instead of carrying on unsupervised in a project folder.
 */
export interface AgentProcessRecord {
  id: string
  pid: number
  /** Which kind of process: an agent turn, a persistent agent connection or a command Foundry ran. */
  role: 'agent' | 'connection' | 'command'
  /** The operating system's own start time for the process, so a reused pid is never mistaken for it. */
  identity: string
  cwd?: string
  startedAt: number
}

export interface ProcessLedgerStore {
  put(record: AgentProcessRecord): Promise<void>
  remove(id: string): Promise<void>
  all(): Promise<AgentProcessRecord[]>
}

let store: ProcessLedgerStore | undefined
export function configureProcessLedger(next: ProcessLedgerStore | undefined): void { store = next }

/**
 * What identifies this process instance: its start time. Undefined when the process
 * does not exist, or on a platform where it cannot be read (then it is not tracked).
 */
export async function processIdentity(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      // A zombie has already exited; it is not something to stop.
      if (fields[0] === 'Z' || fields[0] === 'X') return undefined
      return fields[19]
    }
    if (process.platform === 'darwin') {
      const { stdout } = await run('ps', ['-o', 'lstart=,state=', '-p', String(pid)], { timeout: 5000 })
      const match = /^(.*\d{4})\s+(\S+)$/.exec(stdout.trim())
      if (!match || match[2].startsWith('Z') || match[2].startsWith('X')) return undefined
      // Status flags change while a process runs; its OS start time does not.
      return match[1]
    }
  } catch { /* gone */ }
  return undefined
}

interface Trackable { pid?: number; once(event: 'exit' | 'close', listener: () => void): unknown }

/** Note a process the moment it starts, and forget it when it ends. Process groups only: a group leader's pid is its group. */
export function trackProcess(child: Trackable, meta: { role: AgentProcessRecord['role']; cwd?: string }): void {
  const pid = child.pid
  if (!store || !pid || process.platform === 'win32') return
  const target = store
  const id = `${pid}-${Date.now()}`
  let ended = false
  const forget = (): void => { ended = true; void written.then(() => target.remove(id)).catch(() => undefined) }
  const written = processIdentity(pid).then(async identity => {
    if (!identity || ended) return
    await target.put({ id, pid, role: meta.role, identity, ...(meta.cwd ? { cwd: meta.cwd } : {}), startedAt: Date.now() })
  }).catch(() => undefined)
  child.once('exit', forget)
  child.once('close', forget)
}

export interface ReapReport { reaped: AgentProcessRecord[]; stale: number }

/**
 * At startup, before anything can run: stop every process the last run left
 * behind. A process is only stopped if it is still the very process that was
 * recorded (same pid, same start time); otherwise the record is just discarded.
 */
export async function reapOrphanedProcesses(target: ProcessLedgerStore, kill: (pid: number) => void = pid => process.kill(-pid, 'SIGKILL')): Promise<ReapReport> {
  const report: ReapReport = { reaped: [], stale: 0 }
  for (const record of await target.all()) {
    const current = await processIdentity(record.pid)
    if (current !== undefined && current === record.identity) {
      try { kill(record.pid); report.reaped.push(record) } catch { report.stale++ }
    } else report.stale++
    await target.remove(record.id)
  }
  return report
}
