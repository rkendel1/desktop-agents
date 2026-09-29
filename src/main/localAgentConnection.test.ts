import { memoryBindings } from './testSupport'
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { listLocalAgentModels, cancelLocalModelQueries } from './localAgentModels'
import { LocalAgentConnection } from './localAgentConnection'
import { runLocalAgent, disposeLocalAgentSessions, resetLocalAgentConversation } from './localAgentRuntime'
import { validateLocalAgent } from './localAgents'
import { configureLocalWorkspaces } from './localWorkspaces'
import { changedLocalAgentSettings } from './localAgentSettingsVersion'
import type { AgentConfig } from '../shared/types'
const bindings = memoryBindings()
vi.mock('./localAgents', () => ({ validateLocalAgent: vi.fn() }))
vi.mock('./shellPath', () => ({ spawnEnvironment: async () => ({ ...process.env, ANTHROPIC_API_KEY: 'test-conflict' }) }))
vi.mock('./windowsCommand', () => ({ executableCommand: async (file: string) => ({ file: process.execPath, prefix: [file] }) }))
let directory: string
let script: string
const config: AgentConfig = { id: 'pooled-test', name: 'Test', role: '', instructions: '', color: '', provider: 'local', model: 'default', localAgentId: 'codex', createdAt: 0 }
const children: LocalAgentConnection[] = []
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'douchat-protocol-test-'))
  script = join(directory, 'fake.cjs')
  await writeFile(script, `
if(process.argv[2]==='one-shot'){process.stdout.write('one-shot');process.exit(0);}
const readline=require('node:readline');
let count=0;let model;let approvalPolicy;let threadId='thread-'+process.pid;
const resumeIndex=process.argv.indexOf('--resume');
if(resumeIndex>=0){threadId=process.argv[resumeIndex+1];count=1;}
const argvModel=process.argv.indexOf('--model');
const send=p=>process.stdout.write(JSON.stringify(p)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const p=JSON.parse(line);
 if(p.id===999 && !p.method) {
  send({method:'item/completed',params:{threadId,item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify({approval:p.result,approvalPolicy})}}});
  send({method:'turn/completed',params:{threadId,turn:{status:'completed'}}});return;
 }
 if(p.type==='control_response') {send({type:'result',result:JSON.stringify(p.response.response)});return;}
 if(p.type==='control_request') {send({type:'control_response',response:{subtype:'success',request_id:p.request_id,response:{models:[{value:'test-model',displayName:'Test model'}]}}});return;}
 if(p.method==='initialize') send({id:p.id,result:{}});
 if(p.method==='thread/start') {model=p.params.model;approvalPolicy=p.params.approvalPolicy;send({id:p.id,result:{thread:{id:'thread-'+process.pid}}});}
 if(p.method==='thread/resume') {if(p.params.threadId==='missing'){send({id:p.id,error:{message:'thread not found'}});return;}threadId=p.params.threadId;count=1;send({id:p.id,result:{thread:{id:threadId,turns:[{}]}}});}
 if(p.method==='model/list') send({id:p.id,result:{data:[{model:'test-model',displayName:'Test model'}],nextCursor:null}});
 if(p.method==='mcpServerStatus/list') send({id:p.id,result:{data:[{name:'cua_repl',runtimeStatus:'connected',tools:{js:{},js_reset:{}}}],nextCursor:null}});
 const prompt=p.method==='turn/start'?p.params.input[0].text:p.type==='user'?p.message.content:null;
 if(prompt===null)return;
 count++;
 if(p.method)send({id:p.id,result:{turn:{id:'turn-'+count}}});
 if(prompt.startsWith('claude-approval')) {
  send({type:'control_request',request_id:'claude-tool-1',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'git clone https://example.com/skill.git'}}});
  if(prompt==='claude-approval-cancel')setTimeout(()=>{send({type:'control_cancel_request',request_id:'claude-tool-1'});send({type:'result',result:'cancelled'});},30);
  return;
 }
 if(prompt.startsWith('approval')) {
  send({method:'turn/started',params:{threadId,turn:{id:'turn-'+count}}});
  send({id:999,method:'mcpServer/elicitation/request',params:{threadId:prompt==='approval-other-thread'?'another-thread':threadId,turnId:prompt==='approval-old-turn'?'old-turn':'turn-'+count,
   serverName:prompt==='approval-legacy'?'computer-use':'cua_repl',mode:prompt==='approval-url'?'url':prompt==='approval-extended'?'openai/form':'form',message:'Allow Computer Use to use Finder?',
   _meta:{connector_id:prompt==='approval-other-server'?'other':'computer-use',codex_approval_kind:'mcp_tool_call',tool_name:prompt.startsWith('approval-action-')?prompt.slice('approval-action-'.length):'get_app_state',codex_request_type:prompt==='approval-sensitive'?'approval_request':undefined,tool_params:{app:'com.apple.finder',...(prompt==='approval-extra-params'?{command:'something'}:{})},persist:prompt==='approval-no-persist'?[]:['session'],riskLevel:prompt==='approval-high-risk'?'high':'low',tool_params_display:[{name:'app',value:'Finder'}]},
   requestedSchema:{type:'object',properties:prompt==='approval-fields'?{code:{type:'string'}}:{}}}});return;
 }
 if(prompt==='crash'){process.exit(12);return;}
 if(prompt==='invalid'){send(null);return;}
 if(prompt==='wait')return;
 if(prompt==='work-then-no-credit'){send({type:'assistant',message:{content:[{type:'tool_use',name:'Bash'}]}});send({type:'result',is_error:true,result:'Credit balance is too low'});return;}
 if(prompt==='no-credit' && process.env.ANTHROPIC_API_KEY){send({type:'result',is_error:true,result:'Credit balance is too low'});return;}
 if(prompt==='auth-conflict' && process.env.ANTHROPIC_API_KEY){send({type:'result',is_error:true,result:'claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set'});return;}
 if(prompt==='spawn-child') { const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});send({method:'item/completed',params:{threadId,item:{type:'agentMessage',text:String(child.pid)}}});send({method:'turn/completed',params:{threadId,turn:{status:'completed'}}});return; }
 const text=JSON.stringify({pid:process.pid,count,prompt,capabilityContext:p.params?.input?.[1]?.text,model:model||(argvModel>=0?process.argv[argvModel+1]:undefined),cwd:process.cwd(),args:process.argv.slice(2)});
 if(p.type==='user') {send({type:'system',subtype:'init',session_id:threadId});send({type:'assistant',message:{content:[{type:'text',text:'Working'}]}});send({type:'result',result:text});}
 else {
 send({method:'item/completed',params:{threadId,item:{type:'agentMessage',phase:'commentary',text:'Working'}}});
 send({method:'item/completed',params:{threadId,item:{type:'agentMessage',phase:'final_answer',text}}});
 send({method:'turn/completed',params:{threadId,turn:{status:'completed'}}});
 }
});`)
  vi.mocked(validateLocalAgent).mockImplementation(async (id) => ({ id, ...(id.startsWith('custom:') ? { custom: true } : {}), name: 'Test', path: script, command: script, installed: true, discovered: true, chatSupported: true, status: 'ready', authentication: 'unchecked' }))
})
afterEach(async () => {
  configureLocalWorkspaces(); bindings.clear()
  vi.useRealTimers()
  disposeLocalAgentSessions(config.id)
  for (const child of children.splice(0)) { child.close(); await child.disposed() }
})
afterAll(async () => { await rm(directory, { recursive: true, force: true }) })
async function connected(kind: 'codex' | 'claude' = 'codex') {
  const child = new LocalAgentConnection(kind)
  children.push(child)
  await child.connect(script, directory, process.env)
  return child
}
const options = { sessionKey: 'direct:conversation:topic', continuationPrompt: 'next turn' }
describe('persistent local agent connections', () => {
  it('accepts image-sized frames split across chunks and checks coalesced frames individually', async () => {
    const child = await connected()
    const internals = child as unknown as { read(chunk: string): void; listener: (packet: any) => void; failure?: Error }
    const sizes: number[] = []
    internals.listener = packet => sizes.push(packet.data.length)
    const data = 'a'.repeat(34 * 1024 * 1024)
    const frame = JSON.stringify({ method: 'image/result', data }) + '\n'
    internals.read(frame.slice(0, 9 * 1024 * 1024))
    expect(sizes).toEqual([])
    internals.read(frame.slice(9 * 1024 * 1024))
    internals.read(frame + frame)
    expect(sizes).toEqual([data.length, data.length, data.length])
    expect(internals.failure).toBeFalsy()
  })

  it.each([false, true])('rejects oversized protocol frames (terminated=%s)', async terminated => {
    const child = await connected()
    const internals = child as unknown as { read(chunk: string): void; failure?: Error }
    internals.read('a'.repeat(64 * 1024 * 1024 + 1) + (terminated ? '\n' : ''))
    expect(internals.failure?.message).toBe('Local agent protocol frame exceeds 64 MB')
  })

  it('provides a stable host session scope across turns and invalidates it on close', async () => {
    const child = await connected()
    const approve = vi.fn(async () => {})
    await child.turn('approval', undefined, undefined, approve)
    await child.turn('approval-action-click', undefined, undefined, approve)
    const first = (approve.mock.calls as any)[0][0].nativeSession
    const second = (approve.mock.calls as any)[1][0].nativeSession
    expect(first).toMatchObject({ appId: 'com.apple.finder', appName: 'Finder' })
    expect(first.id).toBe(second.id)
    expect(first.signal.aborted).toBe(false)
    child.close()
    expect(first.signal.aborted).toBe(true)
  })
  it.each(['approval-sensitive', 'approval-high-risk', 'approval-extra-params', 'approval-no-persist'])('does not offer session reuse for %s', async prompt => {
    const child = await connected(), approve = vi.fn(async () => {})
    await child.turn(prompt, undefined, undefined, approve)
    expect((approve.mock.calls as any)[0][0].nativeSession).toBeUndefined()
  })
  it.each(['click', 'type_text', 'scroll', 'press_key', 'drag', 'launch_app'])('shares app access for native %s operations', async tool => {
    const child = await connected(), approve = vi.fn(async () => {})
    await child.turn(`approval-action-${tool}`, undefined, undefined, approve)
    expect((approve.mock.calls as any)[0][0].nativeSession).toMatchObject({ appId: 'com.apple.finder', appName: 'Finder' })
  })
  it('passes discovered native desktop tools to the actual Codex turn', async () => {
    const result = await runLocalAgent(config, 'Inspect Calculator', undefined, [], { ...options, onApproval: vi.fn(async () => {}) })
    const reply = JSON.parse(result.text)
    expect(reply.capabilityContext).toContain('cua_repl is connected')
    expect(reply.capabilityContext).toContain('js, js_reset')
  })
  it.each(['approval-legacy', 'approval-extended'])('forwards supported native confirmation %s', async prompt => {
    const child = await connected()
    const onApproval = vi.fn(async () => {})
    const result = JSON.parse(await child.turn(prompt, undefined, undefined, onApproval))
    expect(onApproval).toHaveBeenCalledOnce()
    expect(result.approval.action).toBe('accept')
  })
  it.each([true, false])('routes Claude tool permission and returns the owner decision: %s', async allow => {
    const child = new LocalAgentConnection('claude'); children.push(child)
    await child.connect(script, directory, process.env, undefined, false, undefined, true)
    const handler = vi.fn(async (_request: { message: string; details: string }) => { if (!allow) throw new Error('Denied') })
    const progress = vi.fn()
    const result = JSON.parse(await child.turn('claude-approval', undefined, progress, handler))
    expect(progress.mock.calls.some(([state]) => state.phase === 'approval')).toBe(true)
    expect(progress.mock.calls.at(-1)![0].phase).not.toBe('approval')
    expect(handler).toHaveBeenCalledOnce()
    expect(JSON.parse(handler.mock.calls[0][0].details).input.command).toContain('git clone')
    expect(result.behavior).toBe(allow ? 'allow' : 'deny')
    if (allow) expect(result.updatedInput).toEqual({ command: 'git clone https://example.com/skill.git' })
    expect(result.updatedPermissions).toBeUndefined()
    const metadata = JSON.parse(await child.turn('args', undefined, undefined, handler))
    expect(metadata.args).toContain('--permission-prompt-tool')
    expect(metadata.args).not.toContain('dontAsk')
    expect(metadata.args).not.toContain('--dangerously-skip-permissions')
  })
  it('denies Claude tools without an active approval handler', async () => {
    const child = await connected('claude')
    expect(JSON.parse(await child.turn('claude-approval', undefined)).behavior).toBe('deny')
  })
  it.each(['cancel', 'stop'])('cancels pending Claude approval on %s', async action => {
    const child = await connected('claude')
    const stop = new AbortController()
    let approvalSignal: AbortSignal | undefined
    const handler = vi.fn((_request, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      approvalSignal = signal
      signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true })
    }))
    const work = child.turn(action === 'cancel' ? 'claude-approval-cancel' : 'claude-approval', stop.signal, undefined, handler)
    const outcome = action === 'stop' ? expect(work).rejects.toThrow('Stopped') : expect(work).resolves.toBe('cancelled')
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
    if (action === 'stop') stop.abort()
    await outcome
    expect(approvalSignal?.aborted).toBe(true)
  })
  it('routes native Computer Use confirmation through the current owner approval callback', async () => {
    let approve!: () => void
    const onApproval = vi.fn((_request: { message: string; details: string }, _signal: AbortSignal) => new Promise<void>(resolve => { approve = resolve }))
    const work = runLocalAgent(config, 'approval', undefined, [], { ...options, onApproval })
    await vi.waitFor(() => expect(onApproval).toHaveBeenCalledOnce())
    expect(onApproval.mock.calls[0][0]).toMatchObject({ message: 'Allow Computer Use to use Finder?' })
    approve()
    const result = JSON.parse((await work).text)
    expect(result.approval).toEqual({ action: 'accept', content: {}, _meta: null })
    expect(result.approvalPolicy).toEqual({ granular: {
      sandbox_approval: false, rules: false, skill_approval: false, request_permissions: false, mcp_elicitations: true
    } })
  })
  it('declines Computer Use when the owner denies it, without failing the conversation', async () => {
    const child = await connected()
    const onApproval = vi.fn(async () => { throw new Error('The owner declined this request') })
    const result = JSON.parse(await child.turn('approval', undefined, undefined, onApproval))
    expect(onApproval).toHaveBeenCalledOnce()
    expect(result.approval).toEqual({ action: 'decline', content: null, _meta: null })
  })
  it.each(['approval-other-thread', 'approval-old-turn', 'approval-url', 'approval-fields', 'approval-other-server'])(
    'does not grant unsupported or mis-scoped request %s', async prompt => {
      const child = await connected()
      const onApproval = vi.fn(async () => {})
      const result = JSON.parse(await child.turn(prompt, undefined, undefined, onApproval))
      expect(result.approval.action).toBe('decline')
      expect(onApproval).not.toHaveBeenCalled()
    }
  )
  it('cancels the outstanding Computer Use prompt when the task stops', async () => {
    const child = await connected()
    const stop = new AbortController()
    let approvalSignal: AbortSignal | undefined
    const handler = vi.fn((_request, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      approvalSignal = signal
      signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true })
    }))
    const work = expect(child.turn('approval', stop.signal, undefined, handler)).rejects.toThrow('Stopped')
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
    stop.abort()
    await work
    expect(approvalSignal?.aborted).toBe(true)
  })
  it.each(['codex', 'claude'])('resumes a saved %s thread after process disposal and preserves the workspace', async (kind) => {
    configureLocalWorkspaces(join(directory, 'persistent-profile-' + kind), bindings)
    const agentConfig = { ...config, localAgentId: kind }
    const first = JSON.parse((await runLocalAgent(agentConfig, 'full history', undefined, [], options)).text)
    await writeFile(join(first.cwd, 'memory.md'), 'saved memory')
    disposeLocalAgentSessions(config.id)
    const second = JSON.parse((await runLocalAgent(agentConfig, 'full history again', undefined, [], options)).text)
    expect(second.pid).not.toBe(first.pid)
    expect(second).toMatchObject({ count: 2, prompt: 'next turn', cwd: first.cwd })
    expect(await readdir(first.cwd)).toContain('memory.md')
    resetLocalAgentConversation('conversation', 'topic', [])
    const cleared = JSON.parse((await runLocalAgent(agentConfig, 'new topic', undefined, [], options)).text)
    expect(cleared.count).toBe(1)
    expect(cleared.cwd).not.toBe(first.cwd)
  })
  it('rebuilds a missing Codex thread before sending the first turn', async () => {
    const child = new LocalAgentConnection('codex'); children.push(child)
    const remember = vi.fn()
    await child.connect(script, directory, process.env, undefined, false, { thread: 'missing', remember })
    expect(remember).toHaveBeenCalledWith(undefined)
    expect(child.hasHistory).toBe(false)
    expect(JSON.parse(await child.turn('restored transcript', undefined))).toMatchObject({ count: 1, prompt: 'restored transcript' })
  })
  it.each(['codex', 'claude'] as const)('reuses the %s process and session across turns', async (kind) => {
    const child = await connected(kind)
    const first = JSON.parse(await child.turn('hello', undefined))
    const second = JSON.parse(await child.turn('again', undefined))
    expect(second.pid).toBe(first.pid)
    expect(second.count).toBe(2)
    expect(child.hasHistory).toBe(true)
  })
  it('reuses warm connections without discovery or replaying the whole transcript', async () => {
    const before = vi.mocked(validateLocalAgent).mock.calls.length
    const first = JSON.parse((await runLocalAgent(config, 'full history', undefined, [], options)).text)
    const second = JSON.parse((await runLocalAgent(config, 'full history again', undefined, [], options)).text)
    expect(second).toMatchObject({ pid: first.pid, count: 2, prompt: 'next turn', cwd: first.cwd })
    expect(vi.mocked(validateLocalAgent).mock.calls.length - before).toBe(1)
  })
  it('uses edited launch arguments on the next turn instead of retaining the old process', async () => {
    const first = JSON.parse((await runLocalAgent(config, 'first', undefined, [], options)).text)
    changedLocalAgentSettings('codex')
    vi.mocked(validateLocalAgent).mockResolvedValueOnce({ id: 'codex', name: 'Test', path: script, command: script, args: ['--profile', 'new profile'], installed: true, discovered: true, chatSupported: true, status: 'ready', authentication: 'unchecked' })
    const second = JSON.parse((await runLocalAgent(config, 'next', undefined, [], options)).text)
    expect(second.pid).not.toBe(first.pid)
    expect(second.args).toEqual(['app-server', '--profile', 'new profile'])
  })
  it.each(['auth-conflict', 'no-credit'])('retains Claude account-login fallback after %s and reuses the successful connection', async (prompt) => {
    const claude = { ...config, localAgentId: 'claude' }
    const first = JSON.parse((await runLocalAgent(claude, prompt, undefined, [], options)).text)
    const second = JSON.parse((await runLocalAgent(claude, 'next', undefined, [], options)).text)
    expect(second).toMatchObject({ pid: first.pid, count: 2 })
  })
  it('persists successful Claude account authentication across connection recreation', async () => {
    const profile = join(directory, 'claude-auth-persistence')
    configureLocalWorkspaces(profile, bindings)
    const claude = { ...config, localAgentId: 'claude' }
    await runLocalAgent(claude, 'no-credit', undefined, [], options)
    disposeLocalAgentSessions(config.id)
    configureLocalWorkspaces(profile, bindings)
    // No continuation override: the fake CLI rejects this prompt whenever an API key is inherited.
    const result = JSON.parse((await runLocalAgent(claude, 'no-credit', undefined, [], { sessionKey: options.sessionKey })).text)
    expect(result.args).toContain('--resume')
    expect(result.count).toBe(2)
  })
  it('recovers a legacy resumed Claude conversation on an initial authentication failure', async () => {
    configureLocalWorkspaces(join(directory, 'claude-auth-legacy'), bindings)
    const claude = { ...config, localAgentId: 'claude' }
    await runLocalAgent(claude, 'hello', undefined, [], options)
    disposeLocalAgentSessions(config.id)
    const result = JSON.parse((await runLocalAgent(claude, 'no-credit', undefined, [], { sessionKey: options.sessionKey })).text)
    expect(result.args).toContain('--resume')
    expect(result.count).toBe(2)
  })
  it('does not replay Claude work when a billing error follows a tool call', async () => {
    const claude = { ...config, localAgentId: 'claude' }
    const validate = vi.mocked(validateLocalAgent).mock.calls.length
    await expect(runLocalAgent(claude, 'work-then-no-credit', undefined, [], options)).rejects.toThrow('Credit balance')
    expect(vi.mocked(validateLocalAgent).mock.calls.length - validate).toBe(1)
  })
  it.each(['claude', 'codex'])('passes the configured model to %s and starts a new connection after a model change', async (id) => {
    const agent = { ...config, localAgentId: id, model: 'test-first' }
    const first = JSON.parse((await runLocalAgent(agent, 'hello', undefined, [], options)).text)
    const second = JSON.parse((await runLocalAgent({ ...agent, model: 'test-second' }, 'hello', undefined, [], options)).text)
    expect(first.model).toBe('test-first')
    expect(second.model).toBe('test-second')
    expect(second.pid).not.toBe(first.pid)
  })
  it.each(['claude', 'codex'] as const)('queries %s models without starting a conversation', async (id) => {
    const child = new LocalAgentConnection(id)
    try {
      await child.connect(script, directory, process.env, undefined, true)
      expect(await child.models()).toEqual([{ id: 'test-model', name: 'Test model' }])
      expect(child.hasHistory).toBe(false)
      expect(child.thread).toBeUndefined()
    } finally { child.close(); await child.disposed() }
  })
  it('isolates topics, and resets cleared conversations', async () => {
    const a = JSON.parse((await runLocalAgent(config, 'hello', undefined, [], options)).text)
    const b = JSON.parse((await runLocalAgent(config, 'hello', undefined, [], { sessionKey: 'direct:conversation:other' })).text)
    expect(new Set([a.pid, b.pid]).size).toBe(2)
    resetLocalAgentConversation('conversation', 'topic')
    const d = JSON.parse((await runLocalAgent(config, 'new history', undefined, [], options)).text)
    expect(d.pid).not.toBe(a.pid)
    expect(d.count).toBe(1)
  })
  it('keeps long tasks alive beyond three minutes and reports honest silence', async () => {
    const child = await connected()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const progress = vi.fn()
    const abort = new AbortController()
    // Use Claude's no-request path so acknowledgement timers are not part of this test.
    const claude = await connected('claude')
    const result = claude.turn('wait', abort.signal, progress)
    const rejection = expect(result).rejects.toThrow('Stopped')
    await vi.advanceTimersByTimeAsync(181_000)
    expect(claude.alive).toBe(true)
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ elapsedSeconds: 180, silentSeconds: 180, phase: 'waiting' }))
    abort.abort()
    await rejection
    expect(claude.alive).toBe(false)
    child.close()
  })
  it('rejects a crash without replay and allows a fresh subsequent connection', async () => {
    await expect(runLocalAgent(config, 'crash', undefined, [], options)).rejects.toThrow('disconnected')
    const reply = JSON.parse((await runLocalAgent(config, 'hello', undefined, [], options)).text)
    expect(reply.count).toBe(1)
  })
  it('terminates owned descendant processes when a connection is disposed', async () => {
    const child = await connected()
    const pid = Number(await child.turn('spawn-child', undefined))
    expect(() => process.kill(pid, 0)).not.toThrow()
    child.close()
    await child.disposed()
    await vi.waitFor(() => { expect(() => process.kill(pid, 0)).toThrow() })
  })
  it('rejects malformed packets instead of crashing the application', async () => {
    const child = await connected()
    await expect(child.turn('invalid', undefined)).rejects.toThrow('Invalid local agent protocol packet')
  })
  it('evicts idle processes and removes owned temporary workspaces', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const reply = JSON.parse((await runLocalAgent(config, 'hello', undefined, [], options)).text)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    vi.useRealTimers()
    await vi.waitFor(async () => { await expect(readdir(reply.cwd)).rejects.toMatchObject({ code: 'ENOENT' }) })
    expect(() => process.kill(reply.pid, 0)).toThrow()
  })
  it('bounds the pool and does not evict active tasks to make room', async () => {
    const aborts = Array.from({ length: 8 }, () => new AbortController())
    const tasks: Promise<unknown>[] = []
    try {
      for (const [index, abort] of aborts.entries()) {
        let ready!: () => void
        const started = new Promise<void>((resolve) => { ready = resolve })
        const task = runLocalAgent(config, 'wait', abort.signal, [], {
          sessionKey: `direct:capacity:${index}`,
          onProgress: (p) => { if (p.phase === 'ready') ready() }
        })
        tasks.push(expect(task).rejects.toThrow('Stopped'))
        await started
      }
      const cancelled = new AbortController()
      const waiting = runLocalAgent(config, 'cancel queued', cancelled.signal, [], { sessionKey: 'capacity:cancelled' })
      cancelled.abort(new Error('Cancelled while waiting'))
      await expect(waiting).rejects.toThrow('Cancelled while waiting')
      const extra = runLocalAgent(config, 'extra', undefined, [], options)
      const oneShot = runLocalAgent({ ...config, localAgentId: 'custom:budget-test' }, 'one-shot')
      let done = false
      void extra.then(() => { done = true })
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(done).toBe(false)
      aborts[0].abort()
      expect(JSON.parse((await extra).text).prompt).toBe('extra')
      expect((await oneShot).text).toBe('one-shot')
    } finally {
      for (const abort of aborts) abort.abort()
      await Promise.all(tasks)
    }
  })
  it('keeps only two idle processes and resumes the evicted thread on demand', async () => {
    configureLocalWorkspaces(join(directory, 'idle-cap-profile'), bindings)
    const first = JSON.parse((await runLocalAgent(config, 'hello', undefined, [], { sessionKey: 'idle:first' })).text)
    const second = JSON.parse((await runLocalAgent(config, 'hello', undefined, [], { sessionKey: 'idle:second' })).text)
    const third = JSON.parse((await runLocalAgent(config, 'hello', undefined, [], { sessionKey: 'idle:third' })).text)
    await vi.waitFor(() => expect(() => process.kill(first.pid, 0)).toThrow())
    expect(() => process.kill(second.pid, 0)).not.toThrow()
    expect(() => process.kill(third.pid, 0)).not.toThrow()
    const resumed = JSON.parse((await runLocalAgent(config, 'next', undefined, [], { sessionKey: 'idle:first' })).text)
    expect(resumed.pid).not.toBe(first.pid)
    expect(resumed.cwd).toBe(first.cwd)
    expect(resumed.count).toBe(2)
  })
  it('coalesces model discovery requests and closes the discovery connection', async () => {
    const before = vi.mocked(validateLocalAgent).mock.calls.length
    const first = listLocalAgentModels('codex')
    const second = listLocalAgentModels('codex')
    expect(second).toBe(first)
    expect((await first).models).toEqual([{ id: 'test-model', name: 'Test model' }])
    expect(vi.mocked(validateLocalAgent).mock.calls.length).toBe(before + 1)
  })
  it('cancels a catalog lookup on account change and permits a fresh lookup', async () => {
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const validate = vi.mocked(validateLocalAgent).getMockImplementation()!
    vi.mocked(validateLocalAgent).mockImplementationOnce(async id => { await paused; return validate(id) })
    const query = listLocalAgentModels('codex')
    const stopped = expect(query).rejects.toThrow('Model discovery stopped')
    await new Promise(resolve => setTimeout(resolve, 10))
    cancelLocalModelQueries()
    release()
    await stopped
    expect((await listLocalAgentModels('codex')).models).toHaveLength(1)
  })
  it('cleans temporary controller workspaces and processes immediately without creating persistent records', async () => {
    const root = join(directory, 'transient-test')
    configureLocalWorkspaces(root, bindings)
    const reply = JSON.parse((await runLocalAgent(config, 'hello', undefined, [], {
      sessionKey: 'controller:unique-task', transient: true
    })).text)
    await vi.waitFor(() => expect(() => process.kill(reply.pid, 0)).toThrow())
    await vi.waitFor(async () => { await expect(readdir(reply.cwd)).rejects.toMatchObject({ code: 'ENOENT' }) })
    await expect(readdir(join(root, 'local-workspaces', 'sessions'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('releases a cancelled startup before spawning a process and can run again', async () => {
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const validate = vi.mocked(validateLocalAgent).getMockImplementation()!
    vi.mocked(validateLocalAgent).mockImplementationOnce(async id => { await paused; return validate(id) })
    const abort = new AbortController()
    const work = runLocalAgent(config, 'hello', abort.signal, [], options)
    await new Promise(resolve => setTimeout(resolve, 10))
    abort.abort(new Error('Stopped'))
    release()
    await expect(work).rejects.toThrow('Stopped')
    expect(JSON.parse((await runLocalAgent(config, 'hello', undefined, [], options)).text).count).toBe(1)
  })
  it('cancels an active turn and rejects concurrent use of the same session', async () => {
    const abort = new AbortController()
    const ready = new Promise<void>((resolve) => {
      if (!optionsWithProgress) throw new Error('Missing test options')
      optionsWithProgress.onProgress = (p) => { if (p.phase === 'ready') resolve() }
    })
    const result = runLocalAgent(config, 'wait', abort.signal, [], optionsWithProgress)
    const stopped = expect(result).rejects.toThrow('Stopped')
    await ready
    await expect(runLocalAgent(config, 'second', undefined, [], options)).rejects.toThrow('already working')
    abort.abort()
    await stopped
  })
})
const optionsWithProgress: Parameters<typeof runLocalAgent>[4] = { ...options }
