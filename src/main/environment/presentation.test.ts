import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ComputeEnvironmentRecord, ComputeFailureClass, ComputeReadinessState } from '../compute/client'
import { present, presentDetail, presentResolution } from './presentation'

/** Compute main’s own `environment inspect` output for a ready environment, recorded (see fixtures/compute-main/README.md). */
const recorded = (name: string): any => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'compute-main', name), 'utf8'))
const record = (patch: { status?: string; observed?: string; readiness?: string; bootstrap?: string; class?: string; failure?: object; bootstrapFailure?: object } = {}): ComputeEnvironmentRecord => {
  const value = recorded('environment-ready.json')
  const computer = value.computer
  if (patch.status) computer.status = patch.status
  if (patch.observed) computer.reality.observed = patch.observed
  if (patch.readiness) computer.readiness.state = patch.readiness
  if (patch.bootstrap) computer.bootstrap.state = patch.bootstrap
  if (patch.class) computer.readiness.class = patch.class
  if (patch.failure) computer.failure = patch.failure
  if (patch.bootstrapFailure) computer.bootstrap.failure = patch.bootstrapFailure
  return value
}

const STATUSES = ['pending', 'provisioning', 'running', 'stopping', 'stopped', 'resuming', 'failed', 'destroying', 'destroyed', 'expired', 'unreachable', 'lost']
const OBSERVED = ['starting', 'running', 'unverified', 'reconciling', 'unreachable', 'lost', 'stopping', 'stopped', 'failed', 'destroyed', 'expired']
const READINESS = ['created', 'starting', 'ready', 'degraded', 'unavailable', 'failed', 'flourishing']
const BOOTSTRAP = ['not_started', 'running', 'succeeded', 'failed']
const ENDED = ['stopped', 'stopping', 'destroying', 'destroyed', 'expired']

describe('the state shown is a translation of Compute’s words, never an inference', () => {
  const all: { patch: { status: string; observed: string; readiness: string; bootstrap: string }; shown: ReturnType<typeof present> }[] = []
  for (const status of STATUSES) for (const observed of OBSERVED) for (const readiness of READINESS) for (const bootstrap of BOOTSTRAP) {
    const patch = { status: status!, observed: observed!, readiness: readiness!, bootstrap: bootstrap! }
    all.push({ patch, shown: present(record(patch)) })
  }

  it('covers every combination Compute can report (and some it cannot)', () => { expect(all).toHaveLength(STATUSES.length * OBSERVED.length * READINESS.length * BOOTSTRAP.length) })

  it('shows Ready only when Compute’s readiness is ready — a Computer that exists, or is running, is not enough', () => {
    for (const { patch, shown } of all) {
      if (shown.state === 'ready') expect(patch.readiness, JSON.stringify(patch)).toBe('ready')
      if (patch.readiness !== 'ready') expect(shown.state, JSON.stringify(patch)).not.toBe('ready')
      // a running machine with anything but verified readiness is never Ready
      if (patch.status === 'running' && patch.readiness !== 'ready') expect(shown.state, JSON.stringify(patch)).not.toBe('ready')
    }
  })

  it('never shows Ready or Degraded, or offers Open/Restart/Stop, for a Computer that Compute reports stopped, stopping or gone', () => {
    for (const { patch, shown } of all) {
      const ended = ENDED.includes(patch.status) || ENDED.includes(patch.observed)
      if (ended) { expect(['ready', 'degraded'], JSON.stringify(patch)).not.toContain(shown.state); expect(shown.actions).not.toEqual(expect.arrayContaining(['open'])) }
      if (shown.actions.some(action => ['open', 'restart', 'stop'].includes(action))) expect(['ready', 'degraded'], JSON.stringify(patch)).toContain(shown.state)
    }
  })

  it('shows a readiness value it does not know as Unknown (which admits nothing), unless the Computer has ended', () => {
    for (const { patch, shown } of all.filter(item => item.patch.readiness === 'flourishing' && !ENDED.includes(item.patch.status) && !ENDED.includes(item.patch.observed))) expect(shown.state, JSON.stringify(patch)).toBe('unknown')
  })

  it('maps Compute’s readiness one for one when the Computer has not ended', () => {
    const expected: Record<string, string> = { ready: 'ready', degraded: 'degraded', failed: 'failed', unavailable: 'not-ready', created: 'creating' }
    for (const { patch, shown } of all.filter(item => !ENDED.includes(item.patch.status) && !ENDED.includes(item.patch.observed) && expected[item.patch.readiness])) expect(shown.state, JSON.stringify(patch)).toBe(expected[patch.readiness])
    for (const { patch, shown } of all.filter(item => !ENDED.includes(item.patch.status) && !ENDED.includes(item.patch.observed) && item.patch.readiness === 'starting')) expect(shown.state, JSON.stringify(patch)).toBe(patch.bootstrap === 'running' ? 'configuring' : 'creating')
  })

  it('shows the lifecycle Compute reports for an ended Computer', () => {
    expect(present(record({ status: 'stopped', observed: 'stopped', readiness: 'unavailable' })).state).toBe('stopped')
    expect(present(record({ status: 'stopping', observed: 'stopping', readiness: 'unavailable' })).state).toBe('stopping')
    expect(present(record({ status: 'destroying', observed: 'reconciling', readiness: 'unavailable' })).state).toBe('destroying')
    expect(present(record({ status: 'destroyed', observed: 'destroyed', readiness: 'unavailable' })).state).toBe('destroyed')
    expect(present(record({ status: 'expired', observed: 'expired', readiness: 'unavailable' })).state).toBe('destroyed')
  })
})

describe('Compute’s error categories keep their meaning', () => {
  const classes: Record<ComputeFailureClass, string> = {
    requirements_unsatisfied: 'Environment couldn’t become ready.', configuration_failed: 'Environment configuration failed.', provider_failed: 'The Computer couldn’t be provisioned.',
    runtime_failed: 'A declared process couldn’t start.', bootstrap_cancelled: 'Configuration was interrupted.', destruction_failed: 'The Computer couldn’t be removed.' }
  for (const [category, title] of Object.entries(classes)) {
    it(`${category}: a human sentence on top, the category kept underneath`, () => {
      const readiness: Record<string, ComputeReadinessState> = { requirements_unsatisfied: 'unavailable', configuration_failed: 'failed', provider_failed: 'failed', runtime_failed: 'degraded', bootstrap_cancelled: 'unavailable', destruction_failed: 'unavailable' }
      const shown = present(record({ readiness: readiness[category], class: category, status: 'running', observed: 'running' }))
      expect(shown.reason).toMatchObject({ category, title })
      expect(shown.reason?.title).not.toMatch(/something went wrong/i)
      expect(shown.reason?.message.length).toBeGreaterThan(20)
    })
  }

  it('lists what placement says the target cannot satisfy, with required and available as Compute wrote them', () => {
    const value = record({ readiness: 'unavailable', class: 'requirements_unsatisfied', status: 'running', observed: 'running' })
    value.computer!.readiness.unsatisfied = [{ code: 'runtime_unavailable', required: { kind: 'node', version: '22' }, available: ['node 20'], detail: 'no node 22' }]
    expect(present(value).reason?.unsatisfied).toEqual([{ code: 'runtime_unavailable', required: '{"kind":"node","version":"22"}', available: '["node 20"]', detail: 'no node 22' }])
  })

  it('offers Retry only when Compute says the failure is retryable', () => {
    const failed = (retryable: boolean) => present(record({ readiness: 'failed', class: 'configuration_failed', bootstrap: 'failed', status: 'running', observed: 'running',
      bootstrapFailure: { class: 'configuration_failed', operation: 'build', message: 'exit 2', retryable } }))
    expect(failed(true).actions).toEqual(['retry', 'destroy'])
    expect(failed(false).actions).toEqual(['destroy'])
  })
})

describe('provenance and the Computer come from Compute', () => {
  it('shows the recipe name, version and digest Compute recorded, and nothing when Compute recorded none', () => {
    const shown = present(record())
    expect(shown.recipe).toEqual({ name: 'basic', version: 1, digest: expect.stringMatching(/^sha256:/) })
    const bare = record(); delete bare.recipe
    expect(present(bare).recipe).toBeUndefined()
  })

  it('names the platform as Compute reports it, in either spelling', () => {
    expect(present(record()).computer).toMatchObject({ platform: 'linux/x86_64', platformLabel: 'Linux x86_64' })
    const mac = record(); mac.computer!.readiness.configuration!.platform = 'macos-aarch64'
    expect(present(mac).computer?.platformLabel).toBe('macOS ARM64')
    const odd = record(); odd.computer!.readiness.configuration!.platform = 'plan9/mips'
    expect(present(odd).computer?.platformLabel).toBe('plan9/mips')
  })

  it('counts the workloads Compute reports running', () => {
    const value = record(); value.computer!.reality.processes = { agent: { desired: 'running', process: 'running' }, build: { desired: 'stopped', process: 'exited' } }
    expect(present(value).workloads).toBe(1)
  })

  it('arranges the inspect output for the detail view without adding to it', () => {
    const detail = presentDetail(record())
    expect(detail.environmentId).toMatch(/^env_/)
    expect(detail.conditions.map(condition => condition.name)).toEqual(['machine', 'requirements', 'bootstrap', 'contents', 'processes'])
    expect(detail.lastTransition).toBeDefined()
  })

  it('treats an environment without a Computer as unsupported, not as anything usable', () => {
    const value = record(); delete value.computer
    expect(present(value)).toMatchObject({ state: 'unknown', actions: ['destroy'], reason: { category: 'unsupported' } })
  })
})

describe('recipe resolution is Compute’s, reduced for reading', () => {
  it('reports satisfiable with the selected target and every target’s eligibility', () => {
    const shown = presentResolution(recorded('resolve-satisfiable.json'))
    expect(shown).toMatchObject({ verdict: 'satisfiable', recipe: { name: 'basic', version: 1 }, impliedCapabilities: ['claim'], placement: { selected: 'this-machine' } })
    expect(shown.placement!.targets).toEqual([expect.objectContaining({ id: 'local', eligible: false }), expect.objectContaining({ id: 'this-machine', eligible: true, selected: true })])
    expect(shown.requirements).toMatchObject({ lifecycle: 'persistent', network: 'network', isolation: 'process' })
  })

  it('reports unsatisfied with placement’s reason for each target', () => {
    const shown = presentResolution(recorded('resolve-unsatisfied.json'))
    expect(shown.verdict).toBe('unsatisfied')
    expect(shown.placement!.targets.find(target => target.id === 'this-machine')!.reasons).toEqual([expect.objectContaining({ code: 'session_capability_unsupported', required: '["terminal"]' })])
    expect(shown.placement!.selected).toBeUndefined()
    expect(shown.placement!.failure).toContain('no provider proved')
  })
})
