import { randomBytes } from 'node:crypto'
import type { ComputeContractStatus, DevelopmentEnvironmentDetail, DevelopmentEnvironmentRef, DevelopmentEnvironmentView, DevelopmentSetupProgress, DevelopmentSetupResult, DevelopmentSetupStep, EnvironmentAction, EnvironmentReason, EnvironmentState, RecipeResolutionView, RecipeSummary } from '../../shared/types'
import { ComputeClient, ComputeError, type ComputeEnvironmentRecord } from '../compute/client'
import type { DesktopRepository } from '../desktopRepository'
import { present, presentDetail, presentResolution } from './presentation'

/** A request the Environment surface will not carry out, with the reason. `invalid` and `not-found` and `conflict` map to AppPort's own codes. */
export class EnvironmentError extends Error {
  constructor(readonly code: 'invalid' | 'not-found' | 'conflict' | 'compute', message: string, readonly category?: string) { super(message); this.name = 'EnvironmentError' }
}

/**
 * Why a workload was not admitted. Foundry never falls back to running it somewhere else: the session refuses, and this says why.
 * `state` and `reason` are Compute's answer, translated (see presentation.ts).
 */
export class EnvironmentRefusal extends Error {
  constructor(readonly code: 'no-environment' | 'compute-unavailable' | 'missing' | 'mismatch' | 'not-ready', message: string, readonly state: EnvironmentState, readonly reason?: EnvironmentReason) { super(message); this.name = 'EnvironmentRefusal' }
}

export interface Admission { environment: string; environmentId: string; view: DevelopmentEnvironmentView }

export interface EnvironmentServiceOptions {
  /** How long an action waits for Compute to confirm before returning what Compute says at that moment. The person's view keeps following Compute either way. */
  settleMs?: number
  pollMs?: number
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/g, '')
const isCompute = (error: unknown, ...codes: ComputeError['code'][]): error is ComputeError => error instanceof ComputeError && codes.includes(error.code)
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * The developer control plane for a project's environment.
 *
 *   Foundry project → (reference) → Compute environment → Computer → bootstrap → readiness → workload
 *
 * Foundry keeps one thing: the reference from a project to a Compute environment (`DevelopmentEnvironmentRef`). Everything else — the
 * recipe and its provenance, the Computer, its configuration, readiness and lifecycle — is asked of Compute through the one
 * `ComputeClient` each time it is shown, and translated for display (presentation.ts). This service does not provision, place, install,
 * decide readiness, or end a process: it asks Compute to (recipe resolve, environment create, start/stop/restart/reconcile/destroy), then
 * reads back what Compute says. It holds no cache of Compute's state; after a restart of Foundry, Compute or the controller, the next
 * `view` is simply Compute's answer for the stored reference.
 */
export class EnvironmentService {
  private readonly settleMs: number
  private readonly pollMs: number
  /** Projects with a create or a destructive action in flight — a guard against a double click, not state about Compute. */
  private readonly inFlight = new Set<string>()

  constructor(private readonly repository: DesktopRepository, private readonly compute: ComputeClient, options: EnvironmentServiceOptions = {}) {
    this.settleMs = options.settleMs ?? 20_000
    this.pollMs = options.pollMs ?? 400
  }

  // ───────────────────────────── reading ─────────────────────────────

  private async observe(projectId: string): Promise<{ ref?: DevelopmentEnvironmentRef; record?: ComputeEnvironmentRecord; view: DevelopmentEnvironmentView }> {
    const project = await this.repository.project(projectId)
    if (!project) throw new EnvironmentError('not-found', 'Project not found')
    let ref = await this.repository.developmentEnvironment(projectId)
    const contract = await this.compute.environmentContract({ daemon: !ref })
    const base = { projectId, compute: contract, ...(ref ? { reference: ref } : {}), progress: [], observedAt: Date.now() }
    const unavailable = (status: ComputeContractStatus): { ref?: DevelopmentEnvironmentRef; view: DevelopmentEnvironmentView } => ({ ...(ref ? { ref } : {}),
      view: { ...base, compute: status, state: 'compute-unavailable', actions: [], ...(status.ok ? {} : { reason: { category: status.reason, title: status.reason === 'upgrade-required' ? 'Compute update required.' : 'Compute is unavailable.', message: status.message } }) } })
    if (!contract.ok) return unavailable(contract)
    if (!ref) return { view: { ...base, state: 'none', actions: ['create'] } }
    let record: ComputeEnvironmentRecord
    try { record = await this.compute.inspectEnvironment(ref.environment) } catch (error) {
      if (isCompute(error, 'not-found')) return { ref, view: { ...base, state: 'missing', actions: ['create'], reason: {
        category: 'environment_missing', title: 'Environment unavailable',
        message: ref.environmentId ? 'The Compute environment associated with this project no longer exists.' : 'This project’s environment was never recorded by Compute — creating it was interrupted.' } } }
      if (isCompute(error, 'daemon-unreachable')) return unavailable({ ok: false, reason: 'daemon-unreachable', installed: contract.installed, message: error.message })
      if (isCompute(error, 'unsupported')) return unavailable({ ok: false, reason: 'upgrade-required', installed: contract.installed, message: `Compute update required. ${error.message}` })
      return unavailable({ ok: false, reason: 'error', installed: contract.installed, message: message(error) })
    }
    if (ref.environmentId && record.environment_id !== ref.environmentId) {
      return { ref, view: { ...base, state: 'missing', actions: ['create'], reason: { category: 'environment_replaced', title: 'Environment unavailable',
        message: 'The Compute environment associated with this project no longer exists; Compute now has a different environment under that name.' } } }
    }
    if (!ref.environmentId) ref = await this.repository.putDevelopmentEnvironment({ ...ref, environmentId: record.environment_id })   // an interrupted create that Compute did record
    return { ref, record, view: { ...base, reference: ref, ...present(record) } }
  }

  /** The project’s environment as Compute reports it now. */
  async view(projectId: string): Promise<DevelopmentEnvironmentView> { return (await this.observe(projectId)).view }

  /** The optional inspection surface: Compute’s inspect output, and Compute’s own certification statement when the installation makes one. */
  async detail(projectId: string): Promise<DevelopmentEnvironmentDetail> {
    const { record, view } = await this.observe(projectId)
    if (!record) return view
    let certification: NonNullable<DevelopmentEnvironmentView['computer']>['certification']
    try { certification = (await this.compute.platform()).platform } catch { /* Compute makes no statement here: none is shown */ }
    const platform = view.computer?.platform
    const matches = certification && platform && certification.platform === platform.replace('/', '-')
    return { ...view, ...(view.computer && matches ? { computer: { ...view.computer, certification } } : {}), detail: presentDetail(record) }
  }

  // ───────────────────────────── recipes ─────────────────────────────

  private async requireContract(): Promise<void> {
    const contract = await this.compute.environmentContract()
    if (!contract.ok) throw new EnvironmentError('compute', contract.message, contract.reason)
  }

  /** The recipes Compute has. Foundry writes none: recipes are Compute’s policy data. */
  async recipes(): Promise<RecipeSummary[]> {
    await this.requireContract()
    return (await this.compute.recipes()).map(recipe => ({ name: recipe.name, version: recipe.version, digest: recipe.digest, lifecycle: recipe.spec.lifecycle ?? 'persistent',
      ...(recipe.spec.description ? { description: recipe.spec.description } : {}), ...(recipe.author ? { author: recipe.author } : {}) }))
  }

  /** Ask Compute to register a recipe file. No recipe bytes or lifecycle state are persisted by Foundry. */
  async createRecipe(name: string, file: string): Promise<RecipeSummary[]> {
    const clean = name.trim()
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(clean)) throw new EnvironmentError('invalid', 'Recipe name must use lowercase letters, numbers, dots, dashes, or underscores.')
    await this.requireContract()
    try { await this.compute.createRecipe(clean, file) } catch (error) { throw new EnvironmentError('compute', message(error)) }
    return this.recipes()
  }

  /** What Compute says a recipe would do, and whether any target can host it. */
  async resolve(recipe: string, version?: number): Promise<RecipeResolutionView> {
    await this.requireContract()
    try { return presentResolution(await this.compute.resolveRecipe(recipe, version)) } catch (error) {
      if (isCompute(error, 'not-found')) throw new EnvironmentError('not-found', `Compute has no recipe named "${recipe}"${version !== undefined ? ` at version ${version}` : ''}.`)
      throw new EnvironmentError('compute', message(error))
    }
  }

  /**
   * The explicit one-click development path. This orchestrates Compute's own
   * recipe/validation/environment contracts and persists only the Project →
   * environment reference. Existing user recipes and environments are reused,
   * never edited or replaced.
   */
  async setupDevelopment(projectId: string, progress: (value: DevelopmentSetupProgress) => void = () => undefined): Promise<DevelopmentSetupResult> {
    if (!(await this.repository.project(projectId))) throw new EnvironmentError('not-found', 'Project not found')
    if (this.inFlight.has(projectId)) throw new EnvironmentError('conflict', 'An environment operation is already in progress for this project.')
    const steps: DevelopmentSetupStep[] = [
      { id: 'compute', label: 'Checking Compute', status: 'active' },
      { id: 'recipe', label: 'Finding Developer recipe', status: 'pending' },
      { id: 'validation', label: 'Validating Developer recipe', status: 'pending' },
      { id: 'environment', label: 'Creating development environment', status: 'pending' },
      { id: 'computer', label: 'Waiting for Computer readiness', status: 'pending' }
    ]
    let active: DevelopmentSetupStep['id'] = 'compute'
    const reportStep = (id: DevelopmentSetupStep['id'], status: DevelopmentSetupStep['status'], label?: string): void => {
      const step = steps.find(item => item.id === id)!
      step.status = status
      if (label) step.label = label
      progress({ projectId, steps: steps.map(item => ({ ...item })) })
    }
    const next = (done: DevelopmentSetupStep['id'], id: DevelopmentSetupStep['id'], label?: string): void => {
      reportStep(done, 'done'); active = id; reportStep(id, 'active', label)
    }
    const result = async (view: DevelopmentEnvironmentView): Promise<DevelopmentSetupResult> => {
      reportStep('computer', view.state === 'ready' || view.state === 'degraded' ? 'done' : ['failed', 'not-ready', 'compute-unavailable', 'missing'].includes(view.state) ? 'failed' : 'active',
        view.state === 'ready' || view.state === 'degraded' ? 'Computer ready' : 'Waiting for Computer readiness')
      return { projectId, steps: steps.map(item => ({ ...item })), view }
    }
    this.inFlight.add(projectId)
    progress({ projectId, steps: steps.map(item => ({ ...item })) })
    try {
      await this.requireContract()

      // A Project already attached to a real environment keeps it. This path
      // does not reinterpret or overwrite its recipe.
      const prior = await this.repository.developmentEnvironment(projectId)
      if (prior) {
        const observed = await this.observe(projectId)
        if (!['missing', 'destroyed'].includes(observed.view.state)) {
          next('compute', 'recipe', 'Using Project recipe'); reportStep('recipe', 'done')
          reportStep('validation', 'done', 'Existing Compute environment retained')
          reportStep('environment', 'done', `Using environment ${prior.environment}`)
          active = 'computer'; reportStep('computer', 'active')
          if (observed.view.state === 'stopped') await this.compute.lifecycle(prior.environment, 'start')
          return result(await this.settle(projectId, 'setup'))
        }
      }

      next('compute', 'recipe')
      let recipe = (await this.compute.recipes()).find(item => item.name === 'developer')
      if (!recipe) {
        reportStep('recipe', 'active', 'Creating Developer recipe')
        const starter = await this.compute.starterRecipe('dev')
        if (!starter) throw new EnvironmentError('compute', 'Compute is ready, but this installed Compute distribution does not include its Developer starter recipe. Update Compute, then retry.', 'starter_unavailable')
        await this.compute.createRecipe('developer', starter)
        recipe = (await this.compute.recipes()).find(item => item.name === 'developer')
        if (!recipe) throw new EnvironmentError('compute', 'Compute did not report the Developer recipe after creating it.', 'recipe_creation_failed')
      }

      next('recipe', 'validation')
      const validation = await this.compute.validateRecipe('developer', recipe.version)
      if (validation.verdict !== 'satisfiable') {
        const detail = validation.verdict === 'invalid' ? (validation.problems ?? []).join('; ') || 'Compute reported the recipe invalid.'
          : validation.placement?.failure?.message ?? 'No Computer can satisfy the Developer recipe.'
        throw new EnvironmentError('conflict', `Developer recipe exists but failed validation. ${detail}`, validation.verdict === 'invalid' ? 'invalid' : 'requirements_unsatisfied')
      }

      next('validation', 'environment')
      let environment: ComputeEnvironmentRecord | undefined
      try { environment = await this.compute.inspectEnvironment('dev') } catch (error) { if (!isCompute(error, 'not-found')) throw error }
      if (environment) {
        if (environment.recipe?.name !== 'developer') throw new EnvironmentError('conflict', 'Compute environment “dev” already exists with different configuration. Foundry will not replace it.', 'environment_conflict')
        if (environment.computer?.reality.observed === 'destroyed') throw new EnvironmentError('conflict', 'Compute environment “dev” exists as a destroyed record and cannot be replaced by Foundry. Manage it in Compute.', 'environment_destroyed')
      } else {
        const requested: DevelopmentEnvironmentRef = { projectId, environment: 'dev', requestedRecipe: { name: 'developer', version: recipe.version }, createdAt: Date.now() }
        await this.repository.putDevelopmentEnvironment(requested)
        try { environment = await this.compute.createFromRecipe('dev', { name: 'developer', version: recipe.version }) } catch (error) {
          const recorded = await this.compute.inspectEnvironment('dev').catch(() => undefined)
          if (!recorded) { if (prior) await this.repository.putDevelopmentEnvironment(prior); else await this.repository.deleteDevelopmentEnvironment(projectId) }
          throw error
        }
      }
      await this.repository.putDevelopmentEnvironment({ projectId, environment: 'dev', environmentId: environment.environment_id,
        requestedRecipe: { name: 'developer', version: recipe.version }, createdAt: prior?.createdAt ?? Date.now() })

      next('environment', 'computer')
      const observed = await this.observe(projectId)
      if (observed.view.state === 'stopped') await this.compute.lifecycle('dev', 'start')
      return result(await this.settle(projectId, 'setup'))
    } catch (error) {
      reportStep(active, 'failed')
      if (error instanceof EnvironmentError) throw error
      const failedAt = active as DevelopmentSetupStep['id']
      const prefix = failedAt === 'recipe' ? 'Could not create the Developer recipe.' : failedAt === 'validation' ? 'The Developer recipe could not be validated.'
        : failedAt === 'environment' ? 'The Developer recipe is valid, but Compute could not create the development environment.' : failedAt === 'computer' ? 'The environment exists, but its Computer did not start.' : 'Compute is unavailable.'
      throw new EnvironmentError('compute', `${prefix} ${message(error)}`, error instanceof ComputeError ? error.code : undefined)
    } finally { this.inFlight.delete(projectId) }
  }

  // ───────────────────────────── acting ─────────────────────────────

  /**
   * Create the project's environment from a recipe. Compute resolves the recipe, places the Computer, records the environment and
   * bootstraps it; this returns as soon as Compute has recorded it, and the view follows Compute from there (creating → configuring →
   * ready). An environment the project already has is never replaced silently: only a `missing` or `destroyed` one may be created again.
   */
  async create(input: { projectId: string; recipe: string; version?: number }): Promise<DevelopmentEnvironmentView> {
    const project = await this.repository.project(input.projectId)
    if (!project) throw new EnvironmentError('not-found', 'Project not found')
    if (this.inFlight.has(input.projectId)) throw new EnvironmentError('conflict', 'An environment operation is already in progress for this project.')
    this.inFlight.add(input.projectId)
    try {
      await this.requireContract()
      const previous = await this.repository.developmentEnvironment(input.projectId)
      if (previous) {
        const current = await this.observe(input.projectId)
        if (!['missing', 'destroyed'].includes(current.view.state)) throw new EnvironmentError('conflict', 'This project already has an environment. Destroy it before creating another.')
      }
      const resolution = await this.compute.resolveRecipe(input.recipe, input.version).catch(error => {
        if (isCompute(error, 'not-found')) throw new EnvironmentError('not-found', `Compute has no recipe named "${input.recipe}".`)
        throw new EnvironmentError('compute', message(error))
      })
      if (resolution.verdict !== 'satisfiable' || !resolution.recipe) {
        const why = resolution.verdict === 'invalid' ? `the recipe is invalid: ${(resolution.problems ?? []).join('; ')}` : `no Computer can satisfy it: ${resolution.placement?.failure?.message ?? 'Compute found no target that meets its requirements'}`
        throw new EnvironmentError('conflict', `Compute will not create an environment from "${input.recipe}": ${why}.`, resolution.verdict === 'invalid' ? 'invalid' : 'requirements_unsatisfied')
      }
      const name = `foundry-${slug(project.name) || 'project'}-${randomBytes(3).toString('hex')}`
      const requested = { projectId: input.projectId, environment: name, requestedRecipe: { name: resolution.recipe.name, version: resolution.recipe.version }, createdAt: Date.now() }
      // The reference is written before Compute is asked, so a Foundry that dies mid-request can still find (or report) what it asked for.
      await this.repository.putDevelopmentEnvironment(requested)
      let created: ComputeEnvironmentRecord
      try { created = await this.compute.createFromRecipe(name, resolution.recipe) } catch (error) {
        // The request may have reached Compute before it failed: ask, rather than assume.
        const recorded = await this.compute.inspectEnvironment(name).then(() => true, () => false)
        if (!recorded) { if (previous) await this.repository.putDevelopmentEnvironment(previous); else await this.repository.deleteDevelopmentEnvironment(input.projectId) }
        throw new EnvironmentError('compute', message(error))
      }
      await this.repository.putDevelopmentEnvironment({ ...requested, environmentId: created.environment_id })
    } finally { this.inFlight.delete(input.projectId) }
    return this.view(input.projectId)
  }

  /**
   * Ask Compute to restart, stop, start, retry (`reconcile`) or destroy, then read what Compute says. The returned view is Compute’s
   * confirmation if it arrived within the settle window, and otherwise Compute’s current state (`stopping`, `destroying`, …) — never
   * the requested outcome.
   */
  async act(projectId: string, action: Exclude<EnvironmentAction, 'open' | 'create'>): Promise<DevelopmentEnvironmentView> {
    if (this.inFlight.has(projectId)) throw new EnvironmentError('conflict', 'An environment operation is already in progress for this project.')
    this.inFlight.add(projectId)
    try {
      const { ref, view } = await this.observe(projectId)
      if (!ref) throw new EnvironmentError('not-found', 'This project has no environment.')
      if (view.state === 'compute-unavailable') throw new EnvironmentError('compute', view.reason?.message ?? 'Compute is unavailable.', view.compute.ok ? undefined : view.compute.reason)
      if (!view.actions.includes(action)) throw new EnvironmentError('conflict', `The environment is ${view.state}; Compute’s state does not allow “${action}” now.`, view.state)
      try {
        if (action === 'retry') await this.compute.reconcile(ref.environment)
        else if (action === 'destroy') await this.compute.destroyEnvironment(ref.environment)
        else await this.compute.lifecycle(ref.environment, action)
      } catch (error) { throw new EnvironmentError('compute', message(error), error instanceof ComputeError ? error.code : undefined) }
      const settled = await this.settle(projectId, action)
      // A destroyed environment the person asked to destroy is no longer their project’s environment — but only once Compute has said so.
      if (action === 'destroy' && (settled.state === 'destroyed' || settled.state === 'missing')) { await this.repository.deleteDevelopmentEnvironment(projectId); return this.view(projectId) }
      return settled
    } finally { this.inFlight.delete(projectId) }
  }

  private async settle(projectId: string, action: string): Promise<DevelopmentEnvironmentView> {
    const done = (state: EnvironmentState): boolean => action === 'stop' ? state === 'stopped'
      : action === 'destroy' ? state === 'destroyed' || state === 'missing'
      : ['ready', 'degraded', 'failed', 'not-ready', 'unknown', 'compute-unavailable'].includes(state)
    const deadline = Date.now() + this.settleMs
    for (;;) {
      const view = await this.view(projectId)
      if (done(view.state) || Date.now() >= deadline) return view
      await new Promise(resolve => setTimeout(resolve, this.pollMs))
    }
  }

  // ───────────────────────────── workloads ─────────────────────────────

  /**
   * Whether a workload may start on this project’s environment. Four questions, asked of Compute now: does the environment exist, is it the
   * one this project references, does Compute say it admits workloads (`ready`, or `degraded`, which Compute admits) — and can Compute be
   * reached at all. Anything else is a refusal that says why. It is never a reason to run the workload somewhere else.
   */
  async admit(projectId: string): Promise<Admission> {
    const { ref, record, view } = await this.observe(projectId)
    const refuse = (code: EnvironmentRefusal['code'], text: string): never => { throw new EnvironmentRefusal(code, text, view.state, view.reason) }
    if (!ref) return refuse('no-environment', 'This project has no development environment. Create one from Project Home first.')
    if (view.state === 'compute-unavailable') return refuse('compute-unavailable', `${view.reason?.message ?? 'Compute is unavailable.'}`)
    if (view.state === 'missing' || !record) return refuse(view.reason?.category === 'environment_replaced' ? 'mismatch' : 'missing', `${view.reason?.message ?? 'The environment no longer exists.'} Create a new environment for this project.`)
    if (view.state !== 'ready' && view.state !== 'degraded') {
      const why = view.reason ? `${view.reason.title} ${view.reason.message}` : `Compute reports it ${view.readiness ?? view.state}.`
      return refuse('not-ready', `The environment “${ref.environment}” is ${view.state.replace('-', ' ')}, not ready for workloads. ${why}`)
    }
    return { environment: ref.environment, environmentId: record.environment_id, view }
  }
}
