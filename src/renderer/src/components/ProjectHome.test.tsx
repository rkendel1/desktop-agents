// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentConfig, AppSnapshot, CodingActivity, CodingSession, Conversation, DevelopmentEnvironmentView, GitState, Project } from '../../../shared/types'
import type { PermissionRequest } from '../../../shared/agentPermissions'
import { ProjectsView } from './ProjectsView'

vi.mock('../preferences', () => ({ t: (text: string) => text, tr: (text: string, values: Record<string, unknown> = {}) => text.replace(/\{(\w+)\}/g, (_all, key) => String(values[key])) }))

const project: Project = { id: 'p1', name: 'Fixture', path: '/work/fixture', isGit: true, testCommand: ['npm', 'test'], createdAt: 1, updatedAt: 1 }
const agent = { id: 'a1', name: 'Coder' } as AgentConfig
const session = (patch: Partial<CodingSession> = {}): CodingSession => ({
  id: 's1', projectId: 'p1', agentId: 'a1', conversationId: 'c', topicId: 't', workingDirectory: '/work/fixture', task: 'Fix add()', status: 'succeeded',
  createdAt: 1000, startedAt: 1000, finishedAt: 5000, result: 'Fixed it.', baseline: { changes: [] }, changes: [], commands: [], events: [], ...patch
})
const request: PermissionRequest = { id: 'r1', agentId: 'a1', agentName: 'Coder', requester: 'Coder', capability: 'otherTools', operation: 'Claude: Edit', roomName: 'Coder', createdAt: 2000,
  details: JSON.stringify({ tool: 'Edit', input: { file_path: '/work/fixture/src/math.js' } }) }
const snapshot = (patch: Partial<AppSnapshot> = {}): AppSnapshot => ({ agents: [agent], projects: [project], codingSessions: [], codingActivity: [], messages: [], ...patch } as AppSnapshot)
const git = (patch: Partial<GitState> = {}): GitState => ({ branch: 'main', head: 'abc123abc123', upstream: 'origin/main', ahead: 2, behind: 1, changes: [
  { path: 'src/staged.js', code: 'M ' }, { path: 'src/edited.js', code: ' M' }, { path: 'src/both.js', code: 'MM' }, { path: 'notes.txt', code: '??' }], ...patch })

const unavailable = (): DevelopmentEnvironmentView => ({ projectId: 'p1', compute: { ok: false, reason: 'daemon-unreachable', message: 'The Compute daemon is not answering at http://127.0.0.1:8787. Start it with `compute start`.' },
  state: 'compute-unavailable', reason: { category: 'daemon-unreachable', title: 'Compute is unavailable.', message: 'The Compute daemon is not answering at http://127.0.0.1:8787. Start it with `compute start`.' }, progress: [], actions: [], observedAt: 1 })

let api: Record<string, ReturnType<typeof vi.fn>>
let node: HTMLDivElement
let root: Root
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  api = {
    projectGitStatus: vi.fn(async () => git()), projectGitDiff: vi.fn(async (_id: string, path: string, _s: unknown, mode: string) => ({ diff: `diff ${mode} ${path}`, truncated: false })),
    projectGitStage: vi.fn(async () => git()), projectGitUnstage: vi.fn(async () => git()), projectGitCommit: vi.fn(async () => ({ state: git({ changes: [] }), commit: 'def456def456', summary: 'Fix it' })),
    resolveAgentPermission: vi.fn(async () => undefined), cancelCodingSession: vi.fn(async () => undefined), continueCodingSession: vi.fn(async () => session()), runCodingChecks: vi.fn(async () => undefined),
    startCodingSession: vi.fn(async () => session({ status: 'running' })), computeInventory: vi.fn(async () => ({ available: false, reason: 'The Compute daemon is not answering at http://127.0.0.1:8787. Start it with `compute start`.', daemon: { endpoint: '', reachable: false }, environments: [] })),
    projectPax: vi.fn(async (_id: string, command: string) => command === 'info'
      ? { command, exitCode: 0, json: { manager: { name: 'npm', selectedBy: 'lockfile precedence' } }, stdout: '', stderr: '', findings: { ambiguous: false, drift: false, failedClosed: false } }
      : { command, exitCode: 2, json: { issues: [{ status: 'ambiguous', expected: 'one JavaScript package-manager authority', actual: 'pnpm-lock.yaml, package-lock.json' }] }, stdout: '', stderr: '', findings: { ambiguous: true, drift: false, failedClosed: false } }),
    openComputeUi: vi.fn(async () => undefined), environmentState: vi.fn(async () => unavailable()), environmentDetail: vi.fn(), environmentRecipes: vi.fn(async () => []), environmentResolve: vi.fn(), environmentCreate: vi.fn(), environmentAct: vi.fn(), setProjectTestCommand: vi.fn(async () => project), discoverProjectCommands: vi.fn(async () => [{ operation: 'test', command: ['npm', 'test'] }]), chooseProject: vi.fn(),
    ciPlan: vi.fn(async () => ({ projectId: 'p1', projectName: 'Fixture', ready: false, blockers: ['x'], computer: { lifecycle: 'ephemeral' } })), startCi: vi.fn(), cancelCi: vi.fn(),
    listJevEvaluations: vi.fn(async () => [])
  }
  ;(window as unknown as { douchat: unknown }).douchat = api
  node = document.createElement('div'); document.body.append(node); root = createRoot(node)
})
afterEach(async () => { await act(async () => root.unmount()); node.remove() })
const render = (snap: AppSnapshot, onSelect = vi.fn()) => act(async () => root.render(<ProjectsView snapshot={snap} selection={{ projectId: 'p1' }} onSelect={onSelect} />))
const click = (label: string | RegExp) => act(async () => {
  const button = [...node.querySelectorAll('button')].find(item => typeof label === 'string' ? item.textContent === label : label.test(item.textContent ?? ''))
  if (!button) throw new Error(`No button ${label}`)
  button.click()
})

it('answers what am I working on: project, repository, branch, upstream distance and commit — as Git reports them', async () => {
  await render(snapshot())
  const head = node.querySelector('header')!.textContent!
  expect(head).toContain('Fixture'); expect(head).toContain('/work/fixture'); expect(head).toContain('main'); expect(head).toContain('origin/main ↑2 ↓1'); expect(head).toContain('abc123ab'); expect(head).toContain('4 changed files')
})

it('renders the project’s own durable group conversation and history', async () => {
  const conversation: Conversation = { id: 'project-p1', projectId: 'p1', type: 'group', name: 'Fixture', agentIds: ['a1'], leadAgentId: 'a1', workspacePath: project.path,
    topics: [{ id: 'topic', title: 'AppPort', createdAt: 1, updatedAt: 1 }], activeTopicId: 'topic', unread: 0, readAt: 1, createdAt: 1, updatedAt: 1 }
  await render(snapshot({ conversations: [conversation], activity: [], runtime: { mode: 'live', label: 'Connected' }, userName: 'Randy', userAvatar: '',
    messages: [{ id: 'm1', projectId: 'p1', sessionId: conversation.id, runId: 'run-1', origin: 'agent', conversationId: conversation.id, topicId: 'topic', authorId: 'a1', authorName: 'Coder', text: 'The project context is loaded.', kind: 'message', createdAt: 2 }] }))
  const projectChat = node.querySelector('[aria-label="Project conversation"]')!
  expect(projectChat.textContent).toContain('Discuss, decide, and delegate work in this project')
  expect(projectChat.textContent).toContain('The project context is loaded.')
  expect(projectChat.querySelector('textarea')).not.toBeNull()
})

it('shows inspectable Jev decisions, rules, evidence, uncertainty and provenance on the project', async () => {
  api.listJevEvaluations.mockResolvedValueOnce([{ context: { sourceAgentId: 'forge', projectId: 'p1' }, question: {
    id: 'q1', subject: { kind: 'architecture' }, question: 'Single authority?', requestedDecision: 'pass-fail-review',
    inputs: [{ id: 'stores', name: 'durableStores', value: ['FeltDB'] }], rules: [{ id: 'one', expression: 'exactlyOne(durableStores)' }]
  }, result: { evaluationId: 'e1', questionId: 'q1', decision: { value: true, status: 'pass' }, evaluations: [{ ruleId: 'one', result: 'true' }],
    evidence: [{ inputId: 'stores', relevance: ['one'] }], uncertainty: [], provenance: { jevVersion: '1.0.0', runtime: 'deterministic', model: 'none', questionId: 'q1', timestamp: new Date(1000).toISOString() },
    metrics: { validationMs: 1, deterministicMs: 1, modelMs: 0, resultValidationMs: 1, persistenceMs: 1, totalMs: 4 } } }])
  await render(snapshot())
  const section = node.querySelector('[aria-label="Structured decisions"]')!
  expect(section.textContent).toContain('PASS Single authority?')
  expect(section.textContent).toContain('1 rules · 1 evidence items · 0 uncertainty')
  ;(section.querySelector('details') as HTMLDetailsElement).open = true
  expect(section.textContent).toContain('Jev 1.0.0 · deterministic · none · agent forge')
  expect(section.textContent).toContain('durableStores')
})

it('separates staged, not staged and untracked, and shows each diff for what it is', async () => {
  await render(snapshot())
  const tree = node.querySelector('[aria-label="Working tree"]')!
  expect(tree.textContent).toContain('Staged (2)'); expect(tree.textContent).toContain('Not staged (2)'); expect(tree.textContent).toContain('Untracked (1)')
  await click(/src\/both\.js.*Modified/)   // first match is in Staged
  expect(api.projectGitDiff).toHaveBeenLastCalledWith('p1', 'src/both.js', undefined, 'staged')
  expect(node.querySelector('.coding-diff')!.textContent).toBe('diff staged src/both.js')
  expect(node.textContent).toContain('Staged changes (index against HEAD)')
  await click(/notes\.txt/)
  expect(node.textContent).toContain('Untracked — not included in git diff')
})

it('stages, unstages and commits through the service, then reads Git again', async () => {
  await render(snapshot())
  const reads = api.projectGitStatus.mock.calls.length
  await act(async () => { [...node.querySelectorAll('[aria-label="Working tree"] li')].find(item => item.textContent!.includes('notes.txt'))!.querySelector('button.secondary-button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  expect(api.projectGitStage).toHaveBeenCalledWith('p1', ['notes.txt'])
  expect(api.projectGitStatus.mock.calls.length).toBeGreaterThan(reads)
  await act(async () => { [...node.querySelectorAll('[aria-label="Working tree"] li')].find(item => item.textContent!.includes('src/staged.js'))!.querySelector('button.secondary-button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  expect(api.projectGitUnstage).toHaveBeenCalledWith('p1', ['src/staged.js'])
  const box = node.querySelector('textarea[aria-label="Commit message"]') as HTMLTextAreaElement
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Fix it'); box.dispatchEvent(new Event('input', { bubbles: true })) })
  await click(/Commit 2 staged/)
  expect(api.projectGitCommit).toHaveBeenCalledWith('p1', 'Fix it')
  expect(node.textContent).toContain('Committed def456de: Fix it')
})

it('offers no Git writes while a session runs in the project, and asks for the approval right on the home', async () => {
  const running = session({ status: 'running', finishedAt: undefined })
  const activity: CodingActivity = { sessionId: 's1', state: 'awaiting-approval', label: 'Waiting for approval: Edit src/math.js', source: 'douchat', since: 2000, approval: request }
  await render(snapshot({ codingSessions: [running], codingActivity: [activity] }))
  expect(node.textContent).toContain('Happening now'); expect(node.textContent).toContain('Waiting for approval'); expect(node.textContent).toContain('Agent wants to:'); expect(node.textContent).toContain('src/math.js')
  expect(node.textContent).toContain('A coding session is running here')
  expect([...node.querySelectorAll('[aria-label="Working tree"] button.secondary-button')].filter(button => ['Stage', 'Unstage', 'Stage all'].includes(button.textContent!)).every(button => (button as HTMLButtonElement).disabled)).toBe(true)
  await click('Allow')
  expect(api.resolveAgentPermission).toHaveBeenCalledWith('r1', true)
})

it('remembers what I was doing last time from the durable session, and continues an interrupted one in one click', async () => {
  const interrupted = session({ status: 'interrupted', error: 'The app closed while this coding session was running. Its process did not survive.', changes: [{ path: 'src/math.js', code: ' M', origin: 'session' }] })
  await render(snapshot({ codingSessions: [interrupted] }))
  const last = node.querySelector('[aria-label="Now"]')!.textContent!
  expect(last).toContain('Last time'); expect(last).toContain('Interrupted'); expect(last).toContain('Fix add()'); expect(last).toContain('This Computer'); expect(last).toContain('1 changed files')
  await click('Continue')
  expect(api.continueCodingSession).toHaveBeenCalledWith('s1')
})

it('lists recent checks with argv, exit status, duration and time, and runs checks against the latest session', async () => {
  const withChecks = session({ commands: [{ argv: ['npm', 'test'], exitCode: 1, startedAt: 3000, durationMs: 2500, stdout: '', stderr: 'boom' }] })
  await render(snapshot({ codingSessions: [withChecks] }))
  const checks = node.querySelector('[aria-label="Check command"]')!.textContent!
  expect(checks).toContain('npm test'); expect(checks).toContain('✗'); expect(checks).toContain('exit 1'); expect(checks).toContain('2.5s')
  await click('Run checks')
  expect(api.runCodingChecks).toHaveBeenCalledWith('s1')
})

it('makes Compute the default, labels local as fallback, and refuses to fake Compute when it is unavailable', async () => {
  await render(snapshot())
  expect(node.textContent).toContain('If it is not ready, nothing starts here instead')
  const select = [...node.querySelectorAll('select')].find(item => item.closest('label')?.textContent?.startsWith('Execution')) as HTMLSelectElement
  expect(select.value).toBe('compute')
  expect([...select.options].map(option => option.textContent)).toEqual(['Compute environment (recommended)', 'This Computer — local fallback'])
  expect(node.textContent).toContain('If it is not ready, nothing starts here instead')
  expect(node.textContent).toContain('Start it with `compute start`')
  const start = [...node.querySelectorAll('button')].find(item => item.textContent === 'Start session') as HTMLButtonElement
  expect(start.disabled).toBe(true)
  expect(api.startCodingSession).not.toHaveBeenCalled()
})

it('shows PAX’s conclusion about the project’s tooling as PAX gave it — ambiguity stays ambiguous', async () => {
  await render(snapshot())
  const head = node.querySelector('header')!.textContent!
  expect(head).toContain('Tooling (PAX): npm'); expect(head).toContain('lockfile precedence'); expect(head).toContain('ambiguous: pnpm-lock.yaml, package-lock.json')
  expect(api.projectPax).toHaveBeenCalledWith('p1', 'info'); expect(api.projectPax).toHaveBeenCalledWith('p1', 'drift')
})

it('says PAX is missing instead of failing when it is not installed', async () => {
  api.projectPax.mockRejectedValue(new Error('PAX is not installed, so project tooling is not shown.'))
  await render(snapshot())
  expect(node.querySelector('header')!.textContent).toContain('PAX is not installed')
})
