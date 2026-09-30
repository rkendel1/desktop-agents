import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CommandResult, GitState } from '../../shared/types'
export { accountChanges } from '../../shared/coding'
import { runCommand } from './commands'

const GIT_ENVIRONMENT: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_PAGER: 'cat' }
// A repository's own configuration must not be able to run programs when Foundry only looks at it.
const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat']
const MAX_DIFF = 2 * 1024 * 1024

/**
 * Where Git is asked. Usually a folder on this computer. For a session running on a Compute Computer it is that Computer's checkout: the
 * same Git commands run *there* (a durable Compute job) and their output is read back — the repository on the Computer is the authority,
 * and nothing about it is copied here.
 */
export interface RemoteGit {
  execute(argv: string[], options: { signal?: AbortSignal; maxOutput?: number }): Promise<CommandResult>
}
export type GitLocation = string | RemoteGit

async function git(where: GitLocation, args: string[], signal?: AbortSignal, maxOutput?: number): Promise<CommandResult> {
  const argv = ['git', ...SAFE, ...args]
  if (typeof where !== 'string') return where.execute(argv, { signal, ...(maxOutput ? { maxOutput } : {}) })
  return runCommand(argv, { cwd: where, signal, env: GIT_ENVIRONMENT, timeoutMs: 30_000, ...(maxOutput ? { maxOutput } : {}) })
}

/** Is `directory` the top of a Git working tree, and where is it? */
export async function gitRoot(cwd: GitLocation): Promise<string | undefined> {
  try {
    const result = await git(cwd, ['rev-parse', '--show-toplevel'])
    return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined
  } catch { return undefined }
}

/** Parse `git status --porcelain=v1 -z --branch`. */
export function parseGitStatus(output: string): GitState {
  const state: GitState = { changes: [] }
  const entries = output.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry) continue
    if (entry.startsWith('## ')) {
      const head = entry.slice(3)
      if (!head.startsWith('HEAD (no branch)')) state.branch = head.replace(/^No commits yet on /, '').split('...')[0]
      continue
    }
    const code = entry.slice(0, 2), path = entry.slice(3)
    // A rename or copy is followed by its original path.
    if (code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C') state.changes.push({ path, code, from: entries[++i] })
    else state.changes.push({ path, code })
  }
  return state
}

const HASH_LIMIT = 8 * 1024 * 1024

/** Content hash of a file (size and modification time for a very large one); undefined when it cannot be read. */
async function fingerprint(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) return `link:${info.size}`
    if (!info.isFile()) return `other:${info.mtimeMs}`
    if (info.size > HASH_LIMIT) return `big:${info.size}:${Math.floor(info.mtimeMs)}`
    const hash = createHash('sha1')
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
    return `sha1:${hash.digest('hex')}`
  } catch { return undefined }
}

/** Changed files and the commit they are relative to. Reads only; never touches the index or the tree. */
export async function gitStatus(cwd: GitLocation, signal?: AbortSignal, options: { fingerprints?: boolean } = {}): Promise<GitState> {
  const [status, head] = await Promise.all([
    git(cwd, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'], signal, 4 * 1024 * 1024),
    git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], signal)
  ])
  if (status.exitCode !== 0) throw new Error(`git status failed: ${status.stderr.trim() || `exit ${status.exitCode}`}`)
  const state = parseGitStatus(status.stdout)
  if (head.exitCode === 0 && head.stdout.trim()) state.head = head.stdout.trim()
  if (options.fingerprints && typeof cwd !== 'string') {
    // On a Computer the files are read by Git there: `hash-object` gives each dirty file's content identity.
    const paths = state.changes.filter(change => !(change.code.includes('D') && !change.code.includes('R'))).map(change => change.path)
    for (let i = 0; i < paths.length; i += 100) {
      const batch = paths.slice(i, i + 100)
      const hashed = await git(cwd, ['hash-object', '--', ...batch], signal)
      const lines = hashed.exitCode === 0 ? hashed.stdout.trim().split('\n') : []
      if (lines.length === batch.length) batch.forEach((path, index) => { const change = state.changes.find(item => item.path === path); if (change) change.fingerprint = `git:${lines[index]}` })
    }
  } else if (options.fingerprints && typeof cwd === 'string') {
    // In small batches: a dirty tree can have thousands of files.
    for (let i = 0; i < state.changes.length; i += 32) {
      await Promise.all(state.changes.slice(i, i + 32).map(async change => {
        if (change.code.includes('D') && !change.code.includes('R')) return
        const value = await fingerprint(join(cwd as string, change.path))
        if (value) change.fingerprint = value
      }))
    }
  }
  return state
}

/**
 * The patch for tracked files: what differs from HEAD (staged and unstaged
 * together), or from the index when there is no commit yet. Untracked files
 * appear in `gitStatus`, not here. Bounded, so a huge change cannot flood the app.
 */
export async function gitDiff(cwd: GitLocation, options: { path?: string; signal?: AbortSignal } = {}): Promise<{ diff: string; truncated: boolean }> {
  const head = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], options.signal)
  const target = head.exitCode === 0 ? ['HEAD'] : []
  const result = await git(cwd, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', ...target, ...(options.path ? ['--', options.path] : [])], options.signal, MAX_DIFF)
  if (result.exitCode !== 0) throw new Error(`git diff failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
  return { diff: result.stdout, truncated: result.stdout.startsWith('…') }
}

/** The URL of `origin` as Git reports it, or undefined when the folder has none. Reads only. */
export async function gitRemoteUrl(cwd: GitLocation): Promise<string | undefined> {
  try {
    const result = await git(cwd, ['config', '--get', 'remote.origin.url'])
    return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined
  } catch { return undefined }
}

/** Is the commit on a remote-tracking branch — that is, could a checkout from `origin` find it? Reads only. */
export async function gitRevisionIsPublished(cwd: GitLocation, revision: string): Promise<boolean> {
  try {
    const result = await git(cwd, ['branch', '--remotes', '--contains', revision])
    return result.exitCode === 0 && result.stdout.trim().length > 0
  } catch { return false }
}
