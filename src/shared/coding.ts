import type { CodingActivity, CodingSession, GitChange, Project } from './types'
import type { PermissionRequest } from './agentPermissions'

/** What a coding session shows as its state. The backend owns the states; this only adds "waiting for approval", which is live. */
export type CodingDisplayState = 'running' | 'awaiting-approval' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'

export function codingDisplayState(session: Pick<CodingSession, 'status'>, activity?: Pick<CodingActivity, 'state'>): CodingDisplayState {
  return session.status === 'running' && activity?.state === 'awaiting-approval' ? 'awaiting-approval' : session.status
}

export const codingStateLabels: Record<CodingDisplayState, string> = {
  running: 'Running', 'awaiting-approval': 'Waiting for approval', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted'
}

/** A finished session can be continued; a running one cannot. */
export const canContinue = (session: Pick<CodingSession, 'status'>): boolean => session.status !== 'running'

/**
 * "Agent wants to: …" for a permission request, in the words a person needs:
 * the command it would run, or the file it would touch (relative to the project).
 */
export function describeApproval(request: Pick<PermissionRequest, 'details' | 'operation'>, projectPath?: string): { verb: string; target: string } {
  let details: { tool?: string; input?: { command?: string; file_path?: string; path?: string; pattern?: string; url?: string } } | undefined
  try { details = JSON.parse(request.details) } catch { /* plain text */ }
  const relative = (path: string): string => projectPath && path.startsWith(projectPath.replace(/[\\/]+$/, '') + '/') ? path.slice(projectPath.replace(/[\\/]+$/, '').length + 1) : path
  const input = details?.input
  switch (details?.tool) {
    case 'Bash': return { verb: 'Run', target: input?.command?.trim() || '(command)' }
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return { verb: 'Edit', target: relative(input?.file_path ?? '(file)') }
    case 'Write': return { verb: 'Write', target: relative(input?.file_path ?? '(file)') }
    case 'Read': return { verb: 'Read', target: relative(input?.file_path ?? input?.path ?? '(file)') }
    case 'Glob': case 'Grep': return { verb: 'Search', target: input?.pattern ?? '(files)' }
    case 'WebFetch': return { verb: 'Fetch', target: input?.url ?? '(page)' }
    default: return { verb: 'Do', target: details?.tool ?? request.operation }
  }
}

/** Split a command line into an argument vector. Quotes group words; nothing is ever interpreted by a shell. */
export function parseCommandLine(text: string): string[] {
  const argv: string[] = []
  let current = '', quote: '"' | "'" | undefined, started = false
  for (const character of text.trim()) {
    if (quote) { if (character === quote) quote = undefined; else current += character }
    else if (character === '"' || character === "'") { quote = character; started = true }
    else if (/\s/.test(character)) { if (started || current) { argv.push(current); current = ''; started = false } }
    else current += character
  }
  if (quote) throw new Error('Unclosed quote in the command.')
  if (started || current) argv.push(current)
  return argv
}

export const formatCommandLine = (argv: string[]): string => argv.map(part => /[\s"']/.test(part) || !part ? JSON.stringify(part) : part).join(' ')

export const isUntracked = (change: Pick<GitChange, 'code'>): boolean => change.code === '??'

/** A short word for a porcelain status code. */
export function changeLabel(change: Pick<GitChange, 'code'>): string {
  const [index, worktree] = [change.code[0], change.code[1]]
  if (change.code === '??') return 'Untracked'
  if (index === 'R' || worktree === 'R') return 'Renamed'
  if (index === 'A') return 'Added'
  if (index === 'D' || worktree === 'D') return 'Deleted'
  if (index === 'U' || worktree === 'U') return 'Conflict'
  return 'Modified'
}

export const projectOf = (projects: Project[] | undefined, session: Pick<CodingSession, 'projectId'>): Project | undefined => projects?.find(project => project.id === session.projectId)

/**
 * Compare the repository now with how it was when a session started.
 * A file dirty in the same way, with the same content, is `before`; anything else
 * that is dirty now is `session`, which means "changed while the session ran" —
 * Git cannot tell the agent from the person or a tool. Files that were dirty and
 * are clean now are reported separately.
 */
export function accountChanges(baseline: GitChange[], after: GitChange[]): { changes: GitChange[]; cleaned: string[] } {
  const previous = new Map(baseline.map(change => [change.path, change]))
  const changes = after.map((change): GitChange => {
    const was = previous.get(change.path)
    const same = was && was.code === change.code && was.fingerprint === change.fingerprint
    return { ...change, origin: same ? 'before' : 'session' }
  })
  const now = new Set(after.map(change => change.path))
  return { changes, cleaned: baseline.filter(change => !now.has(change.path)).map(change => change.path) }
}

/** CLIs whose own conversation Douchat can pick up again after a restart (their thread id is kept). */
const nativeResume = new Set(['claude', 'codex'])

/**
 * What "Continue" really does for an agent. It never reattaches to the old process:
 * a new one is started. Whether the agent's own conversation carries over depends on the CLI.
 */
export function continueSemantics(localAgentId?: string): { resumesConversation: boolean; lines: string[] } {
  const resumesConversation = localAgentId !== undefined && nativeResume.has(localAgentId)
  return {
    resumesConversation,
    lines: [
      'A new agent process will be started in this project. The previous process will not be resumed.',
      resumesConversation
        ? 'The agent’s own conversation is picked up again where its CLI supports it; the project and session context are provided too.'
        : 'Continue will start a new conversation with the existing project/session context.'
    ]
  }
}

/** What a session's changed files look like: what changed while it ran, what was already modified, and what is clean now. */
export function groupChanges(changes: GitChange[], baseline: GitChange[]): { during: GitChange[]; already: GitChange[] } {
  const accounted = changes.some(change => change.origin) ? changes : accountChanges(baseline, changes).changes
  return { during: accounted.filter(change => change.origin === 'session'), already: accounted.filter(change => change.origin === 'before') }
}
