import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CommandResult, GitDiffMode, GitState } from '../../shared/types'
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
      if (!head.startsWith('HEAD (no branch)')) {
        const [name, ...rest] = head.replace(/^No commits yet on /, '').split('...')
        state.branch = name
        // "origin/main [ahead 1, behind 2]" — Git's own words for how the branch relates to its upstream.
        const tracking = /^(\S+)(?: \[(.*)\])?$/.exec(rest.join('...'))
        if (tracking) {
          state.upstream = tracking[1]
          state.ahead = Number(/ahead (\d+)/.exec(tracking[2] ?? '')?.[1] ?? 0)
          state.behind = Number(/behind (\d+)/.exec(tracking[2] ?? '')?.[1] ?? 0)
        }
      }
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
export async function gitDiff(cwd: GitLocation, options: { path?: string; signal?: AbortSignal; mode?: GitDiffMode } = {}): Promise<{ diff: string; truncated: boolean }> {
  const head = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], options.signal)
  const mode = options.mode ?? 'head'
  // `head`: everything since the last commit; `staged`: index against HEAD; `unstaged`: working tree against the index.
  const target = mode === 'staged' ? ['--cached'] : mode === 'unstaged' ? [] : head.exitCode === 0 ? ['HEAD'] : []
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

const inside = (paths: string[], state: GitState): string[] => {
  const known = new Set(state.changes.flatMap(change => [change.path, ...(change.from ? [change.from] : [])]))
  if (!paths.length) throw new Error('Choose at least one file.')
  const unknown = paths.filter(path => !known.has(path))
  if (unknown.length) throw new Error(`Git shows no change to ${unknown[0]}${unknown.length > 1 ? ` (and ${unknown.length - 1} more)` : ''}.`)
  return paths
}

/** `git add -- <paths>`. Only paths Git itself lists as changed; Foundry keeps no index of its own. */
export async function gitStage(cwd: string, paths: string[]): Promise<GitState> {
  inside(paths, await gitStatus(cwd))
  const result = await git(cwd, ['add', '--', ...paths])
  if (result.exitCode !== 0) throw new Error(`git add failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
  return gitStatus(cwd)
}

/** Take paths out of the index without touching the working tree (`git restore --staged`, or `git rm --cached` before the first commit). */
export async function gitUnstage(cwd: string, paths: string[]): Promise<GitState> {
  const before = await gitStatus(cwd)
  inside(paths, before)
  const result = await git(cwd, before.head ? ['restore', '--staged', '--', ...paths] : ['rm', '--cached', '-r', '-q', '--', ...paths])
  if (result.exitCode !== 0) throw new Error(`git unstage failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
  return gitStatus(cwd)
}

/**
 * `git commit -m <message>` of exactly what is staged — never `-a`. The repository's own hooks run, as they do when a developer commits;
 * the message is one argument, not shell text.
 */
export async function gitCommit(cwd: string, message: string): Promise<{ state: GitState; commit: string; summary: string }> {
  const text = message.trim()
  if (!text) throw new Error('Write a commit message.')
  if (text.length > 20_000) throw new Error('The commit message is too long.')
  const before = await gitStatus(cwd)
  if (!before.changes.some(change => change.code[0] !== ' ' && change.code !== '??')) throw new Error('Nothing is staged. Stage the files to commit first.')
  const result = await runCommand(['git', ...SAFE, 'commit', '-m', text], { cwd, env: GIT_ENVIRONMENT, timeoutMs: 120_000 })
  if (result.exitCode !== 0) throw new Error(`git commit failed: ${(result.stderr.trim() || result.stdout.trim()).slice(-600) || `exit ${result.exitCode}`}`)
  const state = await gitStatus(cwd)
  return { state, commit: state.head ?? '', summary: text.split('\n')[0] }
}
