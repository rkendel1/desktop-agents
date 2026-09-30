// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentConfig, AppSnapshot, CodingActivity, CodingSession, Project } from '../../../shared/types'
import type { PermissionRequest } from '../../../shared/agentPermissions'
import { CodingSessionPanel } from './CodingSessionPanel'
import { ProjectsView } from './ProjectsView'

vi.mock('../preferences', () => ({ t: (text: string) => text, tr: (text: string, values: Record<string, unknown> = {}) => text.replace(/\{(\w+)\}/g, (_all, key) => String(values[key])) }))

const project: Project = { id: 'p1', name: 'Fixture', path: '/work/fixture', isGit: true, testCommand: ['npm', 'test'], createdAt: 1, updatedAt: 1 }
const agent = { id: 'a1', name: 'Coder' } as AgentConfig
const session = (patch: Partial<CodingSession> = {}): CodingSession => ({
  id: 's1', projectId: 'p1', agentId: 'a1', conversationId: 'c', topicId: 't', workingDirectory: '/work/fixture', task: 'Fix add()', status: 'succeeded',
  createdAt: 1000, startedAt: 1000, finishedAt: 5000, result: 'Fixed it.', baseline: { changes: [] }, changes: [], commands: [], events: [], ...patch
})
const request: PermissionRequest = { id: 'r1', agentId: 'a1', agentName: 'Coder', requester: 'Coder', capability: 'otherTools', operation: 'Claude: Bash', roomName: 'Coder', createdAt: 2000,
  details: JSON.stringify({ tool: 'Bash', input: { command: 'npm test | head' } }) }
const approval = (): CodingActivity => ({ sessionId: 's1', state: 'awaiting-approval', label: 'Waiting for approval: Run npm test | head', source: 'douchat', since: 2000, approval: request })

let api: Record<string, ReturnType<typeof vi.fn>>
let node: HTMLDivElement
let root: Root
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  api = {
    resolveAgentPermission: vi.fn(async () => undefined), cancelCodingSession: vi.fn(async () => undefined), continueCodingSession: vi.fn(async () => session({ status: 'running' })),
    projectPax: vi.fn(async () => { throw new Error('PAX is not installed, so project tooling is not shown.') }),
    ciPlan: vi.fn(async () => ({ projectId: 'p1', projectName: 'Fixture', ready: false, blockers: ['not now'], computer: { lifecycle: 'ephemeral' } })), startCi: vi.fn(), cancelCi: vi.fn(),
    runCodingChecks: vi.fn(async () => undefined), openComputeUi: vi.fn(async () => undefined),
    computeInventory: vi.fn(async () => ({ available: true, daemon: { endpoint: 'http://127.0.0.1:8787', reachable: true }, installation: { binary: '/x/compute-configured', version: '0.1.5', configured: true },
      platform: { platform: 'linux-x86_64', status: 'certified', label: 'Linux x86_64 — Certified', evidence: 'compute-configured-verify' },
      environments: [{ name: 'stopped-one', environmentId: 'e0', observed: 'stopped' }, { name: 'workbench', environmentId: 'e1', observed: 'running' }] })), projectGitStatus: vi.fn(async () => ({ branch: 'main', changes: [] })), projectGitDiff: vi.fn(async () => ({ diff: '', truncated: false })),
    startCodingSession: vi.fn(async () => session({ status: 'running' })), chooseProject: vi.fn(async () => project), setProjectTestCommand: vi.fn(async () => project)
  }
  ;(window as unknown as { douchat: unknown }).douchat = api
  node = document.createElement('div'); document.body.append(node); root = createRoot(node)
})
afterEach(async () => { await act(async () => root.unmount()); node.remove() })

const render = (element: React.ReactElement) => act(async () => root.render(element))
const click = (label: string | RegExp, scope: ParentNode = node) => act(async () => {
  const button = [...scope.querySelectorAll('button')].find(item => typeof label === 'string' ? item.textContent === label : label.test(item.textContent ?? ''))
  if (!button) throw new Error(`No button ${label}`)
  button.click()
})
const panel = (patch: Partial<CodingSession> = {}, activity?: CodingActivity, extra: Partial<Project> = {}) =>
  render(<CodingSessionPanel session={session(patch)} project={{ ...project, ...extra }} agent={agent} activity={activity} />)

it('shows the task, agent, project, times, result and the backend state', async () => {
  await panel()
  const text = node.textContent!
  expect(text).toContain('Fix add()'); expect(text).toContain('Coder'); expect(text).toContain('Fixture'); expect(text).toContain('/work/fixture'); expect(text).toContain('Fixed it.')
  expect(node.querySelector('[role=status]')!.textContent).toBe('Succeeded')
})

it.each([['failed', 'Failed'], ['cancelled', 'Cancelled'], ['running', 'Running']] as const)('shows %s as %s', async (status, label) => {
  await panel({ status, error: status === 'failed' ? 'the agent stopped' : undefined })
  expect(node.querySelector('[role=status]')!.textContent).toBe(label)
  if (status === 'failed') expect(node.querySelector('.coding-error')!.textContent).toBe('the agent stopped')
})

it('says a running session is running, with its live activity, and can cancel it', async () => {
  await panel({ status: 'running', finishedAt: undefined }, { sessionId: 's1', state: 'running', label: 'Running npm test', source: 'agent', since: 1 })
  expect(node.querySelector('.coding-activity')!.textContent).toContain('Running npm test')
  await click('Cancel session')
  expect(api.cancelCodingSession).toHaveBeenCalledWith('s1')
})

it('asks what the agent wants to do, where and who is asking, and Allow answers through the permission IPC', async () => {
  await panel({ status: 'running', finishedAt: undefined }, approval())
  expect(node.querySelector('[role=status]')!.textContent).toBe('Waiting for approval')
  const card = node.querySelector('.coding-approval')!
  expect(card.textContent).toContain('Agent wants to:')
  expect(card.textContent).toContain('Run npm test | head')
  expect(card.textContent).toContain('Coder'); expect(card.textContent).toContain('Fixture'); expect(card.textContent).toContain('/work/fixture')
  await click('Allow')
  expect(api.resolveAgentPermission).toHaveBeenCalledExactlyOnceWith('r1', true)
  expect(api.cancelCodingSession).not.toHaveBeenCalled()
})

it('Deny refuses the request without stopping the session', async () => {
  await panel({ status: 'running', finishedAt: undefined }, approval())
  await click('Deny')
  expect(api.resolveAgentPermission).toHaveBeenCalledExactlyOnceWith('r1', false)
  expect(api.cancelCodingSession).not.toHaveBeenCalled()
})

it('names an edit by its path in the project, and can cancel the whole session from the approval', async () => {
  const edit: CodingActivity = { ...approval(), approval: { ...request, details: JSON.stringify({ tool: 'Edit', input: { file_path: '/work/fixture/src/math.js' } }) } }
  await panel({ status: 'running', finishedAt: undefined }, edit)
  expect(node.querySelector('.coding-approval-action')!.textContent).toBe('Edit src/math.js')
  await click('Cancel session')
  expect(api.cancelCodingSession).toHaveBeenCalledWith('s1')
  expect(api.resolveAgentPermission).not.toHaveBeenCalled()
})

it('separates what changed during the session from what was already modified, and shows a tracked diff but not an untracked one', async () => {
  api.projectGitDiff.mockResolvedValue({ diff: '-  return a - b\n+  return a + b\n', truncated: false })
  await panel({
    baseline: { head: 'aaaa1111', changes: [{ path: 'wip.txt', code: ' M' }] },
    changes: [{ path: 'src/math.js', code: ' M', origin: 'session' }, { path: 'src/new-file.js', code: '??', origin: 'session' }, { path: 'wip.txt', code: ' M', origin: 'before' }],
    cleaned: ['scratch.txt'], finalHead: 'bbbb2222'
  })
  const sections = [...node.querySelectorAll('.coding-subheading')].map(item => item.textContent!.replace(/\s+/g, ' ').trim())
  expect(sections).toEqual(['Changed during this session (2)', 'Already modified (1)'])
  const rows = [...node.querySelectorAll('.coding-changes li')].map(item => item.textContent!.replace(/\s+/g, ' ').trim())
  expect(rows).toEqual(['M src/math.js Modified', '?? src/new-file.js Untracked', 'M wip.txt Modified'])
  expect(node.textContent).toContain('not who changed them')
  expect(node.textContent).toContain('scratch.txt')
  expect(node.textContent).toContain('aaaa1111'); expect(node.textContent).toContain('bbbb2222')
  await click(/src\/math\.js/)
  expect(api.projectGitDiff).toHaveBeenCalledWith('p1', 'src/math.js', undefined)
  expect(node.querySelector('.coding-diff')!.textContent).toContain('+  return a + b')
  await click(/src\/new-file\.js/)
  expect(api.projectGitDiff).toHaveBeenCalledTimes(1)
  expect(node.querySelector('.coding-diff')).toBeNull()
  expect(node.textContent).toContain('Untracked — not included in git diff')
})

it('while running, compares the repository as it is now with how it was at the start', async () => {
  api.projectGitStatus.mockResolvedValue({ branch: 'main', changes: [{ path: 'wip.txt', code: ' M', fingerprint: 'sha1:same' }, { path: 'agent.ts', code: '??', fingerprint: 'sha1:new' }] })
  await panel({ status: 'running', finishedAt: undefined, baseline: { changes: [{ path: 'wip.txt', code: ' M', fingerprint: 'sha1:same' }] } })
  const rows = [...node.querySelectorAll('.coding-changes')].map(list => [...list.querySelectorAll('li')].map(item => item.textContent!.replace(/\s+/g, ' ').trim()))
  expect(rows).toEqual([['?? agent.ts Untracked'], ['M wip.txt Modified']])
})

it('says so when nothing changed during the session, even if the tree was dirty before', async () => {
  await panel({ baseline: { changes: [{ path: 'wip.txt', code: ' M' }] }, changes: [{ path: 'wip.txt', code: ' M', origin: 'before' }] })
  expect(node.textContent).toContain('No files changed during this session.')
  expect(node.textContent).toContain('Already modified')
})

it('runs the project check and shows ✓ or ✗ with bounded output', async () => {
  const result = (exitCode: number) => ({ argv: ['npm', 'test'], exitCode, startedAt: 1, durationMs: 5, stdout: exitCode ? '' : 'ok\n', stderr: exitCode ? 'add(2, 3) should be 5' : '' })
  await panel({ commands: [result(0), result(1)] })
  const checks = [...node.querySelectorAll('.coding-check')].map(item => item.textContent!.replace(/\s+/g, ' '))
  expect(checks[0]).toContain('✗ exit 1'); expect(checks[0]).toContain('add(2, 3) should be 5')
  expect(checks[1]).toContain('✓ exit 0')
  await click('Run checks')
  expect(api.runCodingChecks).toHaveBeenCalledWith('s1')
})

it('disables Run checks while running or without a check command', async () => {
  await panel({}, undefined, { testCommand: undefined })
  expect(node.textContent).toContain('No check command is set for this project.')
  expect([...node.querySelectorAll('button')].find(item => item.textContent === 'Run checks')!.disabled).toBe(true)
})

it('says an interrupted session was interrupted, and Continue starts it again without claiming the old process lives', async () => {
  await panel({ status: 'interrupted', error: 'The app closed while this coding session was running. Its process did not survive.' })
  expect(node.querySelector('[role=status]')!.textContent).toContain('Interrupted')
  expect(node.textContent).toContain('This session was interrupted when Foundry closed.')
  expect(node.textContent).toContain('A new agent process will be started in this project. The previous process will not be resumed.')
  expect(node.textContent).toContain('Continue will start a new conversation with the existing project/session context.')
  await click('Continue')
  expect(api.continueCodingSession).toHaveBeenCalledWith('s1')
})

it('continues a finished session with a new instruction, in the same session', async () => {
  await panel()
  const box = node.querySelector<HTMLTextAreaElement>('textarea[aria-label="Continue the session"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Fix the remaining failing test.')
    box.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('Send')
  expect(api.continueCodingSession).toHaveBeenCalledWith('s1', 'Fix the remaining failing test.')
})

it('lists the events of the session in order', async () => {
  await panel({ events: [{ at: 1, kind: 'started', label: 'Agent started' }, { at: 2, kind: 'approval-allowed', label: 'Allowed', detail: 'Run npm test' }, { at: 3, kind: 'finished', label: 'Agent finished' }] })
  expect([...node.querySelectorAll('.coding-events li strong')].map(item => item.textContent)).toEqual(['Agent started', 'Allowed', 'Agent finished'])
})

const snapshot = (patch: Partial<AppSnapshot> = {}): AppSnapshot => ({ agents: [agent], projects: [project], codingSessions: [session({ id: 's9', task: 'Old task' })], codingActivity: [], ...patch } as AppSnapshot)

it('lists projects with their path, Git status, check command and sessions, and selecting one opens it', async () => {
  const select = vi.fn()
  api.projectGitStatus.mockResolvedValue({ branch: 'main', changes: [{ path: 'a', code: ' M' }] })
  await render(<ProjectsView snapshot={snapshot()} selection={{}} onSelect={select} />)
  expect(node.textContent).toContain('Fixture'); expect(node.textContent).toContain('/work/fixture'); expect(node.textContent).toContain('Old task')
  await click(/Fixture/)
  expect(select).toHaveBeenCalledWith({ projectId: 'p1' })
  await render(<ProjectsView snapshot={snapshot()} selection={{ projectId: 'p1' }} onSelect={select} />)
  expect(node.textContent).toContain('main · 1 changed files')
  expect(node.querySelector('[aria-label="Check command"]')!.textContent).toContain('npm test')
})

it('adds a project through the folder picker and starts a session with the chosen agent and task', async () => {
  const select = vi.fn()
  await render(<ProjectsView snapshot={snapshot({ projects: [], codingSessions: [] })} selection={{}} onSelect={select} />)
  await click('Add project')
  expect(api.chooseProject).toHaveBeenCalled()
  expect(select).toHaveBeenCalledWith({ projectId: 'p1' })

  await render(<ProjectsView snapshot={snapshot()} selection={{ projectId: 'p1' }} onSelect={select} />)
  const task = node.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(task, 'Add a test')
    task.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('Start session')
  expect(api.startCodingSession).toHaveBeenCalledWith({ projectId: 'p1', agentId: 'a1', task: 'Add a test' })
  expect(select).toHaveBeenLastCalledWith({ projectId: 'p1', sessionId: 's1' })
})

it('proposes a check command as text; the main process confirms and stores it', async () => {
  await render(<ProjectsView snapshot={snapshot()} selection={{ projectId: 'p1' }} onSelect={vi.fn()} />)
  const input = node.querySelector<HTMLInputElement>('input[aria-label="Check command"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'npm run lint')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('Set…')
  expect(api.setProjectTestCommand).toHaveBeenCalledWith('p1', 'npm run lint')
})

it('shows the session panel when a session is selected', async () => {
  await render(<ProjectsView snapshot={snapshot()} selection={{ projectId: 'p1', sessionId: 's9' }} onSelect={vi.fn()} />)
  expect(node.querySelector('.coding-session h2')!.textContent).toBe('Old task')
})

it('offers Compute as an execution target from Compute’s own inventory, with its platform label, and starts the session there', async () => {
  await render(<ProjectsView snapshot={snapshot()} selection={{ projectId: 'p1' }} onSelect={vi.fn()} />)
  const execution = [...node.querySelectorAll('select')].find(item => [...item.options].some(option => option.value === 'compute'))!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(execution, 'compute'); execution.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(api.computeInventory).toHaveBeenCalled()
  expect(node.querySelector('.coding-platform')!.textContent).toBe('Linux x86_64 — Certified')
  expect(node.querySelector('.coding-platform-certified')).not.toBeNull()
  // The running Computer is preselected; the start button waits for a choice otherwise.
  const task = node.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(task, 'Run the tests'); task.dispatchEvent(new Event('input', { bubbles: true })) })
  await click('Start session')
  expect(api.startCodingSession).toHaveBeenCalledWith({ projectId: 'p1', agentId: 'a1', task: 'Run the tests', execution: { kind: 'compute', environment: 'workbench' } })
  await click('Open Compute')
  expect(api.openComputeUi).toHaveBeenCalled()
})

it('never labels a preview platform as certified, and says when Compute is not available', async () => {
  api.computeInventory.mockResolvedValueOnce({ available: false, reason: 'The Compute daemon is not answering at http://127.0.0.1:8787. Start it with `compute start`.', daemon: { endpoint: 'http://127.0.0.1:8787', reachable: false }, environments: [],
    platform: { platform: 'macos-aarch64', status: 'preview', label: 'macOS ARM64 — Preview', evidence: 'compute-configured-verify' } })
  await render(<ProjectsView snapshot={snapshot()} selection={{ projectId: 'p1' }} onSelect={vi.fn()} />)
  const execution = [...node.querySelectorAll('select')].find(item => [...item.options].some(option => option.value === 'compute'))!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(execution, 'compute'); execution.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(node.querySelector('.coding-platform')!.textContent).toBe('macOS ARM64 — Preview')
  expect(node.querySelector('.coding-platform-certified')).toBeNull()
  expect(node.querySelector('[role=alert]')!.textContent).toContain('compute start')
  expect([...node.querySelectorAll('button')].find(item => item.textContent === 'Start session')!.disabled).toBe(true)
})

it('shows that a session runs on a Computer, and reads its changes and diff from that Computer', async () => {
  await panel({ execution: { kind: 'compute', environment: 'workbench', repository: 'foundry-x-1' }, changes: [{ path: 'a.ts', code: ' M', origin: 'session' }] })
  expect(node.textContent).toContain('Runs on Computer')
  expect(node.textContent).toContain('workbench')
  expect(api.projectGitStatus).toHaveBeenCalledWith('p1', 's1')
  await click(/a\.ts/)
  expect(api.projectGitDiff).toHaveBeenCalledWith('p1', 'a.ts', 's1')
  await click('Open Compute')
  expect(api.openComputeUi).toHaveBeenCalled()
})
