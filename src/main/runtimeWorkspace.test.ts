import { openAtFile } from './testSupport'
import { agentPermissions } from '../shared/agentPermissions'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { groupMemberSessionId } from '../shared/bot/group'
import { runLocalAgent } from './localAgentRuntime'
import { DouchatRuntime } from './runtime'
import { DesktopRepository } from './desktopRepository'

vi.mock('./localAgentRuntime', async (original) => ({ ...await original<object>(), runLocalAgent: vi.fn() }))
vi.mock('./localWorkspaces', async (original) => {
  const actual = await original<typeof import('./localWorkspaces')>()
  return { ...actual, resolveSavedWorkspace: (path: string) => actual.resolveSavedWorkspace(path, { systemRoots: [] }) }
})
const directories: string[] = []
afterEach(() => { vi.clearAllMocks(); directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })) })

function setup() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'douchat-workspace-runtime-')))
  directories.push(directory)
  const project = join(directory, 'project')
  mkdirSync(project)
  const store = openAtFile(join(directory, 'state.json'))
  const runtime = new DouchatRuntime(store, { snapshots: () => [], start: vi.fn(), stop: vi.fn(), show: vi.fn(), createTools: () => [], dispose: vi.fn() }, () => undefined)
  const make = (name: string, localAgentId?: string) => store.createAgent({ name, role: 'Engineer', instructions: '', color: '#14B8A6', provider: localAgentId ? 'local' : 'anthropic', model: 'default', ...(localAgentId ? { localAgentId } : {}) })
  const codex = make('Codex', 'codex'), claude = make('Claude', 'claude'), cloud = make('Cloud')
  store.createGroup({ name: 'Builders', agentIds: [codex.id, claude.id] })
  const group = store.conversations.find(item => item.type === 'group' && item.name === 'Builders')!
  const internal = runtime as any
  const run = (agentId: string, conversationId = group.id, sessionKey = groupMemberSessionId(conversationId, agentId, 'main'), extra: object = {}) =>
    internal.runReply({ config: store.agent(agentId)!, sessionKey, conversationId, topicId: 'main', context: 'group', prompt: 'Edit files', ...extra })
  return { store, runtime, group, project, codex, claude, cloud, run }
}

it('runs group members in the chosen folder one at a time', async () => {
  const { store, group, project, codex, claude, run } = setup()
  store.setConversationWorkspace(group.id, project)
  const started: string[] = [], release = new Map<string, () => void>()
  vi.mocked(runLocalAgent).mockImplementation(async (config, prompt, _signal, _images, options) => {
    expect(options?.workspaceDirectory).toBe(project)
    expect(prompt).toContain(project)
    started.push(config.id)
    await new Promise<void>(resolve => release.set(config.id, resolve))
    return { text: config.name, images: [] }
  })
  const first = run(codex.id), second = run(claude.id)
  await vi.waitFor(() => expect(started).toEqual([codex.id]))
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(started).toEqual([codex.id])
  release.get(codex.id)!()
  expect((await first).text).toBe('Codex')
  await vi.waitFor(() => expect(started).toEqual([codex.id, claude.id]))
  release.get(claude.id)!()
  expect((await second).text).toBe('Claude')
})

it('a stopped waiter does not block the folder', async () => {
  const { runtime, store, group, project, codex, claude, run } = setup()
  store.setConversationWorkspace(group.id, project)
  const release = new Map<string, () => void>(), started: string[] = []
  vi.mocked(runLocalAgent).mockImplementation(async (config) => {
    started.push(config.id)
    await new Promise<void>(resolve => release.set(config.id, resolve))
    return { text: config.name, images: [] }
  })
  const first = run(codex.id)
  await vi.waitFor(() => expect(started).toEqual([codex.id]))
  const waiting = run(claude.id)
  await new Promise(resolve => setTimeout(resolve, 20))
  ;(runtime as any).pendingReplies.forEach((task: any) => { if (task.agentId === claude.id) task.abort.abort() })
  expect((await waiting).error).toBeTruthy()
  release.get(codex.id)!(); await first
  const again = run(claude.id)
  await vi.waitFor(() => expect(started).toEqual([codex.id, claude.id]))
  release.get(claude.id)!(); await again
})

it('keeps the chosen folder when a cloud agent joins the private group', async () => {
  const { store, group, project, codex, cloud, run } = setup()
  store.setConversationWorkspace(group.id, project)
  vi.mocked(runLocalAgent).mockResolvedValue({ text: 'ok', images: [] })
  store.updateConversation(group.id, { agentIds: [...group.agentIds, cloud.id] })
  await run(codex.id)
  expect(vi.mocked(runLocalAgent).mock.calls[0][4]?.workspaceDirectory).toBe(project)
  expect(store.conversation(group.id)?.workspacePath).toBe(project)
})

it('does not apply the folder to controllers, attendance checks or other chats', async () => {
  const { store, group, project, codex, run } = setup()
  store.setConversationWorkspace(group.id, project)
  vi.mocked(runLocalAgent).mockResolvedValue({ text: 'ok', images: [] })
  await run(codex.id, group.id, groupMemberSessionId(group.id, codex.id, 'main') + ':controller', { context: 'controller' })
  await run(codex.id, group.id, groupMemberSessionId(group.id, codex.id, 'main') + ':attendance', { toolsDisabled: true })
  await run(codex.id, `direct-${codex.id}`, `direct:direct-${codex.id}:main`, { context: 'direct' })
  await run(codex.id, group.id, `handoff:${group.id}:main:${codex.id}:caller`)
  for (const call of vi.mocked(runLocalAgent).mock.calls) expect(call[4]?.workspaceDirectory).toBeUndefined()
})

it('reports a missing folder instead of silently recreating it', async () => {
  const { store, group, project, codex, run } = setup()
  store.setConversationWorkspace(group.id, join(project, 'deleted'))
  const reply = await run(codex.id)
  expect(reply.error).toMatch(/unavailable/)
  expect(runLocalAgent).not.toHaveBeenCalled()
})

it('uses the folder for a direct chat with my local agent', async () => {
  const { store, runtime, project, codex } = setup()
  const { conversation } = store.ensureDirectConversation(codex.id)
  store.setConversationWorkspace(conversation.id, project)
  vi.mocked(runLocalAgent).mockResolvedValue({ text: 'ok', images: [] })
  await (runtime as any).runReply({ config: store.agent(codex.id)!, sessionKey: `direct:${conversation.id}:main`, conversationId: conversation.id, topicId: 'main', context: 'direct', prompt: 'hi' })
  expect(vi.mocked(runLocalAgent).mock.calls[0][4]?.workspaceDirectory).toBe(project)
})

it('lets cloud agents read and write the selected folder while enforcing permissions', async () => {
  const { store, runtime, project, cloud } = setup()
  const { conversation } = store.ensureDirectConversation(cloud.id)
  store.setConversationWorkspace(conversation.id, project)
  const permissions = agentPermissions(); permissions.sensitive.filesRead = 'allow'; permissions.sensitive.filesWrite = 'allow'
  store.updateAgent(cloud.id, { permissions })
  const internal = runtime as any, session = `direct:${conversation.id}:test`
  internal.replyCancels.set(session, { conversationId: conversation.id, abort: new AbortController() })
  internal.activeConversation.set(session, conversation.id)
  const tools = internal.artifactTools(cloud.id, session)
  const write = tools.find((tool: any) => tool.name === 'write_workspace_file')
  await write.execute('write', { path: 'hello.md', content: '# Cloud workspace' })
  expect(readFileSync(join(project, 'hello.md'), 'utf8')).toBe('# Cloud workspace')
  expect(JSON.stringify(await tools.find((tool: any) => tool.name === 'read_workspace_file').execute('read', { path: 'hello.md' }))).toContain('Cloud workspace')
  permissions.sensitive.filesWrite = 'deny'; store.updateAgent(cloud.id, { permissions })
  await expect(write.execute('write', { path: 'denied.md', content: 'no' })).rejects.toThrow('disabled')
})


it('refreshes file roots from the active conversation', () => {
  const { store, runtime, project, cloud } = setup()
  const { conversation } = store.ensureDirectConversation(cloud.id)
  const extra = join(project, 'assets'); mkdirSync(extra)
  store.setConversationWorkspace(conversation.id, project)
  store.setConversationAllowedFolders(conversation.id, [extra])
  const internal = runtime as any, session = `direct:${conversation.id}:main`
  internal.activeConversation.set(session, conversation.id)
  expect(internal.conversationFileRoots(cloud.id, session)).toEqual([])
  internal.replyCancels.set(session, { abort: new AbortController() })
  expect(internal.conversationFileRoots(cloud.id, session)).toEqual([extra, project])
  expect(internal.conversationFileRoots('other-agent', session)).toEqual([])
  store.setConversationAllowedFolders(conversation.id, [])
  expect(internal.conversationFileRoots(cloud.id, session)).toEqual([project])
})


it.each(['allow', 'decline', 'cancel'])('handles on-demand folder approval: %s', async decision => {
  const { store, runtime, project, cloud } = setup()
  const { conversation } = store.ensureDirectConversation(cloud.id)
  const internal = runtime as any, session = `direct:${conversation.id}:main`
  const abort = new AbortController()
  internal.activeConversation.set(session, conversation.id)
  internal.replyCancels.set(session, { conversationId: conversation.id, abort })
  const permissions = agentPermissions(); permissions.sensitive.filesRead = 'allow'
  store.updateAgent(cloud.id, { permissions })
  const pending = internal.requestConversationFolder(cloud.id, session, project, 'computer_list_files')
  const result = pending.then(() => 'allowed', () => 'denied')
  const request = runtime.snapshot().permissionRequests![0]
  expect(request).toBeDefined()
  expect(JSON.parse(request.details).folder).toBe(project)
  expect(store.conversation(conversation.id)?.allowedFolders).toBeUndefined()
  if (decision === 'cancel') abort.abort()
  else {
    runtime.resolveAgentPermission(request.id, decision !== 'decline')
  }
  expect(await result).toBe(decision === 'allow' ? 'allowed' : 'denied')
  expect(store.conversation(conversation.id)?.allowedFolders ?? []).toEqual(decision === 'allow' ? [project] : [])
})
