#!/usr/bin/env node
/*
 * A `compute` command that implements the *declared* environment contract of Compute main (docs/recipes.md, bootstrap.md, readiness.md,
 * lifecycle.md in the Compute repository) over a JSON state file, for tests that must reach states a real host cannot be made to reach on
 * demand: a failed bootstrap, a target that stops satisfying its requirements, a lost machine, a daemon that stops answering.
 *
 * It is not a second Compute. Its JSON is derived from recordings of real Compute main output (./compute-main/*.json), so the field
 * names, enumerations and nesting are Compute's; the same contract suite runs against the real binary (testkit.ts) wherever one is built.
 *
 *   FIXTURE_STATE   path of the state file (required)
 *   FIXTURE_LEGACY  =1: behave like Compute Configured 0.1.5, which has no recipes, bootstrap or readiness
 *   FIXTURE_CONTROLLER_VERSION: report a different running controller version/build than the installed CLI
 *   FIXTURE_AUTO    =1: an environment is `ready` as soon as it is created (default: it advances only through `__fixture advance`)
 *   FIXTURE_SLOW_START / FIXTURE_SLOW_STOP  =1: start stays `configuring`, stop stays `stopping`, until the test advances them
 *   `compute __fixture …` is the tests' hand on the world: advance NAME | set NAME <json> | daemon up|down | controller-restart | recipe NAME <json>
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const recorded = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'compute-main', name), 'utf8'))
const statePath = process.env.FIXTURE_STATE
const load = () => fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { daemon: 'up', recipes: {}, environments: {}, calls: [] }
const save = state => { const scratch = `${statePath}.${process.pid}`; fs.writeFileSync(scratch, JSON.stringify(state)); fs.renameSync(scratch, statePath) }   // atomic: concurrent readers never see half a file
const out = value => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`)
const fail = (message, code = 1) => { process.stderr.write(`${message}\n`); process.exit(code) }
const digest = spec => `sha256:${crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex')}`
const now = () => new Date().toISOString()

let args = process.argv.slice(2)
const flag = name => { const index = args.indexOf(name); if (index < 0) return undefined; const value = args[index + 1]; args.splice(index, 2); return value }
const bool = name => { const index = args.indexOf(name); if (index < 0) return false; args.splice(index, 1); return true }
const dash = args.indexOf('--'); const tail = dash >= 0 ? args.splice(dash).slice(1) : []
const daemon = flag('--daemon') ?? 'http://127.0.0.1:8787'; const json = bool('--json'); const recipeFlag = flag('--recipe'); const fileFlag = flag('--file'); const versionFlag = args[0] === 'recipe' ? flag('--version') : undefined
const state = load()
const probe = args[0] === '--version' || args.includes('--help')   // read-only probes leave the state file alone
if (!probe) state.calls.push(args.join(' '))

if (process.env.FIXTURE_LEGACY === '1') {
  if (args[0] === '--version') { out('compute 0.1.5'); process.exit(0) }
  if (args[0] === 'recipe') fail("error: unrecognized subcommand 'recipe'\n\nUsage: compute [OPTIONS] <COMMAND>", 2)
  if (args[0] === 'environment' && args[1] === 'create' && args.includes('--help')) { out('Usage: compute environment create [OPTIONS] <NAME>\n  --cpu <CPU>\n  --memory <MEMORY>\n  --ephemeral'); process.exit(0) }
}

const unreachable = () => { save(state); fail(`runtime error: cannot reach the Compute daemon at ${daemon}: Connection refused`) }
const needDaemon = () => { if (state.daemon === 'down') unreachable() }

// ───────── the views, built from Compute's own recordings ─────────
const ready = recorded('environment-ready.json')
const explanations = {
  stopped: name => `${name} cannot run workloads: its computer is stopped. stopped: start it to make it ready`,
  destroyed: name => `${name} cannot run workloads: its computer is destroyed. destroyed`
}
function view(name) {
  const env = state.environments[name]
  const v = JSON.parse(JSON.stringify(ready))
  v.name = name; v.environment_id = env.id; v.computer.environment = name; v.computer.environment_id = env.id
  if (env.recipe) v.recipe = env.recipe; else delete v.recipe
  const c = v.computer, r = c.readiness, b = c.bootstrap
  const set = (status, observed, actual, readiness, bootstrap) => { c.status = status; c.reality.observed = observed; v.actual_state = actual; r.state = readiness; b.state = bootstrap }
  const conditions = (machine, detail) => { r.conditions = [{ name: 'machine', satisfied: machine, detail }] }
  delete c.failure; delete r.class; delete b.failure; delete r.unsatisfied
  switch (env.phase) {
    case 'created': set('pending', 'starting', 'starting', 'created', 'not_started'); conditions(false, 'no machine yet'); r.explanation = `${name} exists; its machine has not been provisioned yet.`; delete r.configuration; break
    case 'provisioning': set('provisioning', 'starting', 'starting', 'starting', 'not_started'); conditions(false, 'provisioning on this-machine'); r.explanation = `${name}'s machine is provisioning on this-machine.`; break
    case 'configuring': set('running', 'running', 'running', 'starting', 'running'); r.conditions = ready.computer.readiness.conditions.map(x => x.name === 'bootstrap' || x.name === 'contents' ? { ...x, satisfied: false, detail: 'being applied' } : x); r.explanation = `${name} is being brought to what it declares.`; b.steps = [{ kind: 'repository', name: 'app', outcome: 'pending' }]; delete b.completed_at; break
    case 'ready': break
    case 'degraded': r.state = 'degraded'; r.explanation = `${name} runs, but a declared process is impaired.`; break
    case 'stopping': set('stopping', 'stopping', 'running', 'unavailable', 'succeeded'); r.explanation = `${name} cannot run workloads: its computer is stopping.`; break
    case 'stopped': set('stopped', 'stopped', 'stopped', 'unavailable', 'succeeded'); r.explanation = explanations.stopped(name); break
    case 'destroying': set('destroying', 'reconciling', 'stopped', 'unavailable', 'succeeded'); r.explanation = `${name} cannot run workloads: its computer is being destroyed.`; break
    case 'destroyed': set('destroyed', 'destroyed', 'stopped', 'unavailable', 'succeeded'); r.explanation = explanations.destroyed(name); break
    case 'lost': set('lost', 'lost', 'running', 'unavailable', 'succeeded'); c.reality.explanation = 'The target no longer reports this machine.'; r.explanation = `${name} cannot run workloads: its computer is lost.`; break
    case 'bootstrap-failed':
      set('running', 'running', 'running', 'failed', 'failed'); r.class = 'configuration_failed'; r.explanation = `${name} failed to become ready: package install failed.`
      b.failure = { class: 'configuration_failed', operation: 'package install', message: 'npm install exited 1: ERESOLVE could not resolve', retryable: true, at: now() }
      c.failure = { phase: 'reconciliation', code: 'item_failed', message: 'a declared item failed', retryable: true, at: now() }; break
    case 'requirements-unsatisfied':
      set('running', 'running', 'running', 'unavailable', 'succeeded'); r.class = 'requirements_unsatisfied'
      r.unsatisfied = [{ code: 'runtime_unavailable', dimension: 'runtime', required: 'node 22', available: ['node 20.11.0'], detail: 'the target cannot resolve node 22' }]
      r.explanation = `${name} is unavailable: this-machine no longer satisfies its requirements: runtime_unavailable.`; break
    case 'placement-failed':
      set('provisioning', 'starting', 'starting', 'starting', 'not_started'); conditions(false, 'provisioning on this-machine')
      c.failure = { phase: 'placement', code: 'target_incompatible', message: 'invalid: no target can host this computer (explicit_provider_incompatible): this-machine: runtime_unavailable', retryable: true, target: 'this-machine', at: now() }; break
    case 'mystery': r.state = 'flourishing'; break
    default: fail(`fixture: unknown phase ${env.phase}`)
  }
  if (process.env.FIXTURE_BARE_INSPECT === '1') { delete c.readiness; delete c.bootstrap }
  return v
}
const summary = name => { const v = view(name); return { environment_id: v.environment_id, name, desired_state: v.desired_state, actual_state: v.actual_state, health: 'unknown', computer: v.computer.status, reality: v.computer.reality, target: 'this-machine' } }
const environment = name => state.environments[name] ?? (save(state), fail(`runtime error: not found: environment ${name}`))
const persist = value => { save(state); if (value !== undefined) out(value) }

const [a, b] = args
if (a === '--version') { out('compute 0.1.6'); process.exit(0) }
if (a === 'recipe' && args.includes('--help')) { out('Lifecycle policy as data: list, inspect, write, validate, and explain recipes'); process.exit(0) }
if (a === 'environment' && b === 'create' && args.includes('--help')) { out('Usage: compute environment create [OPTIONS] <NAME>\n      --recipe <RECIPE>  Ask for the computer a recipe resolves to\n      --stopped'); process.exit(0) }
if (a === 'version' && json) { persist({ version: '0.1.6', build_id: 'sha256:fixture-0.1.6' }); process.exit(0) }

// ───────── the tests' hand on the world ─────────
if (a === '__fixture') {
  const [, verb, target, payload] = args
  if (verb === 'advance') { const order = ['created', 'provisioning', 'configuring', 'ready']; const env = environment(target); const i = order.indexOf(env.phase); if (i >= 0 && i < order.length - 1) env.phase = order[i + 1] }
  else if (verb === 'phase') environment(target).phase = payload
  else if (verb === 'set') Object.assign(environment(target), JSON.parse(payload))
  else if (verb === 'daemon') state.daemon = target
  else if (verb === 'recipe') { const spec = JSON.parse(payload); const existing = state.recipes[target]; const version = (existing?.version ?? 0) + 1; state.recipes[target] = { name: target, version, status: 'current', digest: digest(spec), spec, author: 'development', created_at: now(), satisfiable: spec.__unsatisfiable ? false : true } }
  else if (verb === 'controller-restart') { for (const env of Object.values(state.environments)) if (env.phase === 'ready' || env.phase === 'configuring') { /* state survives a controller restart; readiness is evaluated again */ } }
  else if (verb === 'calls') { out(state.calls.filter(call => !call.startsWith('__fixture')).join('\n')); process.exit(0) }
  persist(); process.exit(0)
}

if (a === 'status') { needDaemon(); out('Compute daemon: running'); persist(); process.exit(0) }
needDaemon()
if (a === 'node' && b === 'info') {
  const version = process.env.FIXTURE_CONTROLLER_VERSION ?? '0.1.6'
  persist({ controller: { version, build_id: `sha256:fixture-${version}`, executable: '/fixture/compute' } }); process.exit(0)
}

if (a === 'recipe' && b === 'list') { persist(Object.values(state.recipes).map(({ satisfiable, ...recipe }) => recipe)); process.exit(0) }
if (a === 'recipe' && b === 'create') {
  const name = args[2]
  if (!fileFlag || !fs.existsSync(fileFlag)) fail('runtime error: recipe file not found')
  const spec = JSON.parse(fs.readFileSync(fileFlag, 'utf8')); const existing = state.recipes[name]; const version = (existing?.version ?? 0) + 1
  state.recipes[name] = { name, version, status: 'current', digest: digest(spec), spec, author: 'development', created_at: now(), satisfiable: spec.__unsatisfiable ? false : true }
  persist(); process.exit(0)
}
if (a === 'recipe' && b === 'resolve') {
  const recipe = state.recipes[args[2]]
  if (!recipe) { save(state); fail(`runtime error: not found: recipe ${args[2]}`) }
  const tpl = recorded(recipe.satisfiable === false ? 'resolve-unsatisfied.json' : 'resolve-satisfiable.json')
  tpl.recipe = { name: recipe.name, version: recipe.version, digest: recipe.digest }
  tpl.resolved.computer.lifecycle = recipe.spec.lifecycle ?? 'persistent'; tpl.resolved.computer.requirements = { network: 'network', isolation: 'process', ...(recipe.spec.requirements ?? {}) }
  persist(tpl); process.exit(0)
}
if (a === 'environment' && b === 'create') {
  const name = args[2]; const [rname, rversion] = (recipeFlag ?? '').split('@')
  if (state.environments[name]) { save(state); fail(`runtime error: conflict: environment ${name} already exists`) }
  const recipe = rname ? state.recipes[rname] : undefined
  if (rname && (!recipe || (rversion && Number(rversion) !== recipe.version))) { save(state); fail(`runtime error: not found: recipe ${recipeFlag}`) }
  if (recipe && recipe.satisfiable === false) { save(state); fail(`runtime error: no target satisfies recipe ${rname}`, 2) }
  state.environments[name] = { id: `env_${crypto.randomBytes(12).toString('hex')}`, phase: process.env.FIXTURE_AUTO === '1' ? 'ready' : 'created', recipe: recipe ? { name: recipe.name, version: recipe.version, digest: recipe.digest } : undefined }
  persist(view(name)); process.exit(0)
}
if (a === 'environment' && b === 'list') { persist(Object.keys(state.environments).map(summary)); process.exit(0) }
if (a === 'environment' && (b === 'inspect' || b === 'status' || b === 'info')) { environment(args[2]); persist(view(args[2])); process.exit(0) }
if (a === 'environment' && b === 'computer') { environment(args[2]); const v = view(args[2]); persist({ ...v.computer, environment: args[2], observed: v.computer.observed ?? { processes: {} } }); process.exit(0) }
if (a === 'environment' && ['start', 'stop', 'restart', 'reconcile', 'destroy'].includes(b)) {
  const name = args[2]; const env = environment(name); const before = view(name)
  if (b === 'stop') env.phase = process.env.FIXTURE_SLOW_STOP === '1' ? 'stopping' : 'stopped'
  else if (b === 'start') env.phase = process.env.FIXTURE_SLOW_START === '1' ? 'configuring' : 'ready'   // Compute re-verifies a started environment quickly
  else if (b === 'restart') env.phase = 'ready'
  else if (b === 'reconcile') env.phase = 'configuring'
  else if (b === 'destroy') {
    if (env.destroyFails) { env.phase = 'destroying'; save(state); fail(`runtime error: environment ${name} was not destroyed: termination_failed: a process the machine owns is still alive`) }
    env.phase = 'destroyed'
  }
  save(state)
  // Compute answers the request with the view as it was; the outcome is read afterwards.
  if (b === 'destroy') out({ ...before, status: 'destroyed' }); else out(before)
  process.exit(0)
}
save(state); fail(`fixture: unsupported command: ${args.join(' ')}`, 2)
