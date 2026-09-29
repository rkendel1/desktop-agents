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
    expect(session.changes).toEqual([{ path: 'src/math.js', code: ' M' }])
    expect((await coding.gitStatus(project.id)).changes).toEqual(session.changes)
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
    expect((await second.coding.gitStatus(project.id)).changes).toEqual(session.changes)
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

async function waitUntil(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for a state change')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
