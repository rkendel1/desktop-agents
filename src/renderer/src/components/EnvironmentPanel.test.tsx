// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DevelopmentEnvironmentDetail, DevelopmentEnvironmentView, Project, RecipeResolutionView } from '../../../shared/types'
import { EnvironmentPanel } from './EnvironmentPanel'

vi.mock('../preferences', () => ({ t: (text: string) => text, tr: (text: string, values: Record<string, unknown> = {}) => text.replace(/\{(\w+)\}/g, (_all, key) => String(values[key])) }))

const project: Project = { id: 'p1', name: 'Fixture', path: '/work/fixture', isGit: true, createdAt: 1, updatedAt: 1 }
const view = (patch: Partial<DevelopmentEnvironmentView> = {}): DevelopmentEnvironmentView => ({ projectId: 'p1', compute: { ok: true, installed: { binary: '/x/compute', version: '0.1.5' } },
  reference: { projectId: 'p1', environment: 'foundry-fixture-abc123', environmentId: 'env_1', requestedRecipe: { name: 'developer', version: 3 }, createdAt: 1 }, state: 'ready',
  recipe: { name: 'developer', version: 3, digest: 'sha256:' + 'a'.repeat(64) }, computer: { target: 'this-machine', platform: 'linux/x86_64', platformLabel: 'Linux x86_64', lifecycle: 'persistent', status: 'running' },
  readiness: 'ready', configuration: 'succeeded', lifecycle: 'running', workloads: 1, progress: [], actions: ['open', 'restart', 'stop', 'destroy'], observedAt: 1, ...patch })
const satisfiable: RecipeResolutionView = { recipe: { name: 'developer', version: 3, digest: 'sha256:x' }, verdict: 'satisfiable', problems: [], lifecycle: [], impliedCapabilities: ['claim'],
  requirements: { lifecycle: 'persistent', cpu: 2, memoryBytes: 4 * 2 ** 30, network: 'network', isolation: 'process', capabilities: ['terminal'], features: [], runtimes: [] },
  placement: { selected: 'this-machine', targets: [{ id: 'local', eligible: false, selected: false, reasons: [{ code: 'sessions_unsupported' }] }, { id: 'this-machine', eligible: true, selected: true, reasons: [] }] } }

let api: Record<string, ReturnType<typeof vi.fn>>
let node: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  api = { environmentState: vi.fn(async () => view()), environmentDetail: vi.fn(), environmentRecipes: vi.fn(async () => [{ name: 'developer', version: 3, digest: 'sha256:x', lifecycle: 'persistent', description: 'A dev computer' }]),
    environmentCreateRecipe: vi.fn(async () => [{ name: 'developer', version: 1, digest: 'sha256:dev', lifecycle: 'persistent' }]),
    environmentSetupDeveloper: vi.fn(async () => ({ projectId: 'p1', steps: [
      { id: 'compute', label: 'Compute available', status: 'done' }, { id: 'recipe', label: 'Developer recipe created', status: 'done' },
      { id: 'validation', label: 'Developer recipe validated', status: 'done' }, { id: 'environment', label: 'Development environment created', status: 'done' }, { id: 'computer', label: 'Computer ready', status: 'done' }
    ], view: view() })), onEnvironmentSetupProgress: vi.fn(() => () => undefined), openComputeUi: vi.fn(async () => undefined),
    environmentResolve: vi.fn(async () => satisfiable), environmentCreate: vi.fn(async () => view({ state: 'creating', readiness: 'created', configuration: 'not_started', actions: ['destroy'] })), environmentAct: vi.fn() }
  ;(window as unknown as { douchat: unknown }).douchat = api
  node = document.createElement('div'); document.body.append(node); root = createRoot(node)
})
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.useRealTimers() })
const render = (work?: { label: string; value: string }[]) => act(async () => root.render(<EnvironmentPanel project={project} work={work} />))
const click = (label: string | RegExp) => act(async () => {
  const button = [...node.querySelectorAll('button')].find(item => typeof label === 'string' ? item.textContent === label : label.test(item.textContent ?? ''))
  if (!button) throw new Error(`No button ${label}`)
  button.click()
})
const text = (): string => node.textContent ?? ''

it('shows a ready environment as Compute reports it: recipe with version, Computer, configuration, readiness, and the controls that state allows', async () => {
  await render([{ label: 'Agent', value: 'Running' }, { label: 'Checks', value: '—' }])
  expect(node.querySelector('[role=status]')!.textContent).toBe('Ready')
  const facts = node.querySelector('.env-facts')!.textContent!
  expect(facts).toContain('developer · v3'); expect(facts).toContain('this-machine · Linux x86_64'); expect(facts).toContain('Configured'); expect(facts).toContain('Ready')
  expect(node.querySelector('.env-facts span')!.getAttribute('title')).toBe('sha256:' + 'a'.repeat(64))   // the digest is Compute’s
  expect([...node.querySelectorAll('.coding-actions button')].map(button => button.textContent)).toEqual(['Open', 'Restart', 'Stop', 'Destroy'])
  expect(node.querySelector('[aria-label=Work]')!.textContent).toContain('AgentRunning')
})

it('a Computer that exists is not a ready environment: Configuring shows progress and no Open, Restart or Stop', async () => {
  api.environmentState.mockResolvedValue(view({ state: 'configuring', readiness: 'starting', configuration: 'running', actions: ['destroy'],
    progress: [{ id: 'recipe', label: 'Recipe resolved', status: 'done' }, { id: 'computer', label: 'Computer created', status: 'done' }, { id: 'configuration', label: 'Configuring environment', status: 'active' }, { id: 'readiness', label: 'Checking readiness', status: 'pending' }, { id: 'ready', label: 'Ready', status: 'pending' }] }))
  await render()
  expect(node.querySelector('[role=status]')!.textContent).toBe('Configuring')
  expect(text()).not.toContain('Ready ·')
  expect([...node.querySelectorAll('.env-progress li')].map(item => item.textContent)).toEqual(['✓ Recipe resolved', '✓ Computer created', '● Configuring environment', '○ Checking readiness', '○ Ready'])
  expect([...node.querySelectorAll('.coding-actions button')].map(button => button.textContent)).toEqual(['Destroy'])
})

it('asks Compute again while it is changing something, and stops being Configuring only when Compute says so', async () => {
  api.environmentState.mockResolvedValueOnce(view({ state: 'configuring', readiness: 'starting', actions: ['destroy'] })).mockResolvedValue(view())
  await render()
  expect(node.querySelector('[role=status]')!.textContent).toBe('Configuring')
  await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
  expect(node.querySelector('[role=status]')!.textContent).toBe('Ready')
})

it('keeps Compute’s error category with a human sentence, and lists what the target cannot satisfy', async () => {
  api.environmentState.mockResolvedValue(view({ state: 'not-ready', readiness: 'unavailable', actions: ['destroy'], reason: { category: 'requirements_unsatisfied', title: 'Environment couldn’t become ready.',
    message: 'The selected Computer cannot satisfy what this environment requires.', unsatisfied: [{ code: 'runtime_unavailable', required: 'node 22' }], computeSays: 'this-machine no longer satisfies its requirements' } }))
  await render()
  const alert = node.querySelector('[role=alert]')!.textContent!
  expect(alert).toContain('Environment couldn’t become ready.'); expect(alert).toContain('The selected Computer cannot satisfy'); expect(alert).toContain('runtime_unavailable'); expect(alert).toContain('node 22')
  expect(alert).toContain('requirements_unsatisfied')   // in the diagnostics, retained
})

it('offers Start for a stopped environment and Retry for a failed one', async () => {
  api.environmentState.mockResolvedValue(view({ state: 'stopped', readiness: 'unavailable', lifecycle: 'stopped', actions: ['start', 'destroy'] }))
  await render()
  expect([...node.querySelectorAll('.coding-actions button')].map(button => button.textContent)).toEqual(['Start', 'Destroy'])
  api.environmentState.mockResolvedValue(view({ state: 'failed', readiness: 'failed', configuration: 'failed', actions: ['retry', 'destroy'], reason: { category: 'configuration_failed', title: 'Environment configuration failed.', message: 'Compute could not apply what the environment declares.' } }))
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  expect([...node.querySelectorAll('.coding-actions button')].map(button => button.textContent)).toEqual(['Retry', 'Destroy'])
})

it('shows what Compute answers to an action, not what was requested: Stop leaves it Stopping until Compute says Stopped', async () => {
  api.environmentAct.mockResolvedValue(view({ state: 'stopping', lifecycle: 'stopping', readiness: 'unavailable', actions: [] }))
  await render()
  await click('Stop')
  expect(api.environmentAct).toHaveBeenCalledWith('p1', 'stop')
  expect(node.querySelector('[role=status]')!.textContent).toBe('Stopping')
  expect(node.querySelectorAll('.coding-actions button')).toHaveLength(0)
})

it('destroy goes to the control plane, which asks the owner to confirm; a declined confirmation leaves the environment as it was', async () => {
  api.environmentAct.mockResolvedValue(view())   // the main process returns the unchanged view when the owner declines
  await render()
  await click('Destroy')
  expect(api.environmentAct).toHaveBeenCalledWith('p1', 'destroy')
  expect(node.querySelector('[role=status]')!.textContent).toBe('Ready')
})

it('does not silently replace a lost environment: it says so and waits for the person to create one', async () => {
  api.environmentState.mockResolvedValue(view({ state: 'missing', actions: ['create'], recipe: undefined, computer: undefined, readiness: undefined, configuration: undefined,
    reason: { category: 'environment_missing', title: 'Environment unavailable', message: 'The Compute environment associated with this project no longer exists.' } }))
  await render()
  expect(node.querySelector('[role=status]')!.textContent).toBe('Unavailable')
  expect(text()).toContain('The Compute environment associated with this project no longer exists.')
  expect(api.environmentCreate).not.toHaveBeenCalled()
  expect(api.environmentRecipes).not.toHaveBeenCalled()
  expect([...node.querySelectorAll('.coding-actions button')].map(button => button.textContent)).toEqual(['Create Developer Environment'])
})

it('creates an environment from a recipe Compute resolved: Recipe, Computer, Environment and Readiness explained, requirements and placement shown, Create enabled only when satisfiable', async () => {
  api.environmentState.mockResolvedValue(view({ state: 'none', reference: undefined, recipe: undefined, computer: undefined, readiness: undefined, configuration: undefined, lifecycle: undefined, actions: ['create'] }))
  await render()
  await click('Choose another recipe…')
  const create = node.querySelector('.env-create')!.textContent!
  expect(create).toContain('What you asked Compute to provide.'); expect(create).toContain('Where Compute will provide it.'); expect(create).toContain('The configured execution context.'); expect(create).toContain('Whether reality actually satisfies the request.')
  expect(api.environmentResolve).toHaveBeenCalledWith('developer')
  expect(create).toContain('satisfiable'); expect(create).toContain('Persistent'); expect(create).toContain('4 GiB'); expect(create).toContain('would run on'); expect(create).toContain('this-machine')
  expect(create).not.toContain('"lifecycle"')   // no raw recipe JSON
  await click('Create environment')
  expect(api.environmentCreate).toHaveBeenCalledWith({ projectId: 'p1', recipe: 'developer', version: 3 })
  expect(node.querySelector('[role=status]')!.textContent).toBe('Creating')
})

it('sets up the Developer recipe and environment in one click without showing shell instructions', async () => {
  api.environmentState.mockResolvedValue(view({ state: 'none', reference: undefined, recipe: undefined, computer: undefined, readiness: undefined, configuration: undefined, lifecycle: undefined, actions: ['create'] }))
  await render()
  await click('Create Developer Environment')
  expect(api.environmentSetupDeveloper).toHaveBeenCalledWith('p1')
  expect(text()).toContain('Developer recipe created')
  expect(text()).toContain('Developer recipe validated')
  expect(text()).toContain('Computer ready')
  expect(text()).not.toContain('compute recipe create')
  expect(node.querySelector('[role=status]')!.textContent).toBe('Ready')
})

it('does not offer to create from a recipe Compute says cannot be satisfied here, and shows why per target', async () => {
  api.environmentState.mockResolvedValue(view({ state: 'none', reference: undefined, actions: ['create'] }))
  api.environmentResolve.mockResolvedValue({ ...satisfiable, verdict: 'unsatisfied', placement: { targets: [{ id: 'this-machine', eligible: false, selected: false, reasons: [{ code: 'session_capability_unsupported', required: '["terminal"]' }] }], failure: 'no provider' } })
  await render()
  await click('Choose another recipe…')
  const create = node.querySelector('.env-create')!.textContent!
  expect(create).toContain('cannot be satisfied here'); expect(create).toContain('session_capability_unsupported'); expect(create).toContain('Choose another recipe')
  expect([...node.querySelectorAll('button')].find(button => button.textContent === 'Create environment')!.disabled).toBe(true)
})

it('says Compute needs updating when the installed Compute predates the contract, and offers nothing else', async () => {
  api.environmentState.mockResolvedValue({ projectId: 'p1', compute: { ok: false, reason: 'upgrade-required', message: 'x', installed: { binary: '/x', version: '0.1.5' } }, state: 'compute-unavailable', progress: [], actions: [], observedAt: 1,
    reason: { category: 'upgrade-required', title: 'Compute update required.', message: 'Compute update required. This version of Foundry requires Compute with Environment Recipes, Bootstrap, Readiness and lifecycle support. Installed: Compute Configured 0.1.5.' } })
  await render()
  expect(node.querySelector('[role=status]')!.textContent).toBe('Compute unavailable')
  expect(node.querySelector('[role=alert]')!.textContent).toContain('Installed: Compute Configured 0.1.5.')
  expect(node.querySelectorAll('.coding-actions button')).toHaveLength(0)
})

it('opens an inspection detail read from Compute: recipe version and digest, configuration, readiness, lifecycle, workloads, last transition', async () => {
  const detail: DevelopmentEnvironmentDetail = { ...view(), detail: { environmentId: 'env_1', createdAt: '2026-09-30T11:00:00Z', lastTransition: { at: '2026-09-30T11:05:00Z', what: 'Configuration completed' }, readinessExplanation: 'foundry-fixture-abc123 is ready: verified against this-machine.',
    conditions: [{ name: 'machine', satisfied: true, detail: 'running on this-machine' }], steps: [], requirements: { network: 'network' }, processes: [], generation: 4 },
    computer: { target: 'this-machine', platformLabel: 'Linux x86_64', lifecycle: 'persistent', status: 'running', certification: { platform: 'linux-x86_64', status: 'certified', label: 'Linux x86_64 — Certified', evidence: 'compute-configured-verify' } } }
  api.environmentDetail.mockResolvedValue(detail)
  await render()
  await click('Open')
  const facts = node.querySelector('.env-detail')!.textContent!
  expect(api.environmentDetail).toHaveBeenCalledWith('p1')
  expect(facts).toContain('developer · v3'); expect(facts).toContain('sha256:aaaaaaaaaaaa'); expect(facts).toContain('Certified'); expect(facts).toContain('Configured'); expect(facts).toContain('Running · persistent'); expect(facts).toContain('Configuration completed')
  expect(node.querySelector('.env-advanced')).not.toBeNull()
})
