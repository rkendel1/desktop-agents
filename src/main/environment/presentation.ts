import type { DevelopmentEnvironmentDetail, DevelopmentEnvironmentView, EnvironmentAction, EnvironmentProgressStep, EnvironmentReason, EnvironmentState } from '../../shared/types'
import { platformName, type ComputeEnvironmentRecord, type ComputeFailureClass, type ComputeIncompatibility, type ComputeRecipeResolution } from '../compute/client'
import type { RecipeResolutionView } from '../../shared/types'

/**
 * Compute's answer, translated for display. This file is a table, not a state machine: every output is a function of fields Compute
 * reported *in this one answer* — readiness, bootstrap, the Computer's observed lifecycle and its failure record. It keeps nothing,
 * decides nothing about the machine, and never turns "the Computer exists" or "the Computer is running" into "ready": the only route
 * to `ready` is Compute's `readiness.state === 'ready'`. Anything it does not recognise is `unknown`, which admits nothing.
 */

/** Human sentences for Compute's failure classes (docs/bootstrap.md). The class itself is always kept for diagnostics. */
const CLASS_TEXT: Record<ComputeFailureClass, { title: string; message: string }> = {
  requirements_unsatisfied: { title: 'Environment couldn’t become ready.', message: 'The selected Computer cannot satisfy what this environment requires.' },
  configuration_failed: { title: 'Environment configuration failed.', message: 'Compute could not apply what the environment declares (a repository, package or build).' },
  provider_failed: { title: 'The Computer couldn’t be provisioned.', message: 'The target accepted the Computer but could not provision or resume it.' },
  runtime_failed: { title: 'A declared process couldn’t start.', message: 'The environment runs, but a process it declares could not start or resolve its runtime.' },
  bootstrap_cancelled: { title: 'Configuration was interrupted.', message: 'The environment was stopped or destroyed before configuration finished. Starting it applies the rest.' },
  destruction_failed: { title: 'The Computer couldn’t be removed.', message: 'Compute could not remove the Computer. Destroy it again.' }
}

const text = (value: unknown): string | undefined => value === undefined || value === null ? undefined : typeof value === 'string' ? value : JSON.stringify(value)

/** Placement's reasons (`runtime_unavailable`, `isolation_unsupported` …), as Compute reported them. */
export function unsatisfiedOf(reasons: ComputeIncompatibility[] | undefined): NonNullable<EnvironmentReason['unsatisfied']> {
  return (reasons ?? []).map(reason => ({ code: reason.code, ...(text(reason.required) ? { required: text(reason.required)! } : {}), ...(text(reason.available) ? { available: text(reason.available)! } : {}), ...(reason.detail ? { detail: reason.detail } : {}) }))
}

function stateOf(record: ComputeEnvironmentRecord): EnvironmentState {
  const computer = record.computer
  if (!computer) return 'unknown'   // an environment without a Computer is not one this surface was built for
  const observed = computer.reality?.observed
  if (observed === 'destroyed' || observed === 'expired' || computer.status === 'destroyed' || computer.status === 'expired') return 'destroyed'
  if (computer.status === 'destroying') return 'destroying'
  if (observed === 'stopping' || computer.status === 'stopping') return 'stopping'
  if (observed === 'stopped' || computer.status === 'stopped') return 'stopped'
  switch (computer.readiness?.state) {
    case 'ready': return 'ready'
    case 'degraded': return 'degraded'
    case 'failed': return 'failed'
    case 'unavailable': return 'not-ready'
    case 'created': return 'creating'
    case 'starting': return computer.bootstrap?.state === 'running' ? 'configuring' : 'creating'
    default: return 'unknown'
  }
}

function reasonOf(record: ComputeEnvironmentRecord, state: EnvironmentState): EnvironmentReason | undefined {
  const computer = record.computer
  if (!computer) return { title: 'Not a Compute Computer environment.', message: 'Compute reports this environment without a Computer, so it cannot be used as a development environment.', category: 'unsupported' }
  const readiness = computer.readiness
  const failure = readiness.class ?? computer.bootstrap.failure?.class
  const retryable = computer.bootstrap.failure?.retryable ?? computer.failure?.retryable
  const computeSays = [readiness.explanation, computer.bootstrap.failure?.message, computer.failure?.message].filter((part, index, all) => part && all.indexOf(part) === index).join(' — ')
  if (failure && CLASS_TEXT[failure] && ['failed', 'not-ready', 'degraded', 'stopped', 'creating', 'configuring'].includes(state)) {
    const named = computer.bootstrap.failure ? `${computer.bootstrap.failure.operation}: ${computer.bootstrap.failure.message}` : undefined
    return { category: failure, title: CLASS_TEXT[failure].title, message: [CLASS_TEXT[failure].message, named].filter(Boolean).join(' '), ...(readiness.unsatisfied?.length ? { unsatisfied: unsatisfiedOf(readiness.unsatisfied) } : {}),
      ...(computeSays ? { computeSays } : {}), ...(retryable !== undefined ? { retryable } : {}) }
  }
  if (computer.failure && ['creating', 'configuring', 'failed', 'not-ready', 'degraded'].includes(state)) {
    // Compute recorded a failure against a phase that its readiness has not turned into a class (for example placement while still `starting`). Shown as Compute wrote it.
    return { category: `${computer.failure.phase}/${computer.failure.code}`, title: 'Compute reports a problem with this environment.', message: computer.failure.message,
      ...(readiness.unsatisfied?.length ? { unsatisfied: unsatisfiedOf(readiness.unsatisfied) } : {}), ...(computeSays ? { computeSays } : {}), ...(computer.failure.retryable !== undefined ? { retryable: computer.failure.retryable } : {}) }
  }
  if (state === 'not-ready') {
    return { category: computer.reality.observed, title: 'Not ready.', message: readiness.explanation || computer.reality.explanation || 'Compute reports this environment cannot run workloads.',
      ...(readiness.unsatisfied?.length ? { unsatisfied: unsatisfiedOf(readiness.unsatisfied) } : {}) }
  }
  if (state === 'stopped' || state === 'destroyed') return { category: computer.reality.observed, title: state === 'stopped' ? 'Stopped.' : 'Destroyed.', message: readiness.explanation || computer.reality.explanation }
  if (state === 'unknown') return { category: 'unrecognised', title: 'Foundry does not recognise this state.', message: `Compute reported readiness "${String(readiness?.state)}" and lifecycle "${String(computer.reality?.observed)}". It is not treated as ready.` }
  return undefined
}

function progressOf(record: ComputeEnvironmentRecord): EnvironmentProgressStep[] {
  const computer = record.computer
  if (!computer) return []
  const steps: EnvironmentProgressStep[] = []
  if (record.recipe) steps.push({ id: 'recipe', label: 'Recipe resolved', status: 'done' })
  const machine = computer.status
  steps.push({ id: 'computer', label: 'Computer created',
    status: machine === 'pending' || machine === 'provisioning' || machine === 'resuming' ? 'active' : machine === 'failed' ? 'failed' : 'done' })
  const bootstrap = computer.bootstrap.state
  steps.push({ id: 'configuration', label: 'Configuring environment', status: bootstrap === 'succeeded' ? 'done' : bootstrap === 'running' ? 'active' : bootstrap === 'failed' ? 'failed' : 'pending' })
  const readiness = computer.readiness.state
  const machineAndConfigured = steps[steps.length - 2]!.status === 'done' && bootstrap === 'succeeded'
  steps.push({ id: 'readiness', label: 'Checking readiness',
    status: readiness === 'ready' || readiness === 'degraded' ? 'done' : readiness === 'failed' || readiness === 'unavailable' ? 'failed' : machineAndConfigured ? 'active' : 'pending' })
  steps.push({ id: 'ready', label: 'Ready', status: readiness === 'ready' || readiness === 'degraded' ? 'done' : readiness === 'failed' || readiness === 'unavailable' ? 'failed' : 'pending' })
  return steps
}

function actionsOf(state: EnvironmentState, retryable: boolean): EnvironmentAction[] {
  const retry: EnvironmentAction[] = retryable ? ['retry'] : []
  switch (state) {
    case 'ready': return ['open', 'restart', 'stop', 'destroy']
    case 'degraded': return ['open', 'restart', 'stop', ...retry, 'destroy']
    case 'stopped': return ['start', 'destroy']
    case 'creating': case 'configuring': return [...retry, 'destroy']
    case 'failed': case 'not-ready': return [...retry, 'destroy']
    case 'unknown': return ['destroy']
    case 'destroyed': case 'missing': case 'none': return ['create']
    case 'stopping': case 'destroying': case 'compute-unavailable': return []
  }
}

/** What the Environment surface shows for one Compute environment record. */
export function present(record: ComputeEnvironmentRecord): Pick<DevelopmentEnvironmentView, 'state' | 'reason' | 'recipe' | 'computer' | 'readiness' | 'configuration' | 'lifecycle' | 'workloads' | 'progress' | 'actions'> {
  const state = stateOf(record)
  const computer = record.computer
  const reason = reasonOf(record, state)
  const retryable = Boolean(computer && (computer.bootstrap?.failure?.retryable || computer.failure?.retryable) && ['creating', 'configuring', 'failed', 'not-ready', 'degraded'].includes(state))
  const platform = computer?.readiness?.configuration?.platform
  const processes = Object.values(computer?.reality?.processes ?? {}).filter(item => ['running', 'ready', 'starting', 'unready'].includes(item.process)).length
  return {
    state, ...(reason ? { reason } : {}),
    ...(record.recipe ? { recipe: { name: record.recipe.name, version: record.recipe.version, digest: record.recipe.digest } } : {}),
    ...(computer ? { computer: { ...(computer.target ? { target: computer.target } : {}), ...(platform ? { platform, platformLabel: platformName(platform) } : {}), lifecycle: computer.lifecycle, status: computer.status } } : {}),
    ...(computer ? { readiness: computer.readiness.state, configuration: computer.bootstrap.state, lifecycle: computer.reality.observed, workloads: processes } : {}),
    progress: progressOf(record), actions: actionsOf(state, retryable)
  }
}

/** The optional inspection surface: the same record, arranged for reading. */
export function presentDetail(record: ComputeEnvironmentRecord): NonNullable<DevelopmentEnvironmentDetail['detail']> {
  const computer = record.computer
  const transitions = [computer?.reality.since && { at: computer.reality.since, what: `Computer ${computer.reality.observed}` }, computer?.ended_at && { at: computer.ended_at, what: 'Computer ended' },
    computer?.bootstrap.completed_at && { at: computer.bootstrap.completed_at, what: 'Configuration completed' }, computer?.ready_at && { at: computer.ready_at, what: 'Machine running' }].filter(Boolean) as { at: string; what: string }[]
  const last = transitions.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
  return {
    environmentId: record.environment_id, ...(record.created_at ? { createdAt: record.created_at } : {}), ...(last ? { lastTransition: last } : {}),
    ...(computer?.readiness.explanation ? { readinessExplanation: computer.readiness.explanation } : {}),
    conditions: computer?.readiness.conditions ?? [],
    steps: (computer?.bootstrap.steps ?? []).map(step => ({ kind: step.kind, name: step.name, outcome: step.outcome, ...(step.error ? { error: step.error } : {}) })),
    requirements: (computer?.requirements ?? {}) as Record<string, unknown>,
    ...(computer?.machine ? { machine: computer.machine } : {}),
    processes: Object.entries(computer?.reality.processes ?? {}).map(([name, item]) => ({ name, desired: item.desired, state: item.process })),
    ...(computer?.placement_id ? { placementId: computer.placement_id } : {}),
    ...(computer?.generation !== undefined ? { generation: computer.generation } : {})
  }
}

/** Compute's recipe resolution, reduced to what a person decides on: what was asked (requirements), where it would run (placement), and whether it can. */
export function presentResolution(resolution: ComputeRecipeResolution): RecipeResolutionView {
  const computer = resolution.resolved?.computer
  const requirements = computer?.requirements
  const providers = resolution.placement?.providers ?? []
  const selected = providers.find(item => item.candidate?.selected)?.provider_id
  return {
    ...(resolution.recipe ? { recipe: resolution.recipe } : {}), verdict: resolution.verdict, problems: resolution.problems ?? [],
    ...(computer && requirements ? { requirements: { lifecycle: computer.lifecycle, ...(computer.ttl_seconds ? { ttlSeconds: computer.ttl_seconds } : {}),
      ...(requirements.cpu_count !== undefined ? { cpu: requirements.cpu_count } : {}), ...(requirements.memory_bytes !== undefined ? { memoryBytes: requirements.memory_bytes } : {}), ...(requirements.disk_bytes !== undefined ? { diskBytes: requirements.disk_bytes } : {}),
      ...(requirements.architecture ? { architecture: requirements.architecture } : {}), ...(requirements.network ? { network: requirements.network } : {}), ...(requirements.isolation ? { isolation: requirements.isolation } : {}),
      capabilities: requirements.capabilities ?? [], features: requirements.features ?? [], runtimes: (requirements.runtimes ?? []).map(item => text(item) ?? '') } } : {}),
    ...(resolution.placement ? { placement: { ...(selected ? { selected } : {}), ...(resolution.placement.explanation?.selection ? { explanation: resolution.placement.explanation.selection } : {}),
      targets: providers.map(item => ({ id: item.provider_id, eligible: item.candidate?.eligible === true, selected: item.candidate?.selected === true, reasons: unsatisfiedOf(item.reasons) })),
      ...(resolution.placement.failure ? { failure: resolution.placement.failure.message } : {}) } } : {}),
    lifecycle: resolution.lifecycle ?? [], impliedCapabilities: resolution.implied_capabilities ?? []
  }
}
