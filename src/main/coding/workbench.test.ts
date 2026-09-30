import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const PAX = findBinary('pax')
import { ComputeClient } from '../compute/client'
import { CiService } from '../ci/service'
import { findBinary } from '../compute/testkit'
import { TestKit, taskText, waitUntil } from './testkit'

const kit = new TestKit()
afterEach(() => kit.cleanup())

/** A project with an upstream: a bare remote the working copy tracks, so Git can say ahead/behind. */
function tracked(): { path: string; remote: string } {
  const path = kit.repository()
  const remote = kit.temporary('coding-remote-')
  kit.git(remote, 'init', '-q', '--bare', '-b', 'main')
  kit.git(path, 'remote', 'add', 'origin', remote)
  kit.git(path, 'push', '-q', '-u', 'origin', 'main')
  return { path, remote }
}

describe('the developer’s Git workflow, on the project’s own folder', () => {
  it('reads the branch, its upstream and how far ahead or behind it is, from Git', async () => {
    const { path } = tracked()
    const booted = await kit.boot()
    const project = await booted.coding.addProject(path)
    expect(await booted.coding.gitStatus(project.id)).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0 })
    writeFileSync(join(path, 'a.txt'), 'a\n'); kit.git(path, 'add', '-A'); kit.git(path, 'commit', '-q', '-m', 'local')
    expect(await booted.coding.gitStatus(project.id)).toMatchObject({ ahead: 1, behind: 0 })
    // Someone else pushes: Git reports behind once it has fetched.
    const other = kit.temporary('coding-other-')
    kit.git(other, 'clone', '-q', kit.git(path, 'remote', 'get-url', 'origin').trim(), '.')
    kit.git(other, 'config', 'user.email', 'o@example.com'); kit.git(other, 'config', 'user.name', 'O')
    writeFileSync(join(other, 'b.txt'), 'b\n'); kit.git(other, 'add', '-A'); kit.git(other, 'commit', '-q', '-m', 'theirs'); kit.git(other, 'push', '-q')
    kit.git(path, 'fetch', '-q')
    expect(await booted.coding.gitStatus(project.id)).toMatchObject({ ahead: 1, behind: 1 })
  })

  it('has no upstream to compare with when the branch tracks nothing', async () => {
    const booted = await kit.boot()
    const project = await booted.coding.addProject(kit.repository())
    const state = await booted.coding.gitStatus(project.id)
    expect(state.upstream).toBeUndefined(); expect(state.ahead).toBeUndefined()
  })

  it('stages, unstages and commits exactly what Git lists, and shows staged and unstaged diffs apart', async () => {
    const path = kit.repository()
    const booted = await kit.boot()
    const project = await booted.coding.addProject(path)
    const before = (await booted.coding.gitStatus(project.id)).head
    writeFileSync(join(path, 'src', 'math.js'), 'function add(a, b) {\n  return a + b\n}\nmodule.exports = { add }\n')
    writeFileSync(join(path, 'notes.txt'), 'notes\n')

    expect((await booted.coding.gitStage(project.id, ['src/math.js'])).changes.find(item => item.path === 'src/math.js')?.code).toBe('M ')
    // Staged and unstaged are different questions with different answers.
    writeFileSync(join(path, 'src', 'math.js'), 'function add(a, b) {\n  return a + b // later\n}\nmodule.exports = { add }\n')
    expect((await booted.coding.gitDiff(project.id, 'src/math.js', undefined, 'staged')).diff).toContain('+  return a + b\n')
    expect((await booted.coding.gitDiff(project.id, 'src/math.js', undefined, 'staged')).diff).not.toContain('// later')
    expect((await booted.coding.gitDiff(project.id, 'src/math.js', undefined, 'unstaged')).diff).toContain('// later')
    expect((await booted.coding.gitDiff(project.id, 'src/math.js')).diff).toContain('// later')

    const unstaged = await booted.coding.gitUnstage(project.id, ['src/math.js'])
    expect(unstaged.changes.find(item => item.path === 'src/math.js')?.code).toBe(' M')
    await booted.coding.gitStage(project.id, ['src/math.js'])
    const committed = await booted.coding.gitCommit(project.id, 'Fix add()\n\nIt subtracted.')
    // Only what was staged was committed; the untracked file was not swept in.
    expect(kit.git(path, 'show', '--stat', '--format=%s', 'HEAD')).toContain('src/math.js')
    expect(kit.git(path, 'show', '--stat', '--format=', 'HEAD')).not.toContain('notes.txt')
    expect(committed.commit).not.toBe(before)
    expect(committed.summary).toBe('Fix add()')
    expect(committed.state.changes.map(item => [item.path, item.code])).toEqual([['notes.txt', '??']])
    expect(kit.git(path, 'show', 'HEAD', '--', 'src/math.js')).toContain('// later')
    expect(kit.git(path, 'log', '-1', '--format=%B').trim()).toBe('Fix add()\n\nIt subtracted.')
  })

  it('refuses what Git does not show, an empty message, nothing staged, and a message that would be shell text', async () => {
    const path = kit.repository()
    const booted = await kit.boot()
    const project = await booted.coding.addProject(path)
    await expect(booted.coding.gitStage(project.id, ['package.json'])).rejects.toThrow(/no change to package.json/)
    await expect(booted.coding.gitStage(project.id, ['../etc/passwd'])).rejects.toThrow(/no change/)
    await expect(booted.coding.gitStage(project.id, [])).rejects.toThrow(/at least one file/)
    writeFileSync(join(path, 'x.txt'), 'x\n')
    await expect(booted.coding.gitCommit(project.id, 'nothing staged')).rejects.toThrow(/Nothing is staged/)
    await booted.coding.gitStage(project.id, ['x.txt'])
    await expect(booted.coding.gitCommit(project.id, '   ')).rejects.toThrow(/commit message/)
    await booted.coding.gitCommit(project.id, '$(touch pwned); `touch pwned2` "quoted" \'single\'')
    expect(kit.git(path, 'log', '-1', '--format=%s').trim()).toBe('$(touch pwned); `touch pwned2` "quoted" \'single\'')
    expect(kit.git(path, 'status', '--porcelain')).toBe('')
  })

  it('will not stage or commit under a running coding session', async () => {
    const path = kit.repository()
    const booted = await kit.boot()
    const agent = await kit.scriptedAgent(booted)
    const project = await booted.coding.addProject(path)
    writeFileSync(join(path, 'x.txt'), 'x\n')
    const session = await booted.coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Hold.', { action: 'hang' }) })
    await expect(booted.coding.gitStage(project.id, ['x.txt'])).rejects.toThrow(/coding session is running/)
    await expect(booted.coding.gitCommit(project.id, 'x')).rejects.toThrow(/coding session is running/)
    await booted.coding.cancel(session.id); await booted.coding.settled(session.id)
    await waitUntil(async () => (await booted.desktop.repository.codingSession(session.id))?.status === 'cancelled')
    await booted.coding.gitStage(project.id, ['x.txt'])
  }, 60_000)
})

describe('choosing where the agent runs', () => {
  it('keeps the default local, and needs neither Compute nor a network', async () => {
    const booted = await kit.boot()   // no Compute client at all
    const agent = await kit.scriptedAgent(booted)
    const project = await booted.coding.addProject(kit.repository())
    const started = await booted.coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Fix add().', { action: 'fix-add' }) })
    expect(started.execution).toBeUndefined()
    const done = (await booted.coding.settled(started.id))!
    expect(done.status).toBe('succeeded')
    expect(done.changes.map(item => item.path)).toEqual(['src/math.js'])
  }, 60_000)

  it.each([
    ['Compute is not in this build', undefined],
    ['Compute Configured is not installed', new ComputeClient({ binary: '/nonexistent/compute-configured', daemon: 'http://127.0.0.1:9' })]
  ])('an explicit Compute choice is refused when %s — nothing starts here instead', async (_name, compute) => {
    const booted = await kit.boot(undefined, compute ? { compute } : {})
    const agent = await kit.scriptedAgent(booted)
    const project = await booted.coding.addProject(kit.repository())
    await expect(booted.coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Fix add().', { action: 'fix-add' }), execution: { kind: 'compute', environment: 'workbench' } }))
      .rejects.toThrow(/Compute was selected, so nothing was started on this computer/)
    expect(await booted.desktop.repository.codingSessions()).toEqual([])
    expect((await booted.desktop.repository.processLedger().all()).filter(row => row.role === 'agent')).toEqual([])
    expect(readFileSync(join(project.path, 'src', 'math.js'), 'utf8')).toContain('a - b')
  }, 60_000)
})

describe('project tooling is PAX’s to say', () => {
  it.skipIf(!PAX)('reads PAX’s info and drift for the project folder, offline, and keeps ambiguity ambiguous', async () => {
    const path = kit.repository()
    writeFileSync(join(path, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { '': { name: 'fixture' } } }))
    const booted = await kit.boot(undefined, { pax: PAX })
    const project = await booted.coding.addProject(path)
    const info = await booted.coding.paxProject(project.id, 'info')
    expect(info.exitCode).toBe(0)
    expect((info.json as { manager: { name: string } }).manager.name).toBe('npm')
    writeFileSync(join(path, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    const drift = await booted.coding.paxProject(project.id, 'drift')
    expect(drift.findings.ambiguous).toBe(true)
    // Asking changed nothing.
    expect(kit.git(path, 'status', '--porcelain').trim().split('\n').sort()).toEqual(['?? package-lock.json', '?? pnpm-lock.yaml'])
  })

  it('says plainly that PAX is missing rather than failing the workbench', async () => {
    const booted = await kit.boot(undefined, { pax: '/nonexistent/pax' })
    const project = await booted.coding.addProject(kit.repository())
    await expect(booted.coding.paxProject(project.id, 'info')).rejects.toThrow('PAX is not installed, so project tooling is not shown.')
  })
})

describe('the workbench without PAX, Compute or a network', () => {
  it('explains what CI needs instead of failing, while local coding stays fully available', async () => {
    const booted = await kit.boot(undefined, { pax: '/nonexistent/pax' })
    const project = await booted.coding.addProject(kit.repository())
    const plan = await new CiService(booted.desktop.repository, { pax: '/nonexistent/pax' }).plan(project.id)
    expect(plan.ready).toBe(false)
    expect(plan.blockers).toEqual(expect.arrayContaining(['Compute is not available in this build.', expect.stringContaining('PAX is not installed')]))
    expect((await booted.coding.gitStatus(project.id)).branch).toBe('main')
  })
})
