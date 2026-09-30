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

/**
 * Guards the invariant in docs/environments.md: Foundry may orchestrate Compute through its public service contract but must not
 * implement Compute lifecycle, placement, readiness, provisioning, or execution semantics locally. Foundry’s Environment surface is a
 * client of Compute, not an alternative implementation of it. Like the checks above, these read the source.
 */
describe('Compute authority', () => {
  const environment = production.filter(file => /^main\/environment\/[^/]+\.ts$/.test(file.path) && file.path !== 'main/environment/testkit.ts')
  const service = environment.find(file => file.path === 'main/environment/service.ts')!
  const presentation = environment.find(file => file.path === 'main/environment/presentation.ts')!
  const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('reaches Compute through one client: only compute/client.ts knows the CLI verbs for environments and recipes', () => {
    expect(offenders(/\[\s*'(?:environment|recipe)'\s*,\s*'(?:create|destroy|start|stop|restart|reconcile|inspect|resolve|list|exec|replace|fork)'/, ['main/compute/client.ts', 'main/environment/testkit.ts'])).toEqual([])   // the test kit writes recipes into a real Compute
    expect(offenders(/'compute-configured'|'--recipe'|`--recipe`/, ['main/compute/client.ts', 'main/compute/testkit.ts'])).toEqual([])
  })

  it('the guards above do catch what they guard', () => {
    const verbs = /\[\s*'(?:environment|recipe)'\s*,\s*'(?:create|destroy|start|stop|restart|reconcile|inspect|resolve|list|exec|replace|fork)'/
    expect(verbs.test("cli(['environment', 'stop', name])")).toBe(true)
    expect(verbs.test("cli(['recipe', 'list', '--json'])")).toBe(true)
    const inference = /computer\??\.(?:status|observed)\s*[!=]==?\s*'running'|(?:exists|created)\s*\?\s*'ready'/
    expect(inference.test("if (computer.status === 'running') return 'ready'")).toBe(true)
    expect(inference.test("const shown = created ? 'ready' : 'none'")).toBe(true)
    expect(/child_process|runCommand|process\.kill/.test("import { runCommand } from '../coding/commands'")).toBe(true)
  })

  it('does no provisioning, process control or I/O of its own: the control plane asks Compute and reads back', () => {
    expect(environment.length).toBeGreaterThanOrEqual(2)
    for (const file of environment) {
      const code = strip(file.text)
      expect(code, file.path).not.toMatch(/child_process|coding\/commands|runCommand|\bspawn\(|\bexec(?:File)?\(|process\.kill|node:(?:fs|net|http|https|os)\b|\bfetch\(|XMLHttpRequest/)
      expect(code, file.path).not.toMatch(/\bnpm\b|\bbrew\b|apt-get|docker\b|\.install\(|provision\(|terminate\(|placement\.evaluate/)
    }
  })

  it('does not decide readiness or lifecycle: `ready` is produced in one table, from Compute’s readiness, and nowhere else', () => {
    // The only place that turns Compute’s words into a Foundry state.
    expect(strip(presentation.text).match(/return 'ready'|state: 'ready'/g) ?? []).toEqual(["return 'ready'"])
    expect(strip(service.text)).not.toMatch(/return 'ready'|state: 'ready'|state = 'ready'|\.status\s*[!=]==?\s*'running'|reality\.observed\s*[!=]==?\s*'running'|\.created\b/)
    // No file infers readiness from the Computer existing or running.
    for (const file of [...environment, ...production.filter(item => /renderer\/src\/components\/(?:EnvironmentPanel|ProjectsView)\.tsx$/.test(item.path))]) {
      expect(strip(file.text), file.path).not.toMatch(/computer\??\.(?:status|observed)\s*[!=]==?\s*'running'|(?:readiness|lifecycle)\s*[!=]==?\s*'(?:running|created)'|computer\.created\s*[!=]==?\s*(?:ready|true)|(?:exists|created)\s*\?\s*'ready'/)
    }
  })

  it('keeps no second Compute state: no cache, no registry of environments, no timer-held state in the control plane', () => {
    for (const file of environment) expect(strip(file.text), file.path).not.toMatch(/new Map\b|new WeakMap\b|[cC]ache\b|localStorage|sessionStorage|setInterval\(/)
    const flow = readFileSync(join(root, 'main/felt/desktop.flow'), 'utf8')
    const block = /collection DevelopmentEnvironment \{([^}]*)\}/.exec(flow)![1]!
    const fields = [...block.matchAll(/^\s+([a-zA-Z]+):/gm)].map(match => match[1]).sort()
    // A reference: identifiers, and what was asked for. Never a status, readiness, digest, error or copy of the Computer.
    expect(fields).toEqual(['createdAt', 'environment', 'environmentId', 'id', 'recipe', 'workspaceId'])
  })

  it('is the only writer of the project → environment reference', () => {
    expect(offenders(/put(?:Development)Environment\(|deleteDevelopmentEnvironment\(|putDevelopmentEnvironment\(/, ['main/desktopRepository.ts', 'main/environment/service.ts'])).toEqual([])
  })

  it('keeps Compute logic out of the renderer: it imports nothing from the main process and never compares Compute’s internals', () => {
    for (const file of production.filter(item => item.path.startsWith('renderer/') && /Environment|ProjectsView|CodingSession/.test(item.path))) {
      expect(file.text, file.path).not.toMatch(/from '(?:\.\.\/)+main\//)
      expect(strip(file.text), file.path).not.toMatch(/readiness\s*[!=]==|computer\??\.status\s*[!=]==|bootstrap\s*[!=]==/)
    }
  })

  it('never falls back to running a Compute-selected workload here: the coding service has no local path after an explicit Compute choice', () => {
    const coding = strip(readFileSync(join(root, 'main/coding/service.ts'), 'utf8'))
    expect(coding).toContain('Compute was selected, so nothing was started on this computer.')
    expect(coding).toMatch(/private async admit\(projectId: string, named\?: string\)/)
    // The admission is asked before anything is created, and on every later turn.
    expect(coding.indexOf('await this.admit(project.id, input.execution.environment)')).toBeGreaterThan(-1)
    expect(coding).toMatch(/await this\.admit\(session\.projectId\)/)
  })
})
