/** Paid, opt-in mixed local/cloud QA using isolated contacts and group history. */
import { app, safeStorage } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CustomModelStore } from '../src/main/customModels'
import { DouchatRuntime } from '../src/main/runtime'
import { DouchatStore } from '../src/main/store'
import type { AgentConfig } from '../src/shared/types'
import type { ComputerProvider } from '../src/main/computer'

if (process.env.DOUCHAT_LIVE_SCENARIOS !== '1') throw new Error('Set DOUCHAT_LIVE_SCENARIOS=1 for paid model calls and local agent probes.')
const dev = join(homedir(), 'Library', 'Application Support', 'douchat-dev')
app.setName('Foundry Dev'); app.setPath('userData', dev)
const output = join(process.cwd(), 'out', 'group-scenarios', `health-${new Date().toISOString().replace(/[:.]/g, '-')}`)
mkdirSync(output, { recursive: true })

async function main() {
  await app.whenReady()
  const source = new DatabaseSync(join(dev, 'douchat.db'), { readOnly: true })
  const account = (source.prepare("SELECT value FROM meta WHERE key='currentAccountId'").get() as { value: string }).value
  const contacts = (source.prepare('SELECT data FROM agents').all() as { data: string }[]).map(row => JSON.parse(row.data) as AgentConfig).filter(agent => agent.ownerId === account)
  source.close()
  const providers = new CustomModelStore(join(dev, 'custom-models'), {
    encrypt: () => { throw new Error('Read only') }, decrypt: value => safeStorage.decryptString(Buffer.from(value, 'base64'))
  }).records(account)
  const store = new DouchatStore(join(output, 'scenarios.db'))
  store.setCurrentAccountId('mixed-health-qa')
  const computer: ComputerProvider = { snapshots: () => [], createTools: () => [], start: async () => { throw new Error('No QA tools') }, stop: async () => {}, show: async () => {}, dispose: () => {} }
  let currentGroup = '', started = 0, firstReplyMs: number | undefined, firstReplyId = ''
  const runtime = new DouchatRuntime(store, computer, () => {
    if (!currentGroup || firstReplyMs !== undefined) return
    const message = store.topicMessages(currentGroup, store.activeTopicId(currentGroup)).find(message => message.kind === 'message' && message.authorId !== 'user' && message.id !== firstReplyId && message.createdAt >= started)
    if (message) { firstReplyMs = Date.now() - started; console.log(JSON.stringify({ firstReply: message.authorName, firstReplyMs })) }
  })
  runtime.setInterfaceLanguage('zh-CN') // Stable language for transcript assertions.
  runtime.configureCustomModels(providers)
  const provider = providers.find(provider => provider.id === 'openrouter')!
  runtime.saveDecisionSettings({ mode: process.env.HEALTH_POLICY === 'leader' ? 'leader' : 'model', providerId: provider.id, model: process.env.HEALTH_POLICY === 'jev' ? '~typesafe/jev-latest' : provider.models[0], healthCheckIntervalSeconds: 300 })
  const names = process.env.HEALTH_CLOUD_ONLY === '1' ? ['DeepSeek', 'mimo'] : ['Grok', 'OpenClaw', 'Gemini', 'Codex', 'OpenCode', 'Cursor', 'DeepSeek', 'mimo']
  const agents = names.map(name => {
    const original = contacts.find(agent => agent.name === name)
    if (!original) throw new Error(`Missing contact ${name}`)
    return store.createAgent({ name, role: original.role, instructions: '只完成当前文本回复。不使用工具、不访问文件、不执行命令、不操作外部系统。', color: original.color,
      provider: original.provider, model: original.model, localAgentId: original.localAgentId })
  })
  const group = store.createGroup({ name: '混合群健康验收', agentIds: agents.map(agent => agent.id), leadAgentId: agents[0].id })
  currentGroup = group.id
  const internal = runtime as any
  const plan = internal.groupDecisionService.plan.bind(internal.groupDecisionService)
  internal.groupDecisionService.plan = async (...args: any[]) => {
    const start = Date.now()
    console.log(JSON.stringify({ planningStarted: args[1] }))
    try { const value = await plan(...args); console.log(JSON.stringify({ planningCompleted: args[1], elapsedMs: Date.now() - start })); return value }
    catch (error) { console.log(JSON.stringify({ planningFailed: args[1], elapsedMs: Date.now() - start, error: error instanceof Error ? error.message : 'Planning failed' })); throw error }
  }
  const probe = internal.probeGroupMember.bind(runtime)
  const probes: string[] = []
  internal.probeGroupMember = async (agent: AgentConfig, signal: AbortSignal) => {
    probes.push(agent.id)
    const start = Date.now()
    try { const result = await probe(agent, signal); console.log(JSON.stringify({ probe: agent.name, ok: result, elapsedMs: Date.now() - start })); return result }
    catch (error) { console.log(JSON.stringify({ probe: agent.name, ok: false, cancelled: signal.aborted, elapsedMs: Date.now() - start })); throw error }
  }
  const reports: object[] = []
  const save = (name: string, report: object, messages: unknown[]) => {
    reports.push(report)
    writeFileSync(join(output, `${name}.json`), JSON.stringify({ report, messages, workflow: store.groupWorkflows().at(-1) }, null, 2))
    writeFileSync(join(output, 'report.json'), JSON.stringify(reports, null, 2))
    console.log(JSON.stringify(report))
  }
  for (let trial = 1; trial <= (process.argv.includes('--office-only') ? 0 : 2); trial++) {
    const before = store.topicMessages(group.id, group.activeTopicId).length
    const probeCount = probes.length
    const cachedUnavailable = Object.entries(store.groupHealth(group.id)).filter(([, health]) => health.status === 'unavailable' && Date.now() - health.checkedAt < 300_000).map(([id]) => id)
    firstReplyMs = undefined; started = Date.now()
    const request = process.env.HEALTH_REQUEST ?? '先来报个数'
    await runtime.sendMessage(group.id, request)
    const messages = store.topicMessages(group.id, group.activeTopicId).slice(before)
    const replies = messages.filter(message => message.kind === 'message' && message.authorId !== 'user')
    const workflow = store.groupWorkflows().at(-1)!
    const spoken = replies.map(message => message.authorId)
    const unique = new Set(spoken)
    const absent = agents.filter(agent => !unique.has(agent.id))
    const announced = absent.every(agent => messages.some(message => message.kind === 'system' && message.text.includes(agent.name) && message.text.includes('暂不可用')))
    const plan = Object.values(workflow.calls).find(call => call.kind === 'decision' && call.status === 'done')?.value as { participantScope?: string; memberIds: string[] } | undefined
    const ordered = !!plan && JSON.stringify(spoken) === JSON.stringify(plan.memberIds.filter(id => unique.has(id)))
    const numbered = !!plan && replies.every((message, index) => {
      const values = message.text.match(/\d+/g) ?? []
      return values.length === 1 && Number(values[0]) === index + 1
    })
    const ended = messages.at(-1)?.text.includes('本轮已结束') === true
    const fullRoster = plan?.memberIds.length === agents.length && agents.every(agent => plan.memberIds.includes(agent.id))
    const cachedExcluded = cachedUnavailable.every(id => !Object.keys(workflow.calls).some(key => key.startsWith('reply:') && key.includes(`:${id}:`) || key.includes(`:recovery:${id}:`)))
    const passes = cachedExcluded && workflow.status === 'completed' && replies.length > 0 && unique.size === spoken.length && announced && ordered && numbered && ended && fullRoster
    save(`roll-call-${trial}`, { scenario: 'mixed-roll-call', request, trial, passed: passes, status: workflow.status,
      ordered, numbered, ended, fullRoster, cachedExcluded, settings: store.decisionSettings(), firstReplyMs, elapsedMs: Date.now() - started, probeCount: probes.length - probeCount,
      leader: store.agent(store.conversation(group.id)!.leadAgentId!)?.name, speakers: replies.map(message => message.authorName), absent: absent.map(agent => agent.name), announced,
      health: Object.fromEntries(agents.map(agent => [agent.name, store.groupHealth(group.id)[agent.id]])) }, messages)
  }
  if (process.argv.includes('--roll-call-only')) {
    for (const agent of agents) runtime.disposeAgent(agent.id)
    store.close(); console.log(`REPORT ${output}`); app.exit(reports.some((report: any) => !report.passed) ? 1 : 0); return
  }
  // Inject a failure after a successful probe, then exercise real remaining adapters.
  const refresh = internal.refreshHealth.bind(runtime)
  const reply = internal.runReply.bind(runtime)
  if (!process.argv.includes('--office-only')) {
  const liveHealth = store.groupHealth(group.id)
  const target = agents.find(agent => !agent.localAgentId && liveHealth[agent.id]?.status === 'healthy')
  if (!target) throw new Error('No healthy cloud agent for in-flight fault injection')
  store.updateConversation(group.id, { leadAgentId: target.id })
  internal.refreshHealth = async () => {
    const value = store.groupHealth(group.id)
    value[target.id] = { ...value[target.id], status: 'healthy', latencyMs: 0, checkedAt: Date.now() }
    return value
  }
  internal.runReply = async (options: any) => options.config.id === target.id ? { text: '', error: 'Injected member disconnected after probe' } : reply(options)
  const before = store.topicMessages(group.id, group.activeTopicId).length
  firstReplyMs = undefined; started = Date.now()
  await runtime.sendMessage(group.id, '报数')
  const messages = store.topicMessages(group.id, group.activeTopicId).slice(before)
  const status = store.groupWorkflows().at(-1)!.status
  const leader = store.conversation(group.id)!.leadAgentId!
  save('leader-disconnected', { scenario: 'mixed-leader-disconnected', injected: target.name,
    passed: status === 'completed' && leader !== target.id && messages.some(message => message.kind === 'message' && message.authorId !== 'user' && message.authorId !== target.id),
    status, leader: store.agent(leader)?.name, firstReplyMs, elapsedMs: Date.now() - started }, messages)
  internal.runReply = reply; internal.refreshHealth = refresh
  }
  // Simulate a stale successful check; exercise OpenClaw's real authentication
  // failure and the real fallback model for a required office deliverable.
  const local = agents.find(agent => agent.localAgentId === 'openclaw')!
  internal.refreshHealth = async () => {
    const value = await refresh(store.conversation(group.id)!, agents, new AbortController().signal)
    value[local.id] = { ...value[local.id], status: 'healthy' }
    return value
  }
  const beforeOffice = store.topicMessages(group.id, group.activeTopicId).length
  firstReplyMs = undefined; started = Date.now()
  await runtime.sendMessage(group.id, '@OpenClaw 为内部报销审批 MVP 写三条技术实现建议，只讨论，不执行外部操作；不可用时请合适的成员接替，完成后结束。')
  const officeMessages = store.topicMessages(group.id, group.activeTopicId).slice(beforeOffice)
  const officeStatus = store.groupWorkflows().at(-1)!.status
  save('office-required-replacement', { scenario: 'office-required-replacement', staleProbeInjected: 'OpenClaw',
    passed: officeStatus === 'completed' && officeMessages.some(message => message.authorId !== 'user' && message.authorId !== local.id && message.kind === 'message' && message.text.length > 80),
    status: officeStatus, firstReplyMs, elapsedMs: Date.now() - started,
    speakers: [...new Set(officeMessages.filter(message => message.kind === 'message' && message.authorId !== 'user').map(message => message.authorName))] }, officeMessages)
  internal.refreshHealth = refresh
  for (const agent of agents) runtime.disposeAgent(agent.id)
  store.close()
  console.log(`REPORT ${output}`)
  app.exit(reports.some((report: any) => !report.passed) ? 1 : 0)
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Mixed group QA failed'); app.exit(1) })
