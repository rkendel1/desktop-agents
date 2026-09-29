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
