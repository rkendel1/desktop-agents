import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ComputerProvider } from '../computer'
import { DesktopRepository } from '../desktopRepository'
import type { SecretCodec } from '../credentialVault'
import { startDesktop, stopDesktop, type DesktopState } from '../desktop'
import { addCustomLocalAgent, detectLocalAgents } from '../localAgents'
import { DouchatRuntime } from '../runtime'
import { runCommand } from './commands'
import { gitDiff, gitStatus, parseGitStatus } from './git'
import { CodingService } from './service'
import { DesktopProjection } from '../projection'

/**
 * Real repository, real processes. Nothing here is a mocked tool call: the agent
 * is a real child process (see fixtures/scripted-agent.cjs), started by Douchat's
 * own local-agent path with the project as its working directory.
 */
const fixture = join(__dirname, 'fixtures', 'scripted-agent.cjs')
const codec: SecretCodec = { available: () => true, encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() }
const idleComputer: ComputerProvider = { snapshots: () => [], start: async () => undefined, stop: async () => undefined, show: async () => undefined, createTools: () => [], dispose: () => undefined } as never
const directories: string[] = []
const running: Booted[] = []

interface Booted { root: string; desktop: DesktopState; runtime: DouchatRuntime; coding: CodingService }

const temporary = (prefix: string): string => { const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix))); directories.push(directory); return directory }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })

function repository(): string {
  const path = temporary('coding-repo-')
  git(path, 'init', '-q', '-b', 'main')
  git(path, 'config', 'user.email', 'test@example.com'); git(path, 'config', 'user.name', 'Test')
  mkdirSync(join(path, 'src'))
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node test.js' } }))
  writeFileSync(join(path, 'src', 'math.js'), 'function add(a, b) {\n  return a - b\n}\nmodule.exports = { add }\n')
  writeFileSync(join(path, 'test.js'), "const { add } = require('./src/math')\nif (add(2, 3) !== 5) { console.error('add(2, 3) should be 5, got ' + add(2, 3)); process.exit(1) }\nconsole.log('ok')\n")
  git(path, 'add', '-A'); git(path, 'commit', '-q', '-m', 'initial')
  return path
}

async function boot(root = temporary('coding-desktop-')): Promise<Booted> {
  const desktop = await startDesktop({ userData: root, codec })
  const runtime = new DouchatRuntime(desktop.repository, idleComputer, () => undefined)
  const booted = { root, desktop, runtime, coding: new CodingService(desktop.repository, runtime) }
  running.push(booted)
  return booted
}

/** The orderly shutdown of index.ts, in the same order. */
async function shutdown(booted: Booted): Promise<void> {
  booted.runtime.stopAccepting()
  await booted.coding.cancelAll()
  booted.runtime.cancelAll()
  await booted.coding.idle()
  await booted.runtime.idle()
  await stopDesktop(booted.desktop)
  running.splice(running.indexOf(booted), 1)
}

async function scriptedAgent(booted: Booted, name = 'Scripted coder') {
  await addCustomLocalAgent({ name, command: process.execPath, args: [fixture] })
  const local = (await detectLocalAgents()).find(agent => agent.name === name)!
  return booted.desktop.repository.createAgent({ name, role: 'Engineer', instructions: '', color: '#0b5cff', localAgentId: local.id, provider: 'local', model: 'default' })
}

const taskText = (description: string, task: object): string => `${description}\nCODING-TASK ${JSON.stringify(task)}`
/** Running, not merely still listed: a killed process nobody has reaped yet is a zombie and does nothing. */
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0) } catch { return false }
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return true }
}

afterEach(async () => {
  for (const booted of [...running]) await shutdown(booted).catch(() => undefined)
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('git visibility', () => {
  it('reports a clean repository, then exactly what changed and its patch', async () => {
    const path = repository()
    expect(await gitStatus(path)).toMatchObject({ branch: 'main', changes: [] })
    writeFileSync(join(path, 'src', 'math.js'), 'function add(a, b) {\n  return a + b\n}\nmodule.exports = { add }\n')
    writeFileSync(join(path, 'notes.txt'), 'new file\n')
    const state = await gitStatus(path)
    expect(state.head).toMatch(/^[0-9a-f]{40}$/)
    // Git lists tracked changes before untracked files.
    expect(state.changes).toEqual([{ path: 'src/math.js', code: ' M' }, { path: 'notes.txt', code: '??' }])
    const { diff, truncated } = await gitDiff(path)
    expect(truncated).toBe(false)
    expect(diff).toContain('-  return a - b')
    expect(diff).toContain('+  return a + b')
    expect((await gitDiff(path, { path: 'test.js' })).diff).toBe('')
  })

  it('parses renames and staged changes from porcelain output', () => {
    expect(parseGitStatus('## main...origin/main\0R  new.ts\0old.ts\0A  added.ts\0 D gone.ts\0?? loose.ts\0').changes).toEqual([
      { path: 'new.ts', code: 'R ', from: 'old.ts' }, { path: 'added.ts', code: 'A ' }, { path: 'gone.ts', code: ' D' }, { path: 'loose.ts', code: '??' }
    ])
  })

  it('does not let a repository run programs through its own configuration just to be looked at', async () => {
    const path = repository()
    const marker = join(temporary('coding-marker-'), 'ran')
    git(path, 'config', 'core.fsmonitor', `touch ${marker}`)
    await gitStatus(path)
    expect(existsSync(marker)).toBe(false)
  })
})

describe('shell execution', () => {
  it('runs a repository command in the project with its output and exit status', async () => {
    const path = repository()
    // The fixture's bug makes its own test fail: stderr and a non-zero status are the result, not an exception.
    const failing = await runCommand(['npm', 'test'], { cwd: path })
    expect(failing.exitCode).toBe(1)
    expect(failing.stderr).toContain('should be 5')
    expect(failing.stdout).not.toContain('ok')
    writeFileSync(join(path, 'src', 'math.js'), 'function add(a, b) {\n  return a + b\n}\nmodule.exports = { add }\n')
    const passing = await runCommand(['npm', 'test'], { cwd: path })
    expect(passing).toMatchObject({ exitCode: 0 })
    expect(passing.stdout).toContain('ok')
  })

  it('represents a failing command as a result, and a missing program as an error', async () => {
    const path = repository()
    await expect(runCommand(['definitely-not-a-program-xyz'], { cwd: path })).rejects.toThrow()
    const failing = await runCommand(['node', '-e', "console.log('out'); console.error('err'); process.exit(3)"], { cwd: path })
    expect(failing).toMatchObject({ exitCode: 3, stdout: 'out\n', stderr: 'err\n' })
  })

  it('runs with the project as its working directory, and nothing else', async () => {
    const path = repository()
    const result = await runCommand(['node', '-e', 'console.log(process.cwd())'], { cwd: path })
    expect(result.stdout.trim()).toBe(path)
    await expect(runCommand(['node', '-v'], { cwd: '' })).rejects.toThrow(/working directory/)
  })

  it('kills the whole process tree on cancellation, on timeout, and after the program exits', async () => {
    const path = repository()
    const pids = join(temporary('coding-pids-'), 'pids')
    const script = `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pids)}, process.pid + '\\n' + c.pid); setInterval(() => {}, 1000)`
    const controller = new AbortController()
    const pending = runCommand(['node', '-e', script], { cwd: path, signal: controller.signal })
    await waitUntil(() => existsSync(pids) && readFileSync(pids, 'utf8').includes('\n'))
    const [parent, child] = readFileSync(pids, 'utf8').split('\n').map(Number)
    expect(alive(parent) && alive(child)).toBe(true)
    controller.abort()
    const result = await pending
    expect(result).toMatchObject({ cancelled: true, exitCode: null })
    await waitUntil(() => !alive(parent) && !alive(child))

    const timed = await runCommand(['node', '-e', 'setInterval(() => {}, 1000)'], { cwd: path, timeoutMs: 300 })
    expect(timed).toMatchObject({ timedOut: true })

    // A program that backgrounds a child and exits leaves nothing behind.
    const orphan = join(temporary('coding-orphan-'), 'pid')
    await runCommand(['node', '-e', `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); c.unref(); require('node:fs').writeFileSync(${JSON.stringify(orphan)}, String(c.pid))`], { cwd: path })
    await waitUntil(() => !alive(Number(readFileSync(orphan, 'utf8'))))
  }, 60_000)
})

describe('an agent coding in a real repository', () => {
  it('reads the project, changes a real file, runs the tests, and the desktop can see all of it', async () => {
    const booted = await boot()
    const { coding, desktop } = booted
    const path = repository()
    const agent = await scriptedAgent(booted)
    const project = await coding.addProject(path, 'Fixture')
    expect(project).toMatchObject({ path, name: 'Fixture', isGit: true })
    await desktop.repository.setProjectTestCommand(project.id, ['npm', 'test'])

    const started = await coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Fix add() in src/math.js so the tests pass.', { action: 'fix-add' }) })
    expect(started).toMatchObject({ status: 'running', workingDirectory: path, baseline: { branch: 'main', changes: [] } })
    const session = (await coding.settled(started.id))!

    // The agent process ran in the project, inspected it, and reported what it did.
    expect(session.status).toBe('succeeded')
    expect(session.result).toContain(`cwd=${path}`)
    expect(session.result).toContain('files=package.json,src,test.js')
    expect(session.result).toContain('git-before=clean')
    expect(session.result).toContain('test-before=1')
    expect(session.result).toContain('test-after=0')

    // The change is on disk, in the real file.
    expect(readFileSync(join(path, 'src', 'math.js'), 'utf8')).toContain('return a + b')
    // Git shows it, and the session recorded which paths changed (never their contents).
    expect(session.changes).toEqual([expect.objectContaining({ path: 'src/math.js', code: ' M', origin: 'session' })])
    expect((await coding.gitStatus(project.id)).changes.map(change => change.path)).toEqual(session.changes.map(change => change.path))
    expect((await coding.gitDiff(project.id)).diff).toContain('+  return a + b')

    // Douchat itself can run the project's check, and the result belongs to the session.
    const check = (await coding.runChecks(session.id))!
    expect(check).toMatchObject({ exitCode: 0, argv: ['npm', 'test'] })
    expect(check.stdout).toContain('ok')
    expect((await desktop.repository.codingSession(session.id))!.commands).toHaveLength(1)

    // The conversation and run that carried it are the chat's own, in the session's topic.
    const messages = await desktop.repository.topicMessages(session.conversationId, session.topicId)
    expect(messages.map(message => message.authorId)).toEqual(['user', agent.id])
    expect(messages[0].text).toContain('Fix add()')
    const run = (await desktop.repository.runs()).find(item => item.id === session.runId)!
    expect(run).toMatchObject({ status: 'succeeded', agentId: agent.id, conversationId: session.conversationId })
  }, 60_000)

  it('records a failed agent as a failed session, and a failing check as a result', async () => {
    const booted = await boot()
    const path = repository()
    const agent = await scriptedAgent(booted)
    const project = await booted.coding.addProject(path)
    const started = await booted.coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Do something impossible.', { action: 'fail' }) })
    const session = (await booted.coding.settled(started.id))!
    expect(session.status).toBe('failed')
    expect(session.error).toContain('could not complete the task')
    expect(session.changes).toEqual([])
    expect(git(path, 'status', '--porcelain')).toBe('')

    // The repository's own test fails (the bug is still there): exit status and stderr reach the session.
    const result = await booted.coding.runCommand(session.id, ['npm', 'test'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('should be 5')
    expect((await booted.desktop.repository.codingSession(session.id))!.commands[0]).toMatchObject({ exitCode: 1 })
  }, 60_000)

  it('cancels a running session and takes the agent process and its children down with it', async () => {
    const booted = await boot()
    const path = repository()
    const agent = await scriptedAgent(booted)
    const project = await booted.coding.addProject(path)
    const pids = join(temporary('coding-cancel-'), 'pids')
    const started = await booted.coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Wait forever.', { action: 'hang', pidfile: pids }) })
    await waitUntil(() => existsSync(pids) && readFileSync(pids, 'utf8').includes('\n'))
    const [parent, child] = readFileSync(pids, 'utf8').split('\n').map(Number)
    expect(alive(parent) && alive(child)).toBe(true)
    expect((await booted.desktop.repository.codingSession(started.id))!.status).toBe('running')

    await booted.coding.cancel(started.id)
    const session = (await booted.coding.settled(started.id))!
    expect(session.status).toBe('cancelled')
    await waitUntil(() => !alive(parent) && !alive(child))
    expect((await booted.desktop.repository.runs()).find(run => run.id === session.runId)?.status).toBe('cancelled')
  }, 60_000)

  it('serializes two agents working in the same project folder', async () => {
    const booted = await boot()
    const path = repository()
    const first = await scriptedAgent(booted, 'Coder one')
    const second = await scriptedAgent(booted, 'Coder two')
    const project = await booted.coding.addProject(path)
    const log = join(temporary('coding-log-'), 'log')
    writeFileSync(log, '')
    const a = await booted.coding.start({ projectId: project.id, agentId: first.id, task: taskText('Fix add().', { action: 'fix-add', name: 'one', log }) })
    const b = await booted.coding.start({ projectId: project.id, agentId: second.id, task: taskText('Fix add().', { action: 'fix-add', name: 'two', log }) })
    const [doneA, doneB] = await Promise.all([booted.coding.settled(a.id), booted.coding.settled(b.id)])
    expect([doneA?.status, doneB?.status]).toEqual(['succeeded', 'succeeded'])
    // The folder is held by one agent at a time: whoever started first finished before the other began.
    const events = readFileSync(log, 'utf8').trim().split('\n').map(line => line.split(' ')[0] + ' ' + line.split(' ')[1])
    expect(events).toHaveLength(4)
    expect(events[0].startsWith('start')).toBe(true)
    expect(events[1]).toBe(events[0].replace('start', 'end'))
    expect(await booted.desktop.repository.codingSessions(project.id)).toHaveLength(2)
  }, 90_000)

  it('refuses a folder that is not allowed, a missing project and a second concurrent session for one agent', async () => {
    const booted = await boot()
    await expect(booted.coding.addProject('/')).rejects.toThrow()
    await expect(booted.coding.addProject(join(temporary('coding-none-'), 'missing'))).rejects.toThrow(/not found/i)
    const path = repository()
    const agent = await scriptedAgent(booted)
    const project = await booted.coding.addProject(path)
    await expect(booted.coding.start({ projectId: 'workspace-nope', agentId: agent.id, task: 'x' })).rejects.toThrow(/Project not found/)
    const pids = join(temporary('coding-busy-'), 'pids')
    const started = await booted.coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Hang.', { action: 'hang', pidfile: pids }) })
    await expect(booted.coding.start({ projectId: project.id, agentId: agent.id, task: 'another' })).rejects.toThrow(/already working/)
    await booted.coding.cancel(started.id)
    await booted.coding.settled(started.id)
  }, 60_000)

  it('is not a project until it is added, and adding a folder twice is the same project', async () => {
    const booted = await boot()
    const path = repository()
    const one = await booted.coding.addProject(path)
    const two = await booted.coding.addProject(path, 'Renamed')
    expect(two.id).toBe(one.id)
    expect(await booted.desktop.repository.projects()).toHaveLength(1)
    expect(await booted.desktop.repository.removeProject(one.id)).toBe(true)
    expect(await booted.desktop.repository.projects()).toEqual([])
    // The folder and its files are untouched by any of it.
    expect(existsSync(join(path, 'src', 'math.js'))).toBe(true)
  })
})

describe('restart', () => {
  it('reconstructs the project, session, conversation and changes from FeltDB alone', async () => {
    const root = temporary('coding-restart-')
    const path = repository()
    const first = await boot(root)
    const agent = await scriptedAgent(first)
    const project = await first.coding.addProject(path, 'Persistent')
    await first.desktop.repository.setProjectTestCommand(project.id, ['npm', 'test'])
    const started = await first.coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Fix add().', { action: 'fix-add' }) })
    const before = (await first.coding.settled(started.id))!
    await first.coding.runChecks(before.id)
    const beforeSession = (await first.desktop.repository.codingSession(before.id))!
    await shutdown(first)

    const second = await boot(root)
    const repositoryAfter: DesktopRepository = second.desktop.repository
    const projects = await repositoryAfter.projects()
    expect(projects).toEqual([expect.objectContaining({ id: project.id, name: 'Persistent', path, isGit: true, testCommand: ['npm', 'test'] })])
    const session = (await repositoryAfter.codingSession(before.id))!
    // Everything durable is back, unchanged: what it was, who did it, where, what came of it.
    expect(session).toEqual(beforeSession)
    expect(session).toMatchObject({ status: 'succeeded', projectId: project.id, agentId: agent.id, workingDirectory: path, changes: [{ path: 'src/math.js', code: ' M' }] })
    expect((await repositoryAfter.topicMessages(session.conversationId, session.topicId)).map(message => message.authorId)).toEqual(['user', agent.id])
    expect((await repositoryAfter.runs()).find(run => run.id === session.runId)?.status).toBe('succeeded')
    expect((await second.coding.gitStatus(project.id)).changes.map(change => change.path)).toEqual(session.changes.map(change => change.path))
    // And the reopened desktop can carry on with the same project.
    const next = await second.coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Look around.', { action: 'none' }) })
    expect((await second.coding.settled(next.id))!.status).toBe('succeeded')
  }, 90_000)

  it('marks a session that was running when the app died as interrupted; the old process is not resumed', async () => {
    const root = temporary('coding-crash-')
    const path = repository()
    const first = await boot(root)
    const agent = await scriptedAgent(first)
    const project = await first.coding.addProject(path)
    // Simulate a crash: the session is recorded as running, and no orderly shutdown ever finishes it.
    const running = await first.desktop.repository.createCodingSession({ projectId: project.id, agentId: agent.id, conversationId: 'direct-x', topicId: 't', workingDirectory: path, task: 'work', status: 'running', startedAt: Date.now(), baseline: { changes: [] } })
    await first.desktop.repository.close()
    running && first.desktop.repository

    const second = await boot(root)
    const recovered = (await second.desktop.repository.codingSession(running.id))!
    expect(recovered.status).toBe('interrupted')
    expect(recovered.error).toContain('did not survive')
    expect(recovered.finishedAt).toBeDefined()
    // It can be started afresh: the interrupted session does not block the agent.
    const next = await second.coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Look around.', { action: 'none' }) })
    expect((await second.coding.settled(next.id))!.status).toBe('succeeded')
  }, 60_000)

  it('cancels running sessions during an orderly shutdown, so each records its final state', async () => {
    const root = temporary('coding-shutdown-')
    const path = repository()
    const first = await boot(root)
    const agent = await scriptedAgent(first)
    const project = await first.coding.addProject(path)
    const pids = join(temporary('coding-shutdown-pids-'), 'pids')
    const started = await first.coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Hang.', { action: 'hang', pidfile: pids }) })
    await waitUntil(() => existsSync(pids) && readFileSync(pids, 'utf8').includes('\n'))
    const [parent, child] = readFileSync(pids, 'utf8').split('\n').map(Number)
    await shutdown(first)
    await waitUntil(() => !alive(parent) && !alive(child))

    const second = await boot(root)
    expect((await second.desktop.repository.codingSession(started.id))!.status).toBe('cancelled')
  }, 60_000)
})

describe('coding as a usable loop', () => {
  const pidfile = (): string => join(temporary('coding-ux-pids-'), 'pids')
  const started = (pids: string): Promise<void> => waitUntil(() => existsSync(pids) && readFileSync(pids, 'utf8').includes('\n'))

  it('pins the working directory: the chat cannot be pointed elsewhere, or used elsewhere, under a session', async () => {
    const booted = await boot()
    const { coding, desktop, runtime } = booted
    const path = repository(), other = repository()
    const agent = await scriptedAgent(booted)
    const project = await coding.addProject(path)
    const pids = pidfile()
    const running = await coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Hang.', { action: 'hang', pidfile: pids }) })
    await started(pids)

    // While it runs the chat's folder is fixed: changing it and clearing it are both refused, and nothing moved.
    await expect(desktop.repository.setConversationWorkspace(running.conversationId, other)).rejects.toThrow(/pinned to/)
    await expect(desktop.repository.setConversationWorkspace(running.conversationId, undefined)).rejects.toThrow(/pinned to/)
    expect((await desktop.repository.conversation(running.conversationId))?.workspacePath).toBe(path)

    await coding.cancel(running.id)
    expect((await coding.settled(running.id))!.status).toBe('cancelled')

    // Once it is over the chat may move, but a turn in the session's topic is then refused before anything is stored.
    await desktop.repository.setConversationWorkspace(running.conversationId, other)
    const before = (await desktop.repository.topicMessages(running.conversationId, running.topicId)).length
    await expect(runtime.sendMessage(running.conversationId, 'Carry on somewhere else.')).rejects.toThrow(/pinned to .*Refusing/)
    expect((await desktop.repository.topicMessages(running.conversationId, running.topicId)).length).toBe(before)

    // Continuing restores the session's own folder — it never adopts the new one.
    const continued = await coding.continue(running.id, taskText('Look around.', { action: 'none' }))
    const done = (await coding.settled(continued.id))!
    expect(done).toMatchObject({ status: 'succeeded', workingDirectory: path })
    expect(done.result).toContain(`cwd=${path}`)
    expect((await desktop.repository.conversation(running.conversationId))?.workspacePath).toBe(path)
  }, 90_000)

  it('records approvals and the outcome as session events, and shows a waiting approval with its project, agent and session', async () => {
    const booted = await boot()
    const { coding, desktop, runtime } = booted
    const path = repository()
    const agent = await scriptedAgent(booted)
    const project = await coding.addProject(path, 'Approvals')
    const pids = pidfile()
    const session = await coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Hang.', { action: 'hang', pidfile: pids }) })
    await started(pids)
    expect(coding.activity()).toEqual([expect.objectContaining({ sessionId: session.id, state: 'running' })])

    // What a CLI does when it wants to run a command: ask the owner, through the runtime's permission broker.
    const config = (await desktop.repository.agent(agent.id))!
    const broker = (runtime as unknown as { permissions: { authorize: (...args: unknown[]) => Promise<void> } }).permissions
    const decision = broker.authorize(config, { requester: config.name, requesterId: config.id, requesterKind: 'agent', roomName: config.name, context: 'direct', capability: 'otherTools',
      operation: 'Claude: Bash', details: JSON.stringify({ tool: 'Bash', input: { command: 'npm test | head' } }) }, undefined, true)
    await waitUntil(() => coding.activity()[0]?.state === 'awaiting-approval')
    const waiting = coding.activity()[0]
    expect(waiting).toMatchObject({ sessionId: session.id, label: 'Waiting for approval: Run npm test | head' })
    expect(waiting.approval).toMatchObject({ agentId: agent.id, agentName: config.name })

    // The renderer sees it: durable project and session, and the live activity, in one snapshot.
    const projection = new DesktopProjection(desktop.repository, {
      ephemeral: () => ({ ...runtime.ephemeralState(), codingActivity: coding.activity() }), runtimeStatus: () => ({ mode: 'offline', label: '' }), availableModels: () => [], connectors: async () => []
    }, () => undefined)
    const { snapshot } = await projection.snapshot()
    expect(snapshot.projects).toEqual([expect.objectContaining({ id: project.id, name: 'Approvals', path })])
    expect(snapshot.codingSessions?.map(item => item.id)).toEqual([session.id])
    expect(snapshot.codingActivity).toEqual([expect.objectContaining({ sessionId: session.id, state: 'awaiting-approval' })])

    runtime.resolveAgentPermission(waiting.approval!.id, true)
    await decision
    await waitUntil(() => coding.activity()[0]?.state === 'running')

    // A second request, denied.
    const denied = broker.authorize(config, { requester: config.name, requesterId: config.id, requesterKind: 'agent', roomName: config.name, context: 'direct', capability: 'otherTools',
      operation: 'Claude: Edit', details: JSON.stringify({ tool: 'Edit', input: { file_path: `${path}/src/math.js` } }) }, undefined, true)
    const rejection = expect(denied).rejects.toThrow('declined')
    await waitUntil(() => coding.activity()[0]?.state === 'awaiting-approval')
    expect(coding.activity()[0].label).toBe('Waiting for approval: Edit ' + `${path}/src/math.js`)
    runtime.resolveAgentPermission(coding.activity()[0].approval!.id, false)
    await rejection

    await coding.cancel(session.id)
    const finished = (await coding.settled(session.id))!
    await coding.idle()
    const stored = (await desktop.repository.codingSession(session.id))!
    expect(stored.events.map(event => event.kind)).toEqual(['started', 'approval-requested', 'approval-allowed', 'approval-requested', 'approval-denied', 'changes', 'finished'])
    expect(stored.events.map(event => event.detail)).toContain('Run npm test | head')
    expect(finished.status).toBe('cancelled')
    expect(coding.activity()).toEqual([])
  }, 90_000)

  it('continues a finished session in the same conversation, topic and folder — the ordinary chat path', async () => {
    const booted = await boot()
    const path = repository()
    const agent = await scriptedAgent(booted)
    const project = await booted.coding.addProject(path)
    const first = (await booted.coding.settled((await booted.coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Fix add().', { action: 'fix-add' }) })).id))!
    const again = await booted.coding.continue(first.id, taskText('Now look around again.', { action: 'none' }))
    expect(again).toMatchObject({ id: first.id, status: 'running' })
    const second = (await booted.coding.settled(first.id))!
    expect(second).toMatchObject({ status: 'succeeded', conversationId: first.conversationId, topicId: first.topicId, workingDirectory: path })
    expect(second.runId).not.toBe(first.runId)
    const messages = await booted.desktop.repository.topicMessages(first.conversationId, first.topicId)
    expect(messages.map(message => message.authorId)).toEqual(['user', agent.id, 'user', agent.id])
    expect(second.events.map(event => event.kind)).toEqual(['started', 'changes', 'finished', 'continued', 'changes', 'finished'])
    await expect(booted.coding.continue(first.id)).resolves.toBeDefined()
    await booted.coding.settled(first.id)
  }, 90_000)

  it('offers Continue for an interrupted session; it starts a new turn on the same conversation and says why', async () => {
    const root = temporary('coding-interrupted-')
    const path = repository()
    const first = await boot(root)
    const agent = await scriptedAgent(first)
    const project = await first.coding.addProject(path)
    const seed = (await first.coding.settled((await first.coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Look around.', { action: 'none' }) })).id))!
    // The app dies mid-turn: the record still says running.
    await first.desktop.repository.resumeCodingSession(seed.id)
    await first.desktop.repository.close()

    const second = await boot(root)
    const interrupted = (await second.desktop.repository.codingSession(seed.id))!
    expect(interrupted).toMatchObject({ status: 'interrupted', workingDirectory: path })
    expect(interrupted.events.at(-1)).toMatchObject({ kind: 'interrupted', label: 'Interrupted when Douchat closed' })
    expect(interrupted.finishedAt).toBeDefined()
    await second.coding.continue(seed.id)
    const done = (await second.coding.settled(seed.id))!
    expect(done.error).toBeUndefined()
    expect(done).toMatchObject({ status: 'succeeded', conversationId: seed.conversationId, topicId: seed.topicId })
    const prompt = (await second.desktop.repository.topicMessages(seed.conversationId, seed.topicId)).filter(message => message.authorId === 'user').at(-1)!
    expect(prompt.text).toContain('interrupted when Douchat closed')
  }, 90_000)

  it('records check runs as events: the command, and whether it passed', async () => {
    const booted = await boot()
    const path = repository()
    const agent = await scriptedAgent(booted)
    const project = await booted.coding.addProject(path)
    await booted.desktop.repository.setProjectTestCommand(project.id, ['npm', 'test'])
    const session = (await booted.coding.settled((await booted.coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Look around.', { action: 'none' }) })).id))!
    expect((await booted.coding.runChecks(session.id))!.exitCode).toBe(1)
    writeFileSync(join(path, 'src', 'math.js'), 'function add(a, b) {\n  return a + b\n}\nmodule.exports = { add }\n')
    expect((await booted.coding.runChecks(session.id))!.exitCode).toBe(0)
    await booted.coding.idle()
    const events = (await booted.desktop.repository.codingSession(session.id))!.events.filter(event => event.kind === 'checks')
    expect(events.map(event => event.label)).toEqual(['Tests completed ✗', 'Tests completed ✓'])
    expect(events[0].detail).toBe('npm test — exit 1')
  }, 60_000)
})

describe('a dirty repository', () => {
  it('never credits the session with what was already modified, and says exactly what it can establish', async () => {
    const booted = await boot()
    const path = repository()
    const agent = await scriptedAgent(booted)
    // A working tree someone was in the middle of: edited tracked files, untracked files (one nested, one with spaces).
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.1', scripts: { test: 'node test.js' } }))
    writeFileSync(join(path, 'test.js'), '// scratch edit\n')
    mkdirSync(join(path, 'notes', 'deep'), { recursive: true })
    writeFileSync(join(path, 'notes', 'deep', 'todo.txt'), 'later\n')
    writeFileSync(join(path, 'my file with spaces.txt'), 'hello\n')
    const head = git(path, 'rev-parse', 'HEAD').trim()
    const project = await booted.coding.addProject(path)

    const task = { action: 'touch', files: {
      'package.json': '{"name":"fixture","version":"9.9.9"}',       // dirty before, changed again
      'test.js': readFileSync(join(path, 'test.js'), 'utf8') && git(path, 'show', 'HEAD:test.js'), // dirty before, restored to HEAD: clean now
      'src/created.js': 'module.exports = 1\n'                       // not there before
    } }
    const session = (await booted.coding.settled((await booted.coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Touch files.', task) })).id))!

    expect(session.baseline.head).toBe(head)
    expect(session.baseline.changes.map(change => change.path).sort()).toEqual(['my file with spaces.txt', 'notes/deep/todo.txt', 'package.json', 'test.js'])
    const origin = Object.fromEntries(session.changes.map(change => [change.path, change.origin]))
    expect(origin).toEqual({ 'package.json': 'session', 'src/created.js': 'session', 'my file with spaces.txt': 'before', 'notes/deep/todo.txt': 'before' })
    expect(session.cleaned).toEqual(['test.js'])
    expect(session.finalHead).toBe(head)
    const events = (await booted.desktop.repository.codingSession(session.id))!.events
    expect(events[0].detail).toContain('4 files were already modified')
    expect(events.find(event => event.kind === 'changes')).toMatchObject({
      label: '2 files changed during this session', detail: '2 already modified before it started · 1 modified before, clean now' })
  }, 60_000)

  it('recognizes a file that is untouched, even when its timestamp changed, and one that changed with the same status', async () => {
    const path = repository()
    writeFileSync(join(path, 'wip.txt'), 'one\n'); writeFileSync(join(path, 'other.txt'), 'same\n')
    const before = await gitStatus(path, undefined, { fingerprints: true })
    writeFileSync(join(path, 'wip.txt'), 'two\n'); writeFileSync(join(path, 'other.txt'), 'same\n')
    const { accountChanges } = await import('./git')
    const { changes } = accountChanges(before.changes, (await gitStatus(path, undefined, { fingerprints: true })).changes)
    expect(Object.fromEntries(changes.map(change => [change.path, change.origin]))).toEqual({ 'wip.txt': 'session', 'other.txt': 'before' })
  })

  it('reports a commit the session made: HEAD moved', async () => {
    const booted = await boot()
    const path = repository()
    const agent = await scriptedAgent(booted)
    const project = await booted.coding.addProject(path)
    const before = git(path, 'rev-parse', 'HEAD').trim()
    const session = await booted.coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Hang.', { action: 'hang', pidfile: join(temporary('coding-head-'), 'pids') }) })
    git(path, 'commit', '-q', '--allow-empty', '-m', 'made during the session')
    await booted.coding.cancel(session.id)
    const done = (await booted.coding.settled(session.id))!
    expect(done.finalHead).not.toBe(before)
    expect((await booted.desktop.repository.codingSession(session.id))!.events.find(event => event.kind === 'changes')!.detail).toContain('HEAD moved')
  }, 60_000)
})

describe('checks are structured argv, end to end', () => {
  it('runs the stored argument vector exactly: spaces, quotes and shell characters are data, not syntax', async () => {
    const { parseCommandLine, formatCommandLine } = await import('../../shared/coding')
    const line = `node -e "console.log(JSON.stringify(process.argv.slice(1)))" 'a b' "c'd" '$HOME' ';' '*' ""`
    const argv = parseCommandLine(line)
    expect(argv).toEqual(['node', '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'a b', "c'd", '$HOME', ';', '*', ''])
    expect(parseCommandLine(formatCommandLine(argv))).toEqual(argv)
    const directory = temporary('coding folder with spaces ')
    writeFileSync(join(directory, 'file.txt'), 'x')
    const result = await runCommand(argv, { cwd: directory })
    expect(result.argv).toEqual(argv)
    expect(JSON.parse(result.stdout)).toEqual(['a b', "c'd", '$HOME', ';', '*', ''])
    expect((await runCommand(['node', '-e', 'console.log(process.cwd())'], { cwd: directory })).stdout.trim()).toBe(directory)
  })

  it('inherits the environment, lets the caller add to it, and reports non-zero exit, timeout, cancellation and a missing program', async () => {
    const cwd = temporary('coding-env-')
    process.env.DOUCHAT_HARDENING_INHERITED = 'from-parent'
    try {
      const seen = await runCommand(['node', '-e', 'console.log(process.env.DOUCHAT_HARDENING_INHERITED + "|" + process.env.DOUCHAT_HARDENING_EXTRA)'], { cwd, env: { DOUCHAT_HARDENING_EXTRA: 'added' } })
      expect(seen.stdout.trim()).toBe('from-parent|added')
    } finally { delete process.env.DOUCHAT_HARDENING_INHERITED }
    expect(await runCommand(['node', '-e', 'process.exit(7)'], { cwd })).toMatchObject({ exitCode: 7 })
    expect(await runCommand(['node', '-e', 'setInterval(() => {}, 1000)'], { cwd, timeoutMs: 200 })).toMatchObject({ timedOut: true, exitCode: null })
    const controller = new AbortController()
    const cancelled = runCommand(['node', '-e', 'setInterval(() => {}, 1000)'], { cwd, signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    expect(await cancelled).toMatchObject({ cancelled: true })
    await expect(runCommand(['no-such-program-xyz', '--flag'], { cwd })).rejects.toThrow()
    const already = new AbortController(); already.abort()
    await expect(runCommand(['node', '-v'], { cwd, signal: already.signal })).rejects.toThrow()
  }, 30_000)

  it('keeps only the end of enormous output, and stays responsive while it is produced', async () => {
    const cwd = temporary('coding-flood-')
    const result = await runCommand(['node', '-e', "for (let i = 0; i < 200000; i++) process.stdout.write('line ' + i + ' ' + 'x'.repeat(40) + '\\n'); console.error('finished')"], { cwd, maxOutput: 4096 })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.length).toBeLessThanOrEqual(4097)
    expect(result.stdout.startsWith('…')).toBe(true)
    expect(result.stdout).toContain('line 199999')
    expect(result.stderr).toBe('finished\n')
  }, 60_000)

  it('proposed → confirmed → stored → executed → persisted, and the persisted result still carries the same argv after a restart', async () => {
    const root = temporary('coding-checks-')
    const path = repository()
    const first = await boot(root)
    const agent = await scriptedAgent(first)
    const project = await first.coding.addProject(path)
    const { parseCommandLine } = await import('../../shared/coding')
    const proposed = parseCommandLine('npm test')
    // What the owner confirmed is what is stored.
    expect((await first.desktop.repository.setProjectTestCommand(project.id, proposed))!.testCommand).toEqual(['npm', 'test'])
    const session = (await first.coding.settled((await first.coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Look.', { action: 'none' }) })).id))!
    expect((await first.coding.runChecks(session.id))!.argv).toEqual(['npm', 'test'])
    await first.coding.idle()
    await shutdown(first)
    const second = await boot(root)
    expect((await second.desktop.repository.project(project.id))!.testCommand).toEqual(['npm', 'test'])
    const stored = (await second.desktop.repository.codingSession(session.id))!.commands
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ argv: ['npm', 'test'], exitCode: 1 })
  }, 60_000)
})

describe('approvals belong to one running session', () => {
  const pidfile = (): string => join(temporary('coding-appr-pids-'), 'pids')
  const started = (pids: string): Promise<void> => waitUntil(() => existsSync(pids) && readFileSync(pids, 'utf8').includes('\n'))
  const ask = (booted: Booted, agentId: string, command: string): Promise<void> => {
    const config = booted.desktop.repository.agent(agentId)
    return config.then(agent => (booted.runtime as unknown as { permissions: { authorize: (...args: unknown[]) => Promise<void> } }).permissions.authorize(agent!, {
      requester: agent!.name, requesterId: agent!.id, requesterKind: 'agent', roomName: agent!.name, context: 'direct', capability: 'otherTools',
      operation: 'Claude: Bash', details: JSON.stringify({ tool: 'Bash', input: { command } }) }, undefined, true))
  }

  it('names the agent, project, session and folder it is for, and an answer is applied once', async () => {
    const booted = await boot()
    const path = repository()
    const agent = await scriptedAgent(booted)
    const project = await booted.coding.addProject(path, 'Scoped')
    const pids = pidfile()
    const session = await booted.coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Hang.', { action: 'hang', pidfile: pids }) })
    await started(pids)
    const decision = ask(booted, agent.id, 'npm test')
    await waitUntil(() => booted.coding.activity()[0]?.state === 'awaiting-approval')
    const request = booted.coding.activity()[0].approval!
    expect(request).toMatchObject({ agentId: agent.id, codingSession: { id: session.id, projectName: 'Scoped', workingDirectory: path } })
    booted.runtime.resolveAgentPermission(request.id, true)
    await decision
    // The same answer cannot be used a second time.
    expect(() => booted.runtime.resolveAgentPermission(request.id, true)).toThrow(/no longer available/)
    await booted.coding.cancel(session.id)
  }, 60_000)

  it('is withdrawn when the session is cancelled while it waits; a late answer authorizes nothing', async () => {
    const booted = await boot()
    const path = repository()
    const agent = await scriptedAgent(booted)
    const project = await booted.coding.addProject(path)
    const pids = pidfile()
    const session = await booted.coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Hang.', { action: 'hang', pidfile: pids }) })
    await started(pids)
    const decision = ask(booted, agent.id, 'rm -rf build')
    const rejected = expect(decision).rejects.toThrow(/cancelled/)
    await waitUntil(() => booted.coding.activity()[0]?.state === 'awaiting-approval')
    const stale = booted.coding.activity()[0].approval!.id
    await booted.coding.cancel(session.id)
    await rejected
    expect(booted.runtime.ephemeralState().permissionRequests).toEqual([])
    expect(() => booted.runtime.resolveAgentPermission(stale, true)).toThrow(/no longer available/)
    await booted.coding.idle()
    expect((await booted.desktop.repository.codingSession(session.id))!.events.map(event => event.label)).toContain('Approval cancelled')
  }, 60_000)

  it('is withdrawn when the session ends by itself while a request is pending', async () => {
    const booted = await boot()
    const path = repository()
    const agent = await scriptedAgent(booted)
    const project = await booted.coding.addProject(path)
    const pids = pidfile()
    const session = await booted.coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Hang.', { action: 'hang', pidfile: pids }) })
    await started(pids)
    const decision = ask(booted, agent.id, 'npm publish')
    const rejected = expect(decision).rejects.toThrow(/cancelled/)
    await waitUntil(() => booted.coding.activity()[0]?.state === 'awaiting-approval')
    const stale = booted.coding.activity()[0].approval!.id
    // The agent process dies on its own.
    for (const pid of readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    const done = (await booted.coding.settled(session.id))!
    expect(done.status).not.toBe('running')
    await rejected
    expect(() => booted.runtime.resolveAgentPermission(stale, true)).toThrow(/no longer available/)
    expect(booted.coding.activity()).toEqual([])
  }, 60_000)

  it('does not survive an orderly shutdown, and an approval asked in one session cannot be used in the next', async () => {
    const root = temporary('coding-appr-shutdown-')
    const path = repository()
    const first = await boot(root)
    const agent = await scriptedAgent(first)
    const project = await first.coding.addProject(path)
    const pids = pidfile()
    const session = await first.coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Hang.', { action: 'hang', pidfile: pids }) })
    await started(pids)
    const decision = ask(first, agent.id, 'npm test')
    const rejected = expect(decision).rejects.toThrow(/cancelled/)
    await waitUntil(() => first.coding.activity()[0]?.state === 'awaiting-approval')
    const stale = first.coding.activity()[0].approval!.id
    await shutdown(first)
    await rejected
    const second = await boot(root)
    expect(second.runtime.ephemeralState().permissionRequests).toEqual([])
    expect(second.coding.activity()).toEqual([])
    expect(() => second.runtime.resolveAgentPermission(stale, true)).toThrow(/no longer available/)
    expect((await second.desktop.repository.codingSession(session.id))!.status).toBe('cancelled')
    // Continuing starts a new run that has to ask again.
    await second.coding.continue(session.id, taskText('Look.', { action: 'none' }))
    expect((await second.coding.settled(session.id))!.status).toBe('succeeded')
  }, 90_000)
})

describe('the process is ephemeral; the session is not', () => {
  const pidfile = (): string => join(temporary('coding-orphan-pids-'), 'pids')

  /** A crash: FeltDB stops, the agent process is left running exactly as `kill -9` on the app would leave it. */
  async function crash(booted: Booted): Promise<void> {
    void booted.coding.idle() // the abandoned turn will fail against a closed database; nobody is left to care
    await booted.desktop.repository.close()
    running.splice(running.indexOf(booted), 1)
    abandoned.push(booted)
  }
  const abandoned: Booted[] = []
  afterEach(() => { for (const booted of abandoned.splice(0)) booted.runtime.cancelAll() })

  it('after a crash the next start stops the old agent before anything else: it cannot keep changing the repository', async () => {
    const root = temporary('coding-crash-orphan-')
    const path = repository()
    const first = await boot(root)
    const agent = await scriptedAgent(first)
    const project = await first.coding.addProject(path)
    const pids = pidfile()
    const session = await first.coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Keep editing.', { action: 'mutate-forever', pidfile: pids, target: 'growing.log' }) })
    await waitUntil(() => existsSync(pids) && readFileSync(pids, 'utf8').includes('\n'))
    const pid = Number(readFileSync(pids, 'utf8').split('\n')[0])
    const log = join(path, 'growing.log')
    await waitUntil(() => existsSync(log) && readFileSync(log, 'utf8').length > 10)
    // The desktop noted the process when it started.
    for (let attempt = 0; attempt < 200 && !(await first.desktop.repository.processLedger().all()).some(row => row.pid === pid); attempt++) await new Promise(resolve => setTimeout(resolve, 20))
    expect((await first.desktop.repository.processLedger().all()).some(row => row.pid === pid && row.role === 'agent')).toBe(true)

    await crash(first)
    expect(alive(pid)).toBe(true)

    const second = await boot(root)
    expect(second.desktop.reaped.reaped.map(record => record.pid)).toContain(pid)
    await waitUntil(() => !alive(pid))
    const size = readFileSync(log, 'utf8').length
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(readFileSync(log, 'utf8').length).toBe(size)
    expect(await second.desktop.repository.processLedger().all()).toEqual([])

    // The session is interrupted, its changes kept, and Continue starts a brand-new process.
    const interrupted = (await second.desktop.repository.codingSession(session.id))!
    expect(interrupted.status).toBe('interrupted')
    expect(second.coding.activity()).toEqual([])
    expect(second.runtime.ephemeralState().permissionRequests).toEqual([])
    await second.coding.continue(session.id, taskText('Look.', { action: 'none' }))
    const again = (await second.coding.settled(session.id))!
    expect(again.status).toBe('succeeded')
  }, 90_000)

  it('leaves a process alone whose pid was reused by something else', async () => {
    const { reapOrphanedProcesses } = await import('../processLedger')
    const rows = new Map([['a', { id: 'a', pid: process.pid, role: 'agent' as const, identity: 'not-this-process', startedAt: 1 }]])
    let killed = 0
    const report = await reapOrphanedProcesses({ put: async () => undefined, remove: async id => { rows.delete(id) }, all: async () => [...rows.values()] }, () => { killed++ })
    expect(killed).toBe(0)
    expect(report).toEqual({ reaped: [], stale: 1 })
    expect(rows.size).toBe(0)
  })
})

describe('a large, dirty repository (no model involved)', () => {
  function bigRepository(): string {
    const path = temporary('coding big repo ')
    git(path, 'init', '-q', '-b', 'main'); git(path, 'config', 'user.email', 't@example.com'); git(path, 'config', 'user.name', 'T')
    for (let i = 0; i < 1200; i++) {
      const folder = join(path, 'src', `pkg ${i % 12}`, `level${i % 5}`)
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, `file ${i}.txt`), `content ${i}\n`.repeat(3))
    }
    writeFileSync(join(path, 'big.txt'), 'original line\n'.repeat(10))
    writeFileSync(join(path, 'ünïcode-名前.txt'), 'x\n')
    git(path, 'add', '-A'); git(path, 'commit', '-q', '-m', 'big initial')
    return path
  }

  it('reads status, diff and accounting correctly on 1,200 tracked files with a messy tree, quickly and boundedly', async () => {
    const booted = await boot()
    const path = bigRepository()
    expect(git(path, 'ls-files').trim().split('\n')).toHaveLength(1202)
    // Someone's work in progress: edits, a deletion, a staged rename, untracked files nested and with spaces, and a huge change.
    for (let i = 0; i < 40; i++) writeFileSync(join(path, 'src', `pkg ${i % 12}`, `level${i % 5}`, `file ${i}.txt`), `edited ${i}\n`)
    rmSync(join(path, 'src', 'pkg 1', 'level1', 'file 1.txt'))
    git(path, 'mv', join('src', 'pkg 2', 'level2', 'file 2.txt'), join('src', 'pkg 2', 'renamed file 2.txt'))
    for (let i = 0; i < 25; i++) { mkdirSync(join(path, 'scratch', `dir ${i % 3}`, 'deeper'), { recursive: true }); writeFileSync(join(path, 'scratch', `dir ${i % 3}`, 'deeper', `note ${i}.md`), `n${i}\n`) }
    writeFileSync(join(path, 'big.txt'), 'a much longer replacement line that makes the patch large\n'.repeat(60_000))
    writeFileSync(join(path, 'ünïcode-名前.txt'), 'changed\n')

    const started = Date.now()
    const state = await gitStatus(path, undefined, { fingerprints: true })
    expect(Date.now() - started).toBeLessThan(15_000)
    const byPath = new Map(state.changes.map(change => [change.path, change]))
    expect(state.changes.filter(change => change.code === '??')).toHaveLength(25)
    expect(byPath.get('src/pkg 1/level1/file 1.txt')?.code).toBe(' D')
    expect(byPath.get('src/pkg 2/renamed file 2.txt')).toMatchObject({ code: 'RM', from: 'src/pkg 2/level2/file 2.txt' })
    expect(byPath.get('ünïcode-名前.txt')?.fingerprint).toMatch(/^sha1:/)
    expect(byPath.get('big.txt')?.fingerprint).toMatch(/^sha1:/)
    expect(byPath.has('scratch/dir 1/deeper/note 1.md')).toBe(true)

    const patch = await gitDiff(path)
    expect(patch.truncated).toBe(true)
    expect(patch.diff.length).toBeLessThanOrEqual(2 * 1024 * 1024 + 1)
    expect((await gitDiff(path, { path: 'src/pkg 3/level3/file 3.txt' })).diff).toContain('+edited 3')

    // A session on top of that mess is credited only with its own two files.
    const agent = await scriptedAgent(booted)
    const project = await booted.coding.addProject(path)
    const session = (await booted.coding.settled((await booted.coding.start({ projectId: project.id, agentId: agent.id,
      task: taskText('Touch two files.', { action: 'touch', files: { 'src/pkg 0/level0/file 0.txt': 'agent edit\n', 'scratch/dir 0/deeper/agent output.md': 'new\n' } }) })).id))!
    expect(session.status).toBe('succeeded')
    expect(session.changes.filter(change => change.origin === 'session').map(change => change.path).sort()).toEqual(['scratch/dir 0/deeper/agent output.md', 'src/pkg 0/level0/file 0.txt'])
    expect(session.changes.filter(change => change.origin === 'before')).toHaveLength(state.changes.length - 1)
    expect(session.baseline.changes).toHaveLength(state.changes.length)

    // Checks: a passing one and a failing one, argv with spaces, in a folder with spaces; then cancellation.
    const passing = await booted.coding.runCommand(session.id, ['node', '-e', "process.stdout.write(require('node:fs').readdirSync('src').length + ' packages')"], { event: 'checks' })
    expect(passing).toMatchObject({ exitCode: 0, stdout: '12 packages' })
    expect(await booted.coding.runCommand(session.id, ['node', '-e', 'process.exit(4)'], { event: 'checks' })).toMatchObject({ exitCode: 4 })
    const pending = booted.coding.runCommand(session.id, ['node', '-e', 'setInterval(() => {}, 1000)'])
    setTimeout(() => { void booted.desktop.repository.updateCodingSession(session.id, { status: 'running' }); (booted.coding as unknown as { aborts: Map<string, Set<AbortController>> }).aborts.get(session.id)?.forEach(abort => abort.abort()) }, 200)
    expect(await pending).toMatchObject({ cancelled: true })
  }, 120_000)
})

async function waitUntil(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for a state change')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
