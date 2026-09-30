// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CiPlan, CiRun, Project } from '../../../shared/types'
import { CiPanel } from './CiPanel'

vi.mock('../preferences', () => ({ t: (text: string) => text, tr: (text: string, values: Record<string, unknown> = {}) => text.replace(/\{(\w+)\}/g, (_all, key) => String(values[key])) }))

const project: Project = { id: 'p1', name: 'my-app', path: '/work/my-app', isGit: true, createdAt: 1, updatedAt: 1 }
const linux = { platform: 'linux-x86_64', status: 'certified' as const, label: 'Linux x86_64 — Certified', evidence: 'compute-configured-verify' }
const mac = { platform: 'macos-aarch64', status: 'preview' as const, label: 'macOS ARM64 — Preview', evidence: 'compute-configured-verify' }
const planned = (operation: string) => ({ operation, supported: true, tool: 'npm', command: ['npm', 'run', operation] })
const plan = (patch: Partial<CiPlan> = {}): CiPlan => ({ projectId: 'p1', projectName: 'my-app', ready: true, blockers: [], platform: linux, computer: { lifecycle: 'ephemeral' },
  source: { repository: 'file:///work/my-app', revision: 'abc123abc123abc123', branch: 'main', workspaceSource: 'committed-revision' },
  plan: { operations: [planned('install'), planned('typecheck'), planned('lint'), planned('test'), { operation: 'build', supported: false, reason: "package.json has no 'build' script" }], ambiguous: false, drift: false }, ...patch })
const operation = (name: string, status: 'passed' | 'failed', exitCode: number, stdout = '') => ({ operation: name, kind: 'check' as const, tool: 'npm', command: ['npm', 'run', name], status, exitCode, startedAt: 1, durationMs: 1200, stdout, stderr: '', truncated: false })
const run = (patch: Partial<CiRun> = {}): CiRun => ({ id: 'r1', projectId: 'p1', number: 42, status: 'passed', phase: 'done', createdAt: 1, source: { repository: 'file:///work/my-app', revision: 'abc123abc123abc123', branch: 'main', workspaceSource: 'committed-revision' },
  platform: linux, computer: { environment: 'foundry-ci-42-abc', lifecycle: 'ephemeral', ttlSeconds: 2700, target: 'this-machine', released: true },
  plan: { operations: [planned('install'), planned('typecheck'), planned('lint'), planned('test')], ambiguous: false, drift: false, note: 'PAX on the Computer planned the same commands.' },
  operations: [operation('typecheck', 'passed', 0), operation('lint', 'passed', 0), operation('test', 'passed', 0)], events: [], ...patch })

let api: Record<string, ReturnType<typeof vi.fn>>
let node: HTMLDivElement
let root: Root
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  api = { ciPlan: vi.fn(async () => plan()), startCi: vi.fn(async () => run({ status: 'running', phase: 'acquiring', operations: [], computer: undefined })), cancelCi: vi.fn(async () => undefined), openComputeUi: vi.fn(async () => undefined) }
  ;(window as unknown as { douchat: unknown }).douchat = api
  node = document.createElement('div'); document.body.append(node); root = createRoot(node)
})
afterEach(async () => { await act(async () => root.unmount()); node.remove() })
const render = (runs: CiRun[] = []) => act(async () => root.render(<CiPanel project={project} runs={runs} />))
const click = (label: string) => act(async () => { [...node.querySelectorAll('button')].find(item => item.textContent === label)!.click() })

it('shows the resolved workload before it runs: revision, Compute’s platform statement, PAX’s operations, an ephemeral Computer', async () => {
  await render()
  const text = node.textContent!
  expect(text).toContain('my-app'); expect(text).toContain('abc123abc123'); expect(text).toContain('Compute Configured'); expect(text).toContain('Linux x86_64 — Certified'); expect(text).toContain('Ephemeral')
  expect(text).toContain('typecheck'); expect(text).toContain('npm run test'); expect(text).toContain("package.json has no 'build' script")
  expect(text).not.toContain('install')
  await click('Run CI')
  expect(api.startCi).toHaveBeenCalledWith({ projectId: 'p1' })
})

it('will not run while something blocks it, and says what', async () => {
  api.ciPlan.mockResolvedValue(plan({ ready: false, blockers: ['2 uncommitted files in the project. CI tests a committed revision, never local state: commit or stash them first.'] }))
  await render()
  expect(node.querySelector('.coding-error')!.textContent).toContain('uncommitted')
  expect([...node.querySelectorAll('button')].find(item => item.textContent === 'Run CI')!.disabled).toBe(true)
})

it('offers to resolve a PAX ambiguity with an explicit tool instead of choosing one', async () => {
  api.ciPlan.mockResolvedValue(plan({ ready: false, blockers: ['PAX cannot choose one native tool'], plan: { operations: [], ambiguous: true, drift: false } }))
  await render()
  expect(node.querySelector('input[aria-label="Tool"]')).not.toBeNull()
})

it('shows a passed run with every operation, its revision, the Computer and that it was released', async () => {
  await render([run()])
  const text = node.querySelector('.ci-run')!.textContent!
  expect(text).toContain('Run #42'); expect(text).toContain('Passed'); expect(text).toContain('abc123abc123'); expect(text).toContain('foundry-ci-42-abc'); expect(text).toContain('Linux x86_64 — Certified')
  expect(text).toContain('PAX plan'); expect(text).toContain('Computer released')
  expect([...node.querySelectorAll('.ci-operation')].map(item => item.textContent!.slice(0, 1))).toEqual(['✓', '✓', '✓'])
})

it('shows a failed run: what passed, what failed with its exit code, what did not run, and that the Computer was released', async () => {
  await render([run({ number: 43, status: 'failed', operations: [operation('typecheck', 'passed', 0), operation('lint', 'passed', 0), operation('test', 'failed', 1, 'expected 5')],
    failure: { kind: 'operation', operation: 'test', message: 'test failed (exit 1).' }, plan: { operations: [planned('typecheck'), planned('lint'), planned('test'), planned('build')], ambiguous: false, drift: false } })])
  const text = node.querySelector('.ci-run')!.textContent!
  expect(text).toContain('Failed'); expect(text).toContain('exit 1'); expect(text).toContain('expected 5'); expect(text).toContain('test failed (exit 1).'); expect(text).toContain('Computer released')
  expect([...node.querySelectorAll('.ci-operation')].map(item => item.textContent!.slice(0, 1))).toEqual(['✓', '✓', '✗', '–'])
  expect(node.querySelector('.ci-operation-notrun')!.textContent).toContain('build')
})

it('labels a Preview platform Preview, however well the run went', async () => {
  await render([run({ platform: mac })])
  const label = node.querySelector('.ci-run .coding-platform')!
  expect(label.textContent).toBe('macOS ARM64 — Preview')
  expect(label.className).toContain('coding-platform-preview')
})

it('says so when the Computer was not confirmed released, and offers cancel while running', async () => {
  await render([run({ computer: { environment: 'foundry-ci-42-abc', lifecycle: 'ephemeral', ttlSeconds: 2700, released: false, releaseNote: 'Compute did not answer' } })])
  expect(node.querySelector('.ci-run')!.textContent).toContain('not confirmed released: Compute did not answer')
  await render([run({ status: 'running', phase: 'executing', operations: [] })])
  await click('Cancel CI')
  expect(api.cancelCi).toHaveBeenCalledWith('r1')
})
