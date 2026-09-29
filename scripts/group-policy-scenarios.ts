/** Paid opt-in QA. Real decision/reply models, isolated groups, scripted human and faults. */
import { app, safeStorage } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CustomModelStore } from '../src/main/customModels'
import { DouchatRuntime } from '../src/main/runtime'
import { DouchatStore } from '../src/main/store'
import type { ComputerProvider } from '../src/main/computer'

if (process.env.DOUCHAT_LIVE_SCENARIOS !== '1') throw new Error('Set DOUCHAT_LIVE_SCENARIOS=1 to authorize paid calls.')
const dev = join(homedir(), 'Library', 'Application Support', 'douchat-dev')
app.setName('Foundry Dev'); app.setPath('userData', dev)
const output = join(process.cwd(), 'out', 'group-scenarios', `policy-${new Date().toISOString().replace(/[:.]/g, '-')}`)
mkdirSync(output, { recursive: true })
async function main() {
  await app.whenReady()
  const source = new DatabaseSync(join(dev, 'douchat.db'), { readOnly: true })
  const account = (source.prepare("SELECT value FROM meta WHERE key='currentAccountId'").get() as { value: string }).value
  source.close()
  const providers = new CustomModelStore(join(dev, 'custom-models'), { encrypt: () => { throw new Error('Read only') }, decrypt: value => safeStorage.decryptString(Buffer.from(value, 'base64')) }).records(account)
  const provider = providers.find(p => p.id === 'openrouter')
  if (!provider) throw new Error('Missing configured OpenRouter')
  const store = new DouchatStore(join(output, 'scenarios.db')); store.setCurrentAccountId('policy-qa')
  const computer: ComputerProvider = { snapshots: () => [], createTools: () => [], start: async () => { throw new Error('No QA tools') }, stop: async () => {}, show: async () => {}, dispose: () => {} }
  const runtime = new DouchatRuntime(store, computer, () => {})
  runtime.configureCustomModels(providers)
  const internal = runtime as any
  if (process.argv.includes('--probe')) {
    console.log(JSON.stringify({ host: new URL(provider.apiBase).hostname, path: new URL(provider.apiBase).pathname, models: provider.models }))
    for (const model of ['xiaomi/mimo-v2.5', '~typesafe/jev-latest']) {
      const started = Date.now()
      const result = await runtime.testDecisionSettings({ mode: 'model', providerId: provider.id, model })
      console.log(JSON.stringify({ model, result, elapsedMs: Date.now() - started }))
    }
    const probeGroup = { id: 'probe', name: 'Policy probe', leadMemberId: 'lead', members: [{ id: 'lead', name: '协调员' }, { id: 'worker', name: '工程师' }, { id: 'reviewer', name: '审阅员' }] }
    const started = Date.now()
    try {
      const decision = await internal.groupDecisionService.plan(provider, 'xiaomi/mimo-v2.5', probeGroup, { messages: [{ id: 'u', role: 'user', content: '大家依次报数' }], completedTurns: [], privateDeliveries: [] }, AbortSignal.timeout(60_000))
      console.log(JSON.stringify({ plan: decision, elapsedMs: Date.now() - started }))
    } catch (error) { console.log(JSON.stringify({ planError: error instanceof Error ? error.message : 'failed', elapsedMs: Date.now() - started })) }
    store.close(); app.exit(); return
  }
  const complete = internal.groupDecisionService.complete.bind(internal.groupDecisionService)
  internal.groupDecisionService.complete = async (...args: any[]) => {
    const started = Date.now()
    try {
      const text = await complete(...args)
      if (/group_dispatch|group_recovery/.test(String(args[2]))) console.log(JSON.stringify({ decisionOutput: text, elapsedMs: Date.now() - started }))
      return text
    } catch (error) { if (/group_dispatch|group_recovery/.test(String(args[2]))) console.log(JSON.stringify({ decisionError: error instanceof Error ? error.message : 'failed', elapsedMs: Date.now() - started })); throw error }
  }
  const reply = internal.runReply.bind(runtime)
  let failId = '', decisionCalls = 0
  const decide = internal.groupDecisionService.decide.bind(internal.groupDecisionService)
  internal.groupDecisionService.decide = async (...args: any[]) => { decisionCalls++; return decide(...args) }
  internal.runReply = async (options: any) => options.context === 'group' && options.config.id === failId
    ? { text: '', error: 'Injected disconnect before execution' } : reply(options)
  const reports: any[] = []
  for (const model of ['leader', 'xiaomi/mimo-v2.5', '~typesafe/jev-latest']) {
    if (process.env.POLICY_MODEL && process.env.POLICY_MODEL !== model) continue
    runtime.saveDecisionSettings({ mode: model === 'leader' ? 'leader' : 'model', providerId: provider.id, model: model === 'leader' ? '' : model })
    for (const scenario of ['attendance-fault', 'explicit-required-fault', 'human-checkpoint']) {
      if (process.env.POLICY_SCENARIO && process.env.POLICY_SCENARIO !== scenario) continue
      const agents = ['协调员', '工程师', '审阅员'].map(name => store.createAgent({ name, role: name,
        instructions: '只讨论当前任务，简洁完成指定回复，不使用工具或执行外部操作。', color: '', provider: 'custom:openrouter', model: 'xiaomi/mimo-v2.5' }))
      const group = store.createGroup({ name: `调度验收 ${model} ${scenario}`, agentIds: agents.map(a => a.id), leadAgentId: agents[0].id })
      failId = scenario === 'attendance-fault' ? agents[0].id : scenario === 'explicit-required-fault' ? agents[1].id : ''
      const before = store.runEvents.length, beforeCalls = decisionCalls, start = Date.now()
      console.log(JSON.stringify({ start: scenario, model }))
      const prompt = scenario === 'attendance-fault' ? '大家按群成员顺序先来报个数，每人一句话，协调员先报 1；不可用成员通报跳过，不用总结。'
        : scenario === 'explicit-required-fault' ? '@工程师 为内部报销 MVP 提供三条具体实现建议，不可用时请合适的成员接替。只讨论，不操作外部系统，完成后结束。'
          : '请项目组合作设计内部报销 MVP。请协调员先问我一个关于审批层级的范围问题，等我回答以后，再由工程师给出实现建议、审阅员给出验收标准、协调员最终汇总。每人不超过三句话，只讨论。'
      await runtime.sendMessage(group.id, prompt)
      let checkpoint = false
      if (scenario === 'human-checkpoint') {
        checkpoint = store.groupWorkflows().filter(w => w.conversationId === group.id).at(-1)?.status === 'waiting'
        if (checkpoint) await runtime.sendMessage(group.id, '确认只做单级主管审批，最多 20 人内部试用，现在请按计划继续到最终方案。')
      }
      const workflow = store.groupWorkflows().filter(w => w.conversationId === group.id).at(-1)!
      const messages = store.topicMessages(group.id, group.activeTopicId)
      const replies = messages.filter(m => m.kind === 'message' && m.authorId !== 'user')
      const events = store.runEvents.slice(before).filter(e => ['Decision requested', 'Decision applied', 'Decision fallback', 'Leader elected', 'Leader takeover'].includes(e.label))
      const configuredCalls = decisionCalls - beforeCalls
      const recovery = Object.entries(workflow.calls).some(([key, call]) => key.includes(':recovery:') && call.kind === 'decision' && (call.value as any)?.recoveryAction)
      const passed = workflow.status === 'completed' && (model === 'leader' ? configuredCalls === 0 : configuredCalls > 0)
        && (scenario === 'attendance-fault' ? recovery && store.conversation(group.id)?.leadAgentId !== failId && JSON.stringify(replies.map(m => m.authorId)) === JSON.stringify(agents.slice(1).map(a => a.id))
          : scenario === 'explicit-required-fault' ? recovery && replies.some(m => m.authorId !== failId && m.text.length > 50)
          : checkpoint && agents.every(a => replies.some(m => m.authorId === a.id)) && replies.at(-1)?.authorId === store.conversation(group.id)?.leadAgentId && replies.filter(m => m.authorId === replies.at(-1)?.authorId && m.replyGroupId === replies.at(-1)?.replyGroupId).map(m => m.text).join('\n').length > 50)
      const report = { model, scenario, passed, status: workflow.status, error: workflow.error, checkpoint, configuredCalls, recovery, elapsedMs: Date.now() - start,
        leader: store.agent(store.conversation(group.id)!.leadAgentId!)?.name, speakers: replies.map(m => m.authorName), fallbackCount: events.filter(e => e.label === 'Decision fallback').length }
      reports.push(report)
      writeFileSync(join(output, `${model.replace(/[^a-zA-Z0-9-]/g, '_')}-${scenario}.json`), JSON.stringify({ report, events, messages, workflow }, null, 2))
      writeFileSync(join(output, 'report.json'), JSON.stringify(reports, null, 2))
      console.log(JSON.stringify(report))
      for (const agent of agents) runtime.disposeAgent(agent.id)
    }
  }
  store.close(); console.log(`REPORT ${output}`); app.exit(reports.some(r => !r.passed) ? 1 : 0)
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Policy QA failed'); app.exit(1) })
