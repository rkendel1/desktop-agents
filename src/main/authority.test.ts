import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the invariant in docs/feltdb-architecture.md: FeltDB is the single
 * durable authority, reached only through the repository. These read the source,
 * so a competing store fails the build instead of a review.
 */
const root = join(__dirname, '..')
function sources(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [path] : []
  })
}
const production = sources(root).map(path => ({ path: relative(root, path), text: readFileSync(path, 'utf8') }))
const offenders = (pattern: RegExp, allowed: string[] = []): string[] =>
  production.filter(file => pattern.test(file.text) && !allowed.includes(file.path)).map(file => file.path)

describe('FeltDB authority', () => {
  it('reaches @feltdb/core from one module only', () => {
    expect(offenders(/from '@feltdb\/core'/, ['main/felt/database.ts'])).toEqual([])
  })

  it('has no second store: no FileJsDb, no synchronous store adapter, no SQLite outside the one-time migration', () => {
    expect(offenders(/FileJsDb|SyncStore|better-sqlite3/)).toEqual([])
    expect(offenders(/node:sqlite/, ['main/legacy/migrate.ts'])).toEqual([])
  })

  it('touches FeltDB collections and transactions only from the repositories', () => {
    expect(offenders(/\.felt\.(collection|transaction|db)\b|felt\.collection\(|getReactiveDependencyGraph/, ['main/desktopRepository.ts', 'main/memoryRepository.ts', 'main/felt/database.ts'])).toEqual([])
  })

  it('has no app-level change bus: persistence is announced by FeltDB, not by callers', () => {
    // Allowed in the main process: the permission broker announcing a pending prompt (memory-only, never stored).
    // And the AppPort host forwarding live coding notices to AppPort's event bus (at-most-once, keeps nothing, announces no persistence).
    // And the Compute launcher, whose `emit` is the ChildProcess `error`/`close` events of an agent (process lifecycle, not persistence).
    // The renderer's own `changed`/`emit` helpers (resize observers, markdown lines) never touch persistence.
    const bus = /\b(?:this\.)?(?:emit|notifyChanged|changed|refreshSnapshot)\(/
    expect(offenders(bus, ['main/agentPermissions.ts', 'main/appport/host.ts', 'main/compute/launcher.ts']).filter(path => !path.startsWith('renderer/'))).toEqual([])
    expect(offenders(/snapshot\(\): AppSnapshot|douchat:snapshot/)).toEqual([])
  })

  it('offers no synchronous repository read', () => {
    const repository = readFileSync(join(root, 'main/desktopRepository.ts'), 'utf8')
    const publicMethods = [...repository.matchAll(/^  (?:async )?([a-zA-Z]+)\([^)]*\)(?:: ([^{]+))? \{/gm)]
      .filter(([, name]) => !['constructor', 'exclusive', 'subscribe', 'close'].includes(name) && !name.startsWith('stage'))
    const synchronous = publicMethods.filter(([full, , type]) => !full.startsWith('  async ') && !(type ?? '').trim().startsWith('Promise'))
    expect(synchronous.map(([, name]) => name)).toEqual([])
  })
})
