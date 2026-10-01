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
    openComputeUi: vi.fn(async () => undefined), environmentState: vi.fn(async () => unavailable()), environmentDetail: vi.fn(), environmentRecipes: vi.fn(async () => []), environmentResolve: vi.fn(), environmentCreate: vi.fn(), environmentAct: vi.fn(),
    environmentSetupDeveloper: vi.fn(), onEnvironmentSetupProgress: vi.fn(() => () => undefined), setProjectTestCommand: vi.fn(async () => project), discoverProjectCommands: vi.fn(async () => [{ operation: 'test', command: ['npm', 'test'] }]), chooseProject: vi.fn(),
    projectConversations: vi.fn(async () => []), createProjectConversation: vi.fn(), sendMessage: vi.fn(async () => undefined), stopConversation: vi.fn(async () => undefined),
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

it('renders the project’s durable chat and explains that chat does not start coding work', async () => {
  const conversation: Conversation = { id: 'project-p1', projectId: 'p1', type: 'group', name: 'Fixture', agentIds: ['a1'], leadAgentId: 'a1', workspacePath: project.path,
    topics: [{ id: 'topic', title: 'AppPort', createdAt: 1, updatedAt: 1 }], activeTopicId: 'topic', unread: 0, readAt: 1, createdAt: 1, updatedAt: 1 }
  await render(snapshot({ conversations: [conversation], activity: [], runtime: { mode: 'live', label: 'Connected' }, userName: 'Randy', userAvatar: '',
    messages: [{ id: 'm1', projectId: 'p1', sessionId: conversation.id, runId: 'run-1', origin: 'agent', conversationId: conversation.id, topicId: 'topic', authorId: 'a1', authorName: 'Coder', text: 'The project context is loaded.', kind: 'message', createdAt: 2 }] }))
  api.projectConversations.mockResolvedValue([conversation])
  const projectChat = node.querySelector('[aria-label="Project chats"]')!
  expect(projectChat.textContent).toContain('Chat replies do not start coding work')
  expect(projectChat.textContent).toContain('The project context is loaded.')
  expect(projectChat.querySelector('textarea')).not.toBeNull()
})

it('keeps one-click Developer setup in the Environment section', async () => {
  const none: DevelopmentEnvironmentView = { projectId: 'p1', compute: { ok: true, installed: { binary: '/compute', version: '0.1.6' } }, state: 'none', progress: [], actions: ['create'], observedAt: 1 }
  const ready: DevelopmentEnvironmentView = { ...none, state: 'ready', reference: { projectId: 'p1', environment: 'dev', environmentId: 'env_1', createdAt: 1 },
    recipe: { name: 'developer', version: 1, digest: 'sha256:x' }, readiness: 'ready', configuration: 'succeeded', lifecycle: 'running', actions: ['open', 'restart', 'stop', 'destroy'] }
  api.environmentState.mockResolvedValue(none)
  api.environmentSetupDeveloper.mockResolvedValue({ projectId: 'p1', steps: [], view: ready })
  const conversation: Conversation = { id: 'project-p1', projectId: 'p1', type: 'group', name: 'Fixture', agentIds: ['a1'], workspacePath: project.path,
    topics: [{ id: 'topic', title: '', createdAt: 1, updatedAt: 1 }], activeTopicId: 'topic', unread: 0, readAt: 1, createdAt: 1, updatedAt: 1 }
  await render(snapshot({ conversations: [conversation], activity: [], runtime: { mode: 'live', label: 'Connected' } }))
  await click('Environment')
  expect(node.querySelector('[aria-label="Environment"]')!.textContent).toContain('No environment')
  await click('Create Developer Environment')
  expect(api.environmentSetupDeveloper).toHaveBeenCalledWith('p1')
})

it('creates and switches among multiple durable chats for one project', async () => {
  const chat = (id: string, name: string): Conversation => ({ id, projectId: 'p1', type: 'group', name, agentIds: ['a1'], workspacePath: project.path,
    topics: [{ id: `topic-${id}`, title: '', createdAt: 1, updatedAt: 1 }], activeTopicId: `topic-${id}`, unread: 0, readAt: 1, createdAt: 1, updatedAt: id === 'architecture' ? 2 : 1 })
  const general = chat('general', 'General'), architecture = chat('architecture', 'Architecture')
  api.projectConversations.mockResolvedValue([architecture, general])
  api.createProjectConversation.mockResolvedValue(chat('release', 'Release planning'))
  await render(snapshot({ conversations: [general, architecture], activity: [], runtime: { mode: 'live', label: 'Connected' } }))
  expect([...node.querySelectorAll('.project-chat-list button')].map(button => button.querySelector('strong')?.textContent)).toEqual(['Architecture', 'General'])
  await click('New chat')
  const input = node.querySelector<HTMLInputElement>('[aria-label="Chat name"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Release planning'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await click('Create chat')
  expect(api.createProjectConversation).toHaveBeenCalledWith({ projectId: 'p1', name: 'Release planning' })
  expect(node.querySelector('.project-chat-list button.active strong')?.textContent).toBe('Release planning')
})

it('shows inspectable Jev decisions, rules, evidence, uncertainty and provenance on the project', async () => {
  api.listJevEvaluations.mockResolvedValueOnce([{ context: { sourceAgentId: 'forge', projectId: 'p1' }, question: {
    id: 'q1', subject: { kind: 'architecture' }, question: 'Single authority?', requestedDecision: 'pass-fail-review',
    inputs: [{ id: 'stores', name: 'durableStores', value: ['FeltDB'] }], rules: [{ id: 'one', expression: 'exactlyOne(durableStores)' }]
  }, result: { evaluationId: 'e1', questionId: 'q1', decision: { value: true, status: 'pass' }, evaluations: [{ ruleId: 'one', result: 'true' }],
    evidence: [{ inputId: 'stores', relevance: ['one'] }], uncertainty: [], provenance: { jevVersion: '1.0.0', runtime: 'deterministic', model: 'none', questionId: 'q1', timestamp: new Date(1000).toISOString() },
    metrics: { validationMs: 1, deterministicMs: 1, modelMs: 0, resultValidationMs: 1, persistenceMs: 1, totalMs: 4 } } }])
  await render(snapshot())
  await click('History')
  const section = node.querySelector('[aria-label="Structured decisions"]')!
  expect(section.textContent).toContain('PASS Single authority?')
  expect(section.textContent).toContain('1 rules · 1 evidence items · 0 uncertainty')
  ;(section.querySelector('details') as HTMLDetailsElement).open = true
  expect(section.textContent).toContain('Jev 1.0.0 · deterministic · none · agent forge')
  expect(section.textContent).toContain('durableStores')
})

it('separates staged, not staged and untracked, and shows each diff for what it is', async () => {
  await render(snapshot())
  await click('Work')
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
  await click('Work')
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
  await click(/^Work/)
  expect(node.textContent).toContain('Happening now'); expect(node.textContent).toContain('Waiting for approval'); expect(node.textContent).toContain('Agent wants to:'); expect(node.textContent).toContain('src/math.js')
  expect(node.textContent).toContain('A coding session is running here')
  expect([...node.querySelectorAll('[aria-label="Working tree"] button.secondary-button')].filter(button => ['Stage', 'Unstage', 'Stage all'].includes(button.textContent!)).every(button => (button as HTMLButtonElement).disabled)).toBe(true)
  await click('Allow')
  expect(api.resolveAgentPermission).toHaveBeenCalledWith('r1', true)
})

it('remembers what I was doing last time from the durable session, and continues an interrupted one in one click', async () => {
  const interrupted = session({ status: 'interrupted', error: 'The app closed while this coding session was running. Its process did not survive.', changes: [{ path: 'src/math.js', code: ' M', origin: 'session' }] })
  await render(snapshot({ codingSessions: [interrupted] }))
  await click('Work')
  const last = node.querySelector('[aria-label="Now"]')!.textContent!
  expect(last).toContain('Last time'); expect(last).toContain('Interrupted'); expect(last).toContain('Fix add()'); expect(last).toContain('Project folder on this computer'); expect(last).toContain('1 changed files')
  await click('Continue')
  expect(api.continueCodingSession).toHaveBeenCalledWith('s1')
})

it('lists recent checks with argv, exit status, duration and time, and runs checks against the latest session', async () => {
  const withChecks = session({ commands: [{ argv: ['npm', 'test'], exitCode: 1, startedAt: 3000, durationMs: 2500, stdout: '', stderr: 'boom' }] })
  await render(snapshot({ codingSessions: [withChecks] }))
  await click('Checks')
  const checks = node.querySelector('[aria-label="Check command"]')!.textContent!
  expect(checks).toContain('npm test'); expect(checks).toContain('✗'); expect(checks).toContain('exit 1'); expect(checks).toContain('2.5s')
  await click('Run checks')
  expect(api.runCodingChecks).toHaveBeenCalledWith('s1')
})

it('uses the project folder for a hosted-model agent and does not pretend it runs on Compute', async () => {
  await render(snapshot())
  await click('Work')
  const select = [...node.querySelectorAll('select')].find(item => item.closest('label')?.textContent?.startsWith('Execution')) as HTMLSelectElement
  expect(select.value).toBe('local')
  expect(select.options[0].disabled).toBe(true)
  expect([...select.options].map(option => option.textContent)).toEqual(['Compute environment', 'Project folder on this computer'])
  expect(node.textContent).toContain('Its selected model is unchanged.')
  const start = [...node.querySelectorAll('button')].find(item => item.textContent === 'Start work') as HTMLButtonElement
  expect(start.disabled).toBe(true) // no task yet, not because Compute is down
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
