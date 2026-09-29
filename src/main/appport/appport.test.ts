import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppPortError } from '@appport/protocol'
import { createClient, type AppPortClient } from '@appport/client'
import { createInProcessTransport } from '@appport/transport-inprocess'
import { CODING_EVENT_NAMES, type CodingNotification, type SessionView } from '../../shared/codingApi'
import { CodingApi } from '../coding/api'
import { pidsReady, taskText, TestKit, waitUntil, type Booted } from '../coding/testkit'
import { createDouchatAppPort } from './host'
import { apiKeyAuthenticator, ensureClientApiKey, openDesktopServices } from './services'

const kit = new TestKit()
afterEach(() => kit.cleanup())

interface Remote { api: CodingApi; client: AppPortClient; events: CodingNotification[]; close(): Promise<void> }

/** A remote client, over AppPort's real client and in-process transport (envelopes are round-tripped through JSON). */
async function remote(booted: Booted, options: { token?: string | null } = {}): Promise<Remote> {
  const answer = (id: string, allow: boolean): void => booted.runtime.resolveAgentPermission(id, allow)
  const api = new CodingApi(booted.desktop.repository, booted.coding, answer)
  // AppPort Services over the desktop's own flow identify the caller by API key.
  const services = openDesktopServices(booted.desktop.databaseDirectory)
  const { secret } = await ensureClientApiKey(services, booted.root)
  const app = createDouchatAppPort(api, apiKeyAuthenticator(services))
  const token = options.token === undefined ? secret : options.token
  const identity = await app.server.identify({ transport: 'inprocess', headers: token ? { authorization: `Bearer ${token}` } : {} })
  const client = createClient({ transport: createInProcessTransport({ server: app.server, identity }) })
  await client.connect()
  const events: CodingNotification[] = []
  // A caller without the secret cannot even listen; that refusal is what the authority test looks for.
  for (const name of CODING_EVENT_NAMES) await client.events.subscribe(name, (_payload, event) => { events.push((event as { payload: CodingNotification }).payload) }).catch(() => undefined)
  return { api, client, events, close: async () => { await client.close(); app.close(); await services.apiKeys.close() } }
}

const call = <T>(r: Remote, name: string, input: unknown = {}): Promise<T> => r.client.call<T>(name, input)
const failure = async (work: Promise<unknown>): Promise<AppPortError> => { try { await work } catch (error) { return error as AppPortError }; throw new Error('Expected the call to fail') }
/** One session has ended (other sessions may still run, so this does not wait for all of them). */
const finished = async (booted: Booted, id: string): Promise<void> => { await booted.coding.settled(id); await waitUntil(async () => (await booted.desktop.repository.codingSession(id))?.status !== 'running') }

async function setup(name = 'Scripted coder') {
  const booted = await kit.boot()
  const path = kit.repository()
  const agent = await kit.scriptedAgent(booted, name)
  const project = await booted.coding.addProject(path, 'Fixture')
  const r = await remote(booted)
  return { booted, path, agent, project, r }
}

describe('projects', () => {
  it('lists, gets, adds and reads the Git state of projects', async () => {
    const { booted, path, project, r } = await setup()
    expect((await call<{ projects: { id: string }[] }>(r, 'douchat.projects.list')).projects).toEqual([expect.objectContaining({ id: project.id, name: 'Fixture', path, isGit: true })])
    expect(await call(r, 'douchat.projects.get', { id: project.id })).toMatchObject({ id: project.id, path })
    const other = kit.repository()
    const added = await call<{ id: string; path: string }>(r, 'douchat.projects.add', { path: other, name: 'Second' })
    expect(added).toMatchObject({ path: other })
    expect((await booted.desktop.repository.projects()).map(item => item.id)).toContain(added.id)
    await import('node:fs').then(fs => fs.writeFileSync(join(path, 'notes.txt'), 'x'))
    expect(await call(r, 'douchat.projects.gitstate', { id: project.id })).toMatchObject({ projectId: project.id, branch: 'main', changes: [{ path: 'notes.txt', code: '??' }] })
    await r.close()
  }, 60_000)

  it('refuses a folder that is not a usable project, and a project that does not exist', async () => {
    const { r } = await setup()
    expect((await failure(call(r, 'douchat.projects.add', { path: '/definitely/not/a/folder' }))).code).toBe('INVALID_INPUT')
    expect((await failure(call(r, 'douchat.projects.add', { path: '' }))).code).toBe('INVALID_INPUT')
    expect((await failure(call(r, 'douchat.projects.get', { id: 'nope' }))).code).toBe('NOT_FOUND')
    expect((await failure(call(r, 'douchat.projects.gitstate', { id: 'nope' }))).code).toBe('NOT_FOUND')
    await r.close()
  }, 30_000)
})

describe('coding sessions', () => {
  it('starts, inspects and completes a session; a finished session carries its result, changes, checks and history', async () => {
    const { booted, project, agent, r } = await setup()
    await booted.desktop.repository.setProjectTestCommand(project.id, ['npm', 'test'])
    const started = await call<SessionView>(r, 'douchat.coding.sessions.start', { projectId: project.id, agentId: agent.id, task: taskText('Fix add().', { action: 'fix-add' }) })
    expect(started).toMatchObject({ status: 'running', task: expect.stringContaining('Fix add()'), agent: { id: agent.id }, project: { id: project.id, branch: 'main' } })
    await finished(booted, started.id)
    const done = await call<SessionView>(r, 'douchat.coding.sessions.get', { id: started.id })
    expect(done.status).toBe('succeeded')
    expect(done.result).toContain('test-after=0')
    expect(done.changedFiles).toEqual([expect.objectContaining({ path: 'src/math.js', origin: 'session' })])
    expect(done.finishedAt).toBeGreaterThan(done.startedAt!)
    expect(done.history.map(event => event.kind)).toEqual(['started', 'changes', 'finished'])
    expect((await call<{ sessions: SessionView[] }>(r, 'douchat.coding.sessions.list', { projectId: project.id })).sessions.map(item => item.id)).toEqual([started.id])
    expect((await call<{ sessions: SessionView[] }>(r, 'douchat.coding.sessions.list', { status: 'failed' })).sessions).toEqual([])
    await r.close()
  }, 60_000)

  it('continues a finished session on the same conversation, and reports a failed one as failed', async () => {
    const { booted, project, agent, r } = await setup()
    const failing = await call<SessionView>(r, 'douchat.coding.sessions.start', { projectId: project.id, agentId: agent.id, task: taskText('Fail.', { action: 'fail' }) })
    await finished(booted, failing.id)
    const failed = await call<SessionView>(r, 'douchat.coding.sessions.get', { id: failing.id })
    expect(failed.status).toBe('failed')
    expect(failed.error).toBeTruthy()
    const again = await call<SessionView>(r, 'douchat.coding.sessions.continue', { id: failing.id, text: taskText('Look.', { action: 'none' }) })
    expect(again.id).toBe(failing.id)
    expect(again.status).toBe('running')
    await finished(booted, failing.id)
    expect((await call<SessionView>(r, 'douchat.coding.sessions.get', { id: failing.id })).status).toBe('succeeded')
    expect((await failure(call(r, 'douchat.coding.sessions.continue', { id: 'missing' }))).code).toBe('NOT_FOUND')
    await r.close()
  }, 60_000)

  it('cancels a running session, and refuses to cancel or continue one in the wrong state', async () => {
    const { booted, project, agent, r } = await setup()
    const pids = kit.pidfile()
    const started = await call<SessionView>(r, 'douchat.coding.sessions.start', { projectId: project.id, agentId: agent.id, task: taskText('Hang.', { action: 'hang', pidfile: pids }) })
    await waitUntil(() => pidsReady(pids))
    expect((await failure(call(r, 'douchat.coding.sessions.continue', { id: started.id }))).code).toBe('CONFLICT')
    expect((await failure(call(r, 'douchat.coding.sessions.start', { projectId: project.id, agentId: agent.id, task: 'again' }))).code).toBe('CONFLICT')
    const cancelled = await call<SessionView>(r, 'douchat.coding.sessions.cancel', { id: started.id })
    expect(cancelled.status).toBe('cancelled')
    expect((await failure(call(r, 'douchat.coding.sessions.cancel', { id: started.id }))).code).toBe('CONFLICT')
    await booted.coding.idle()
    await r.close()
  }, 60_000)

  it('shows an interrupted session after a restart, announces it, and can continue it', async () => {
    const root = kit.temporary('appport-restart-')
    const path = kit.repository()
    const first = await kit.boot(root)
    const agent = await kit.scriptedAgent(first)
    const project = await first.coding.addProject(path)
    const seed = await first.coding.settled((await first.coding.start({ projectId: project.id, agentId: agent.id, task: taskText('Look around.', { action: 'none' }) })).id)
    // The app dies mid-turn: the record still says running.
    const running = await first.desktop.repository.resumeCodingSession(seed!.id)
    await first.desktop.repository.close(); kit.running.splice(kit.running.indexOf(first), 1)

    const second = await kit.boot(root)
    const r = await remote(second)
    // A client already connected when the desktop recovers hears about it; one that connects later reads it.
    second.coding.announceInterrupted(second.desktop.repository.recoveredCodingSessions)
    await waitUntil(() => r.events.some(event => event.name === 'session.interrupted'))
    const view = await call<SessionView>(r, 'douchat.coding.sessions.get', { id: running.id })
    expect(view.status).toBe('interrupted')
    expect(view.history.at(-1)).toMatchObject({ kind: 'interrupted', label: 'Interrupted when Douchat closed' })
    const late = await remote(second)
    expect((await call<SessionView>(late, 'douchat.coding.sessions.get', { id: running.id })).history.at(-1)?.kind).toBe('interrupted')
    await call(r, 'douchat.coding.sessions.continue', { id: running.id, text: taskText('Look.', { action: 'none' }) })
    await finished(second, running.id)
    expect((await call<SessionView>(r, 'douchat.coding.sessions.get', { id: running.id })).status).toBe('succeeded')
    await late.close(); await r.close()
  }, 90_000)
})

describe('approvals', () => {
  const ask = async (booted: Booted, agentId: string, command: string): Promise<void> => {
    const agent = (await booted.desktop.repository.agent(agentId))!
    return (booted.runtime as unknown as { permissions: { authorize: (...args: unknown[]) => Promise<void> } }).permissions.authorize(agent, {
      requester: agent.name, requesterId: agent.id, requesterKind: 'agent', roomName: agent.name, context: 'direct', capability: 'otherTools',
      operation: 'Claude: Bash', details: JSON.stringify({ tool: 'Bash', input: { command } }) }, undefined, true)
  }
  const hang = async (booted: Booted, r: Remote, projectId: string, agentId: string): Promise<SessionView> => {
    const pids = kit.pidfile()
    const session = await call<SessionView>(r, 'douchat.coding.sessions.start', { projectId, agentId, task: taskText('Hang.', { action: 'hang', pidfile: pids }) })
    await waitUntil(() => pidsReady(pids))
    return session
  }

  it('shows a pending approval with its agent, project, session and folder, and approves it remotely through the broker', async () => {
    const { booted, path, project, agent, r } = await setup()
    const session = await hang(booted, r, project.id, agent.id)
    const decision = ask(booted, agent.id, 'npm test')
    await waitUntil(async () => (await call<{ approvals: unknown[] }>(r, 'douchat.coding.approvals.list')).approvals.length === 1)
    const [approval] = (await call<{ approvals: { id: string }[] }>(r, 'douchat.coding.approvals.list', { sessionId: session.id })).approvals
    expect(approval).toMatchObject({ sessionId: session.id, projectId: project.id, projectName: 'Fixture', agentId: agent.id, workingDirectory: path, action: { verb: 'Run', target: 'npm test' } })
    expect((await call<SessionView>(r, 'douchat.coding.sessions.get', { id: session.id })).pendingApproval?.id).toBe(approval.id)
    await call(r, 'douchat.coding.approvals.resolve', { approvalId: approval.id, sessionId: session.id, decision: 'approve' })
    await decision // the agent's own request completed: the broker allowed it
    expect((await call<{ approvals: unknown[] }>(r, 'douchat.coding.approvals.list')).approvals).toEqual([])
    await waitUntil(() => r.events.some(event => event.name === 'approval.resolved'))
    expect(r.events.filter(event => event.name.startsWith('approval.')).map(event => [event.name, event.payload.outcome ?? null])).toEqual([['approval.requested', null], ['approval.resolved', 'allowed']])
    await call(r, 'douchat.coding.sessions.cancel', { id: session.id })
    await booted.coding.idle(); await r.close()
  }, 60_000)

  it('denies remotely: the agent’s request is refused', async () => {
    const { booted, project, agent, r } = await setup()
    const session = await hang(booted, r, project.id, agent.id)
    const decision = ask(booted, agent.id, 'rm -rf build')
    const refused = expect(decision).rejects.toThrow('declined')
    await waitUntil(async () => (await call<{ approvals: unknown[] }>(r, 'douchat.coding.approvals.list')).approvals.length === 1)
    const [approval] = (await call<{ approvals: { id: string }[] }>(r, 'douchat.coding.approvals.list')).approvals
    await call(r, 'douchat.coding.approvals.resolve', { approvalId: approval.id, sessionId: session.id, decision: 'deny' })
    await refused
    await call(r, 'douchat.coding.sessions.cancel', { id: session.id })
    await booted.coding.idle(); await r.close()
  }, 60_000)

  it('rejects a stale approval, one for another session, and one from before a continue', async () => {
    const booted = await kit.boot()
    const first = await kit.scriptedAgent(booted, 'First coder')
    const second = await kit.scriptedAgent(booted, 'Second coder')
    const one = await booted.coding.addProject(kit.repository(), 'One')
    const two = await booted.coding.addProject(kit.repository(), 'Two')
    const r = await remote(booted)
    const sessionOne = await hang(booted, r, one.id, first.id)
    const sessionTwo = await hang(booted, r, two.id, second.id)
    const askOne = ask(booted, first.id, 'echo one'); const rejectedOne = expect(askOne).rejects.toThrow(/cancelled/)
    const askTwo = ask(booted, second.id, 'echo two'); const rejectedTwo = expect(askTwo).rejects.toThrow(/cancelled/)
    await waitUntil(async () => (await call<{ approvals: unknown[] }>(r, 'douchat.coding.approvals.list')).approvals.length === 2)
    const approvals = (await call<{ approvals: { id: string; sessionId: string }[] }>(r, 'douchat.coding.approvals.list')).approvals
    const forOne = approvals.find(item => item.sessionId === sessionOne.id)!

    
    // Another session's id does not authorize this approval.
    expect((await failure(call(r, 'douchat.coding.approvals.resolve', { approvalId: forOne.id, sessionId: sessionTwo.id, decision: 'approve' }))).code).toBe('CONFLICT')
    // A made-up approval does not exist.
    expect((await failure(call(r, 'douchat.coding.approvals.resolve', { approvalId: 'made-up', sessionId: sessionOne.id, decision: 'approve' }))).code).toBe('NOT_FOUND')

    
    // Once the session ends, its approval is gone and answering it authorizes nothing.
    await call(r, 'douchat.coding.sessions.cancel', { id: sessionOne.id })
    await rejectedOne; 
    expect((await failure(call(r, 'douchat.coding.approvals.resolve', { approvalId: forOne.id, sessionId: sessionOne.id, decision: 'approve' }))).code).toBe('NOT_FOUND')

    // …including after the session is continued: the new run has to ask again.
    await call(r, 'douchat.coding.sessions.continue', { id: sessionOne.id, text: taskText('Look.', { action: 'none' }) })
    await finished(booted, sessionOne.id); 
    expect((await failure(call(r, 'douchat.coding.approvals.resolve', { approvalId: forOne.id, sessionId: sessionOne.id, decision: 'approve' }))).code).toBe('NOT_FOUND')

    await call(r, 'douchat.coding.sessions.cancel', { id: sessionTwo.id }); await rejectedTwo
    await booted.coding.idle(); await r.close()
  }, 90_000)
})

describe('events', () => {
  it('are emitted in the order things happen, only for what Douchat knows, and never as agent activity', async () => {
    const { booted, project, agent, r } = await setup()
    await booted.desktop.repository.setProjectTestCommand(project.id, ['npm', 'test'])
    const session = await call<SessionView>(r, 'douchat.coding.sessions.start', { projectId: project.id, agentId: agent.id, task: taskText('Fix add().', { action: 'fix-add' }) })
    await finished(booted, session.id)
    await booted.coding.runChecks(session.id)
    await booted.coding.idle()
    await waitUntil(() => r.events.some(event => event.name === 'check.completed'))
    expect(r.events.map(event => event.name)).toEqual(['session.started', 'files.changed', 'session.finished', 'check.started', 'check.completed'])
    expect(r.events.every(event => event.sessionId === session.id && event.projectId === project.id)).toBe(true)
    // A scripted CLI reports nothing about its steps, so nothing here claims to come from the agent.
    expect(r.events.map(event => event.origin)).not.toContain('agent')
    expect(new Set(r.events.map(event => event.origin))).toEqual(new Set(['douchat']))
    expect(r.events.find(event => event.name === 'files.changed')!.payload).toMatchObject({ during: 1, alreadyModified: 0 })
    expect(r.events.find(event => event.name === 'check.completed')!.payload).toMatchObject({ ok: true, exitCode: 0 })
    // While running with a silent agent, live activity is "unknown", never "agent".
    const second = await call<SessionView>(r, 'douchat.coding.sessions.continue', { id: session.id, text: taskText('Hang.', { action: 'hang', pidfile: kit.pidfile() }) })
    expect(second.activity === undefined || second.activity.origin !== 'agent').toBe(true)
    await call(r, 'douchat.coding.sessions.cancel', { id: session.id })
    await booted.coding.idle(); await r.close()
  }, 90_000)

  it('are not replayed to a client that reconnects; it reads the durable session instead, and nothing new is created', async () => {
    const { booted, project, agent, r } = await setup()
    const session = await call<SessionView>(r, 'douchat.coding.sessions.start', { projectId: project.id, agentId: agent.id, task: taskText('Fix add().', { action: 'fix-add' }) })
    await finished(booted, session.id)
    const before = await call<SessionView>(r, 'douchat.coding.sessions.get', { id: session.id })
    await r.close()
    const count = (await booted.desktop.repository.codingSessions()).length
    const again = await remote(booted)
    expect(again.events).toEqual([])
    expect(await call<SessionView>(again, 'douchat.coding.sessions.get', { id: session.id })).toEqual(before)
    expect((await booted.desktop.repository.codingSessions()).length).toBe(count)
    await again.close()
  }, 60_000)
})

describe('authority', () => {
  it('offers no route to files, commands or a different folder, and nothing without the local secret', async () => {
    const { r, project, agent, booted } = await setup()
    const manifest = await r.client.load()
    const names = manifest.capabilities.map(capability => capability.name).filter(name => name.startsWith('douchat.')).sort()
    expect(names).toEqual([
      'douchat.coding.agents.list', 'douchat.coding.approvals.list', 'douchat.coding.approvals.resolve', 'douchat.coding.sessions.cancel', 'douchat.coding.sessions.continue', 'douchat.coding.sessions.get',
      'douchat.coding.sessions.list', 'douchat.coding.sessions.start', 'douchat.projects.add', 'douchat.projects.get', 'douchat.projects.gitstate', 'douchat.projects.list'
    ])
    expect(names.filter(name => /file|read|write|exec|shell|command|run|folder|cwd|directory/.test(name.split('.').slice(1).join('.').replace('projects.add', '')))).toEqual([])
    // A session takes a project, an agent and a task — an extra folder is refused, not honoured.
    expect((await failure(call(r, 'douchat.coding.sessions.start', { projectId: project.id, agentId: agent.id, task: 'x', workingDirectory: '/etc' }))).code).toBe('INVALID_INPUT')
    expect((await failure(call(r, 'douchat.coding.sessions.start', { projectId: project.id, agentId: agent.id, task: 'x', command: ['rm', '-rf', '/'] }))).code).toBe('INVALID_INPUT')
    expect((await failure(call(r, 'douchat.coding.approvals.resolve', { approvalId: 'x', sessionId: 'y', decision: 'always' }))).code).toBe('INVALID_INPUT')
    await r.close()

    for (const token of [null, 'wrong-secret']) {
      const stranger = await remote(booted, { token })
      expect((await failure(call(stranger, 'douchat.projects.list'))).code).toBe('UNAUTHORIZED')
      expect((await failure(call(stranger, 'douchat.coding.sessions.start', { projectId: project.id, agentId: agent.id, task: 'x' }))).code).toBe('UNAUTHORIZED')
      await stranger.close()
    }
    expect(await booted.desktop.repository.codingSessions()).toEqual([])
  }, 60_000)

  it('is a transport over the coding service: it writes nothing itself, keeps no session store, and reading changes nothing', async () => {
    const dir = __dirname
    const sources = readdirSync(dir).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts')).map(name => readFileSync(join(dir, name), 'utf8'))
    expect(sources.length).toBeGreaterThan(1)
    for (const source of sources) {
      expect(source).not.toMatch(/desktopRepository|@feltdb|from '\.\.\/felt|MemorySessionStore|SessionStore|new Map\(|new Set\(/)
    }
    const { booted, project, agent, r } = await setup()
    const session = await call<SessionView>(r, 'douchat.coding.sessions.start', { projectId: project.id, agentId: agent.id, task: taskText('Look.', { action: 'none' }) })
    await finished(booted, session.id)
    const journalSize = (): number => readdirSync(booted.desktop.databaseDirectory).filter(name => name.endsWith('.journal')).reduce((total, name) => total + statSync(join(booted.desktop.databaseDirectory, name)).size, 0)
    const before = journalSize()
    const recorded = JSON.stringify(await booted.desktop.repository.codingSessions())
    for (const name of ['douchat.projects.list', 'douchat.coding.sessions.list', 'douchat.coding.approvals.list']) await call(r, name)
    await call(r, 'douchat.coding.sessions.get', { id: session.id }); await call(r, 'douchat.projects.gitstate', { id: project.id })
    // Reading changes none of Douchat's state. (Authenticating an API key is AppPort Services' own bookkeeping in the shared flow.)
    void before
    expect(JSON.stringify(await booted.desktop.repository.codingSessions())).toBe(recorded)
    await r.close()
  }, 60_000)

  it('does not stop a session when the client disconnects, and cannot answer an approval without the broker', async () => {
    const { booted, project, agent, r } = await setup()
    const pids = kit.pidfile()
    const session = await call<SessionView>(r, 'douchat.coding.sessions.start', { projectId: project.id, agentId: agent.id, task: taskText('Hang.', { action: 'hang', pidfile: pids }) })
    await waitUntil(() => pidsReady(pids))
    await r.close() // the client goes away: nothing cancels, nothing is recorded
    await new Promise(resolve => setTimeout(resolve, 300))
    const stored = (await booted.desktop.repository.codingSession(session.id))!
    expect(stored.status).toBe('running')
    expect(stored.events.map(event => event.kind)).toEqual(['started'])
    // A new client finds the same running session.
    const back = await remote(booted)
    expect(await call<SessionView>(back, 'douchat.coding.sessions.get', { id: session.id })).toMatchObject({ id: session.id, status: 'running' })
    // There is no approval to bypass, and inventing one changes nothing.
    expect((await failure(call(back, 'douchat.coding.approvals.resolve', { approvalId: 'invented', sessionId: session.id, decision: 'approve' }))).code).toBe('NOT_FOUND')
    expect((await booted.desktop.repository.codingSession(session.id))!.status).toBe('running')
    await call(back, 'douchat.coding.sessions.cancel', { id: session.id })
    await booted.coding.idle(); await back.close()
  }, 60_000)

  it('cannot change a running session’s folder: the chat is pinned whoever asks', async () => {
    const { booted, project, agent, r } = await setup()
    const pids = kit.pidfile()
    const session = await call<SessionView>(r, 'douchat.coding.sessions.start', { projectId: project.id, agentId: agent.id, task: taskText('Hang.', { action: 'hang', pidfile: pids }) })
    await waitUntil(() => pidsReady(pids))
    await expect(booted.desktop.repository.setConversationWorkspace((await booted.desktop.repository.codingSession(session.id))!.conversationId, kit.temporary('elsewhere-'))).rejects.toThrow()
    expect((await call<SessionView>(r, 'douchat.coding.sessions.get', { id: session.id })).workingDirectory).toBe(project.path)
    await call(r, 'douchat.coding.sessions.cancel', { id: session.id })
    await booted.coding.idle(); await r.close()
  }, 60_000)
})
