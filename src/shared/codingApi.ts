import type { CodingActivity, CodingEvent, CodingSession, CommandResult, GitChange, Project } from './types'

/**
 * The shape in which Foundry presents projects, coding sessions and approvals to any client of
 * the coding service — the desktop's own IPC handlers and the AppPort capability alike. These are
 * views of what FeltDB, Git and the runtime already hold; nothing here is stored.
 */

export interface ProjectView {
  /** Stable identity of the folder (a hash of its path). */
  id: string
  name: string
  /** The repository's folder on the machine running Foundry. */
  path: string
  isGit: boolean
  /** The command "Run checks" runs, as an argument vector. */
  checkCommand?: string[]
}

export interface GitStateView {
  projectId: string
  branch?: string
  head?: string
  changes: { path: string; code: string; from?: string }[]
}

/** Where a piece of live activity comes from. `unknown` means the agent reported nothing. */
export type ActivityOrigin = 'agent' | 'douchat' | 'unknown'

export interface ApprovalView {
  id: string
  sessionId: string
  projectId: string
  projectName: string
  agentId: string
  agentName: string
  /** The folder the approval is for. */
  workingDirectory: string
  /** What the agent wants to do, in words: e.g. `Run npm test`, `Edit src/math.js`. */
  action: { verb: string; target: string }
  requestedAt: number
}

export interface CheckView {
  argv: string[]
  exitCode: number | null
  signal?: string
  cancelled?: boolean
  timedOut?: boolean
  startedAt: number
  durationMs: number
  /** The end of the output, bounded. */
  output: string
}

export interface SessionEventView {
  at: number
  kind: CodingEvent['kind']
  label: string
  detail?: string
}

export interface SessionView {
  id: string
  project: { id: string; name: string; path: string; isGit: boolean; branch?: string }
  agent: { id: string; name: string }
  task: string
  status: CodingSession['status']
  /** Fixed for the life of the session. */
  workingDirectory: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  result?: string
  error?: string
  /** Set while the session runs: what is known about what it is doing, and how it is known. */
  activity?: { label: string; origin: ActivityOrigin; since: number }
  pendingApproval?: ApprovalView
  /** Where the agent runs. `compute`: on a Compute Computer, named by its environment; the Computer's own state is Compute's. */
  execution?: { kind: 'local' | 'compute'; environment?: string; repository?: string }
  changedFiles: { path: string; code: string; from?: string; origin?: GitChange['origin'] }[]
  /** Modified when the session started and clean now. */
  cleanedFiles: string[]
  headAtStart?: string
  headAtEnd?: string
  checks: CheckView[]
  history: SessionEventView[]
}

const OUTPUT_LIMIT = 8 * 1024
const tail = (text: string): string => text.length > OUTPUT_LIMIT ? `…${text.slice(-OUTPUT_LIMIT)}` : text

export function projectView(project: Project): ProjectView {
  return { id: project.id, name: project.name, path: project.path, isGit: project.isGit, ...(project.testCommand ? { checkCommand: project.testCommand } : {}) }
}

export function checkView(result: CommandResult): CheckView {
  return { argv: result.argv, exitCode: result.exitCode, ...(result.signal ? { signal: result.signal } : {}), ...(result.cancelled ? { cancelled: true } : {}),
    ...(result.timedOut ? { timedOut: true } : {}), startedAt: result.startedAt, durationMs: result.durationMs, output: tail([result.stdout, result.stderr].filter(Boolean).join('\n').trim()) }
}

export const activityOrigin = (source: CodingActivity['source']): ActivityOrigin => source === 'agent' ? 'agent' : source === 'douchat' ? 'douchat' : 'unknown'

export const CODING_EVENT_NAMES = ['session.started', 'session.continued', 'approval.requested', 'approval.resolved', 'check.started', 'check.completed', 'files.changed', 'session.finished', 'session.interrupted'] as const
export type CodingEventName = typeof CODING_EVENT_NAMES[number]

/**
 * A live notice that something in a session happened. Notices are told to whoever is listening at
 * that moment and kept nowhere: the durable record is the session's history, and a client that
 * missed a notice reads it there. `origin` says who knows it — Foundry observed every one of these;
 * an `agent` origin is reserved for what a CLI itself reports, and is never inferred.
 */
export interface CodingNotification {
  name: CodingEventName
  sessionId: string
  projectId: string
  at: number
  origin: ActivityOrigin
  payload: Record<string, string | number | boolean | null | string[]>
}
