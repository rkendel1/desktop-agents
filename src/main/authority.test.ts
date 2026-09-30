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

describe('Jev structured-decision authority', () => {
  const jevFiles = production.filter(file => /(?:^|\/)jev(?:Tools)?\.ts$/.test(file.path))
  const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('cannot discover reality, execute tools, browse, or mutate source', () => {
    expect(jevFiles.map(file => file.path).sort()).toEqual(['main/jev.ts', 'main/jevTools.ts', 'shared/jev.ts'])
    for (const file of jevFiles) expect(strip(file.text), file.path).not.toMatch(/from ['"]node:(?:fs|child_process|http|https|net)|\bfetch\(|\bspawn\(|\bexecFile\(|writeFile|unlink|rename|shell\.|browser/i)
  })

  it('uses the public local runtime through one adapter and never a remote or subprocess model path', () => {
    expect(offenders(/from '@rust-ml-runtime\/node'/, ['main/jev.ts'])).toEqual([])
    expect(strip(readFileSync(join(root, 'main/jev.ts'), 'utf8'))).not.toMatch(/openai|anthropic|ollama|python|child_process|\bfetch\(/i)
  })

  it('owns no database, cache, event bus, hidden model store or global mutable state', () => {
    for (const file of jevFiles) {
      const code = strip(file.text)
      expect(code, file.path).not.toMatch(/sqlite|redis|localStorage|sessionStorage|FileJsDb|\.collection\(|createFeltDB|EventEmitter|setInterval/i)
      expect(code, file.path).not.toMatch(/^(?:export )?(?:const|let|var) \w+(?::[^=]+)? = new (?:Map|Set|WeakMap)\b/m)
    }
    const flow = readFileSync(join(root, 'main/felt/desktop.flow'), 'utf8')
    expect(flow).not.toMatch(/collection (?:Jev|ModelCache|JevCache|JevStore)/)
    expect([...flow.matchAll(/collection (Evidence|Evaluation|Decision) \{/g)].map(match => match[1]).sort()).toEqual(['Decision', 'Evaluation', 'Evidence'])
  })

  it('persists only through DesktopRepository', () => {
    expect(offenders(/saveJevEvaluation\(/, ['main/desktopRepository.ts', 'main/jev.ts'])).toEqual([])
    expect(readFileSync(join(root, 'main/jev.ts'), 'utf8')).not.toMatch(/\.felt\.|felt\.collection|felt\.transaction/)
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

/**
 * Guards the invariants of the model fabric (docs/model-fabric.md): routing is provider-neutral, a paid model cannot reach a provider
 * under free-only, and the fabric adds no hidden authority — no store of its own, no credentials, no module-level state.
 */
describe('Model fabric authority', () => {
  const fabricFiles = production.filter(file => /^main\/models\/[^/]+\.ts$/.test(file.path) && !/testing\.ts$/.test(file.path))
  const core = fabricFiles.filter(file => /(?:router|health|fabric|access|stream|store|cli|provider)\.ts$/.test(file.path))
  const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const file = (name: string): string => strip(fabricFiles.find(item => item.path === `main/models/${name}`)!.text)

  it('routes without knowing any provider or model: no vendor or model name in the router, ledger, fabric, policy or streaming code', () => {
    expect(core.length).toBeGreaterThanOrEqual(6)
    // (adapters.ts speaks Foundry’s existing provider *kinds* — openai/anthropic/ollama protocols — and is checked for model names below.)
    for (const item of core) {
      expect(strip(item.text), item.path).not.toMatch(/openrouter|anthropic|openai|gemini|claude|gpt-|llama|mistral|deepseek|qwen|gemma|grok/i)
    }
    expect(file('adapters.ts')).not.toMatch(/'(?:gpt|claude|gemini|llama|qwen|mistral)[-\w.]*'/i)
  })

  it('checks the cost policy again at the point of invocation, before the provider call, and calls providers only from the router path', () => {
    const router = file('router.ts')
    expect(router.indexOf('guardInvocation(candidate, policy, input.now())')).toBeGreaterThan(-1)
    expect(router.indexOf('guardInvocation(candidate, policy, input.now())')).toBeLessThan(router.indexOf('await input.invoke(candidate)'))
    // Providers are invoked from the fabric’s complete(), which is inside route(): nowhere else in the fabric reaches provider.invoke.
    const callers = (pattern: RegExp): string[] => fabricFiles.filter(item => pattern.test(strip(item.text))).map(item => item.path)
    expect(callers(/\bprovider\.invoke\(/)).toEqual(['main/models/fabric.ts'])
    expect(callers(/\.invoke\(candidate,\s*invocation/)).toEqual(['main/models/fabric.ts'])
    // The access gate is the single function both the plan and the guard use.
    expect(file('router.ts')).toMatch(/budgetRejection\(candidate, policy, now\)/); expect(file('access.ts')).toContain("if (budget.kind === 'free-only')")
  })

  it('fails closed: unknown access, staleness and any budget it does not understand are refused', () => {
    const access = file('access.ts')
    expect(access).toContain("FREE_ONLY_ACCESS.includes(candidate.access)"); expect(access).toContain("'stale-pricing'"); expect(access).toContain("'unsupported-budget'")
    expect(readFileSync(join(root, 'shared/modelFabric.ts'), 'utf8')).toMatch(/FREE_ONLY_ACCESS: readonly ModelAccess\[\] = \['local', 'free', 'beta', 'trial'\]/)
    // The budget cannot be changed by a setting: it is written as free-only, and a stored value is not read back.
    expect(file('fabric.ts')).toMatch(/budget: \{ kind: 'free-only' \}/)
  })

  it('adds no hidden authority: no store, cache, database or module-level state of its own', () => {
    for (const item of fabricFiles) {
      const code = strip(item.text)
      expect(code, item.path).not.toMatch(/sqlite|\bredis\b|localStorage|sessionStorage|new FileJsDb|node:fs|felt\.|\.collection\(/i)
      expect(code, item.path).not.toMatch(/^(?:export )?(?:const|let|var) \w+(?::[^=]+)? = new (?:Map|Set|WeakMap)\b/m)
    }
    const flow = readFileSync(join(root, 'main/felt/desktop.flow'), 'utf8')
    expect(flow).not.toMatch(/collection (?:Model|Fabric)/)
    // Persistence goes through the existing settings only.
    expect(file('store.ts')).toContain('repository.setSetting(FABRIC_SETTING')
  })

  it('never stores or shows a credential: candidates carry no key field, and the registry is built without one', () => {
    expect(readFileSync(join(root, 'shared/modelFabric.ts'), 'utf8')).not.toMatch(/apiKey|secret|password|bearer/i)
    expect(file('fabric.ts')).not.toMatch(/apiKey|secret|password|bearer/i)
    expect(file('access.ts')).not.toMatch(/apiKey|secret|password|bearer/i)
  })

  it('is optional and compatible: automatic routing is off by default unless an agent explicitly selects it, and the direct path remains available', () => {
    expect(readFileSync(join(root, 'shared/modelFabric.ts'), 'utf8')).toContain("automatic: false")
    const runtime = readFileSync(join(root, 'main/runtime.ts'), 'utf8')
    expect(runtime).toMatch(/if \(!config\.automaticModelSelection && !\(await fabric\.policy\(\)\)\.automatic\) source = direct\(\)/)
    expect(runtime).toMatch(/if \(!fabric \|\| config\.localAgentId \|\| !config\.provider\.startsWith\(CUSTOM_PROVIDER_PREFIX\)\) return direct\(\)/)
  })
})
