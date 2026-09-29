/** Opt-in live QA. Reuses the development provider in memory; writes only synthetic test data. */
import { app, safeStorage } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { CustomModelStore } from '../src/main/customModels'
import { DouchatStore } from '../src/main/store'
import { DouchatRuntime } from '../src/main/runtime'
import { nextGameTurn } from '../src/shared/groupGame'
import type { ComputerProvider } from '../src/main/computer'
import { GroupDecisionService } from '../src/main/groupDecision'

if (process.env.DOUCHAT_LIVE_SCENARIOS !== '1') throw new Error('Set DOUCHAT_LIVE_SCENARIOS=1 to authorize paid live model calls.')
const devDirectory = join(homedir(), 'Library', 'Application Support', 'douchat-dev')
app.setName('Foundry Dev')
app.setPath('userData', devDirectory)
const output = join(process.cwd(), 'out', 'group-scenarios', new Date().toISOString().replace(/[:.]/g, '-'))
mkdirSync(output, { recursive: true })

async function main() {
  await app.whenReady()
  const source = new DatabaseSync(join(devDirectory, 'douchat.db'), { readOnly: true })
  const account = (source.prepare("SELECT value FROM meta WHERE key = 'currentAccountId'").get() as { value: string }).value
  source.close()
  const providers = new CustomModelStore(join(devDirectory, 'custom-models'), {
    encrypt: () => { throw new Error('Read only') }, decrypt: value => safeStorage.decryptString(Buffer.from(value, 'base64'))
  }).records(account)
  const provider = providers.find(provider => provider.id === 'openrouter')
  if (!provider) throw new Error('Development OpenRouter provider is not configured.')
  const service = new GroupDecisionService()
  const probeGroup = { id: 'probe', name: '测试项目组', members: [{ id: 'pm', name: '项目经理', description: 'Project scope, coordination' }, { id: 'eng', name: '工程师', description: 'Technical implementation and performance' }] }
  const probeContext = { messages: [{ id: 'request', role: 'user' as const, content: '工程师请回答：HTTP 缓存有哪两种常见优化方法？项目经理不用回复。' }], privateDeliveries: [], completedTurns: [] }
  const report: Record<string, unknown>[] = []
  const record = (result: Record<string, unknown>) => { report.push(result); writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(result)) }
  for (const mode of ['llm', 'jev'] as const) {
    const start = Date.now()
    try {
      const decision = await service.decide({ mode, providerId: provider.id, model: mode === 'jev' ? 'typesafe/jev-1.13' : provider.models[0] }, provider, probeGroup, probeContext, new AbortController().signal)
      report.push({ scenario: `${mode}-decision`, decision, elapsedMs: Date.now() - start,
        passed: decision.mode === 'single' && decision.memberIds.length === 1 && decision.memberIds[0] === 'eng' })
    } catch (error) { report.push({ scenario: `${mode}-decision`, passed: false, error: error instanceof Error ? error.message : 'Failed' }) }
    console.log(JSON.stringify(report.at(-1)))
  }
  if (!process.argv.includes('--probe')) {
    const store = new DouchatStore(join(output, 'scenarios.db'))
    store.setCurrentAccountId('synthetic-group-qa')
    store.setUserName('测试真人')
    const computer: ComputerProvider = { snapshots: () => [], createTools: () => [], start: async () => { throw new Error('Tools disabled for QA') }, stop: async () => {}, show: async () => {}, dispose: () => {} }
    let last = ''
    const runtime = new DouchatRuntime(store, computer, snapshot => {
      const game = snapshot.groupGames?.at(-1)
      if (game) {
        const status = `${game.kind} round=${game.round} revision=${game.revision} status=${game.status}`
        if (status !== last) { console.log(status); last = status }
      }
    })
    runtime.configureCustomModels(providers)
    runtime.saveDecisionSettings({ mode: 'llm', providerId: provider.id, model: provider.models[0] })
    const roles = ['项目经理', '产品经理', '工程师', '测试工程师', '设计师', '运营经理']
    const agents = roles.map((name, index) => store.createAgent({ name: `验收${name}`, role: name, instructions: `你是${name}。简明回答。遵守当前活动的发言和私信范围。不要声称执行过未实际执行的工作。`, color: ['#14B8A6', '#6366F1'][index % 2], provider: `custom:${provider.id}`, model: provider.models[0] }))
    const trials = Math.max(1, Math.min(10, Number(process.env.DOUCHAT_GAME_TRIALS) || 1))
    for (const kind of (process.argv.includes('--projects') ? [] : process.argv.includes('--one-game') ? ['undercover'] : ['undercover', 'werewolf']) as ('undercover' | 'werewolf')[]) for (const human of (process.argv.includes('--one-game') ? [false] : [false, true])) for (let trial = 1; trial <= trials; trial++) {
      const start = Date.now()
      const name = kind === 'undercover' ? '谁是卧底' : '狼人杀'
      const group = store.createGroup({ name: `验收-${name}-${human ? '模拟真人参与' : '全Agent'}`, agentIds: agents.slice(0, human ? 5 : 6).map(agent => agent.id), leadAgentId: agents[0].id })
      await runtime.games.start(group.id, { kind, includeHuman: human, agentIds: group.agentIds })
      let humanActions = 0
      while (true) {
        const game = store.groupGames().find(game => game.conversationId === group.id)!
        if (game.status !== 'waiting') break
        const turn = nextGameTurn(game)!
        await runtime.games.act(game.id, { actorId: 'human', slotId: turn.slotId,
          text: `这是我的第 ${game.round} 轮观察：我会结合其他人的描述判断。`, targetId: turn.targetIds[0] ?? '' })
        humanActions++
      }
      const game = store.groupGames().find(game => game.conversationId === group.id)!
      const messages = store.topicMessages(group.id, group.activeTopicId)
      const finals = messages.filter(message => message.text.startsWith('游戏结束：'))
      const passed = game.status === 'finished' && finals.length === 1 && new Set(messages.map(message => message.id)).size === messages.length
      record({ scenario: `${kind}-${human ? 'scripted-human' : 'all-agents'}`, trial, passed, humanPathExercised: humanActions > 0, status: game.status, error: game.error, winner: game.winner, rounds: game.round,
        turns: game.revision, humanActions, skippedTurns: game.skippedTurns ?? 0, publicMessages: messages.length, elapsedMs: Date.now() - start })
      writeFileSync(join(output, `${kind}-${human ? 'human' : 'agents'}-${trial}.json`), JSON.stringify({ report: report.at(-1), messages }, null, 2))
    }
    for (const mode of (process.argv.includes('--one-game') || process.argv.includes('--games') ? [] : process.argv.includes('--jev-human') ? ['jev'] : ['leader', 'llm', 'jev']) as ('leader' | 'llm' | 'jev')[]) for (const human of (process.argv.includes('--jev-human') || process.argv.includes('--humans-only') ? [true] : [false, true])) {
      const start = Date.now()
      runtime.saveDecisionSettings({ mode, providerId: provider.id, model: mode === 'jev' ? 'typesafe/jev-1.13' : provider.models[0] })
      const group = store.createGroup({ name: `验收-项目组-${human ? '真人确认' : '自主协作'}`, agentIds: agents.slice(0, 4).map(agent => agent.id), leadAgentId: agents[0].id })
      const request = human
        ? '我们要设计一个企业报销审批 MVP，请项目组协作。关键范围待我确定：必须先由项目经理问我一个关键范围问题，等待我的回答后再安排产品经理、工程师和测试工程师依次讨论，最后项目经理汇总。不要替我决定。仅讨论，不操作外部系统。'
        : '请项目组自主完成企业报销审批 MVP 的设计：项目经理分工，产品经理写需求范围，工程师基于产品需求提出实现方案，测试工程师基于前两者给出验收清单，最后项目经理汇总明确结论。不需要问我问题，不要执行外部操作，每人 150 字以内。'
      await runtime.sendMessage(group.id, request)
      const before = store.topicMessages(group.id, group.activeTopicId).filter(message => message.authorId !== 'user' && message.kind === 'message')
      const beforeSteps = Object.values(store.groupWorkflows().filter(workflow => workflow.conversationId === group.id).at(-1)?.calls ?? {}).filter(call => call.kind === 'reply' && call.status === 'done').length
      const checkpoint = store.groupWorkflows().filter(workflow => workflow.conversationId === group.id).at(-1)?.status
      const askedQuestion = before.some(message => /[?？]|请.{0,8}(?:确认|提供|说明|选择|回答|补充|告知)/.test(message.text))
      if (human) await runtime.sendMessage(group.id, '先做内部 20 人试用，只支持单级主管审批和附件上传，不接支付、不接财务系统。现在按刚才约定的顺序继续，并汇总最终方案。')
      const messages = store.topicMessages(group.id, group.activeTopicId)
      const workflow = store.groupWorkflows().filter(workflow => workflow.conversationId === group.id).at(-1)!
      const speakers = [...new Set(messages.filter(message => message.kind === 'message' && message.authorId !== 'user').map(message => message.authorName))]
      const replies = messages.filter(message => message.kind === 'message' && message.authorId !== 'user')
      const contributions = agents.slice(1, 4).map(agent => ({ member: agent.name, delivered: replies.some(message => message.authorId === agent.id && message.text.length > 40) }))
      const contributionOrder = agents.slice(1, 4).map(agent => replies.findIndex(message => message.authorId === agent.id && message.text.length > 40))
      const orderedContributions = contributionOrder.every((index, position) => index >= 0 && (position === 0 || index > contributionOrder[position - 1]))
      const finalTurn: string[] = []
      for (const reply of [...replies].reverse()) { if (reply.authorId !== agents[0].id) break; finalTurn.unshift(reply.text) }
      const finalByLeader = finalTurn.join('\n').length > 80
      record({ scenario: `project-${human ? 'scripted-human' : 'all-agents'}`, mode, passed: workflow.status === 'completed' && contributions.every(result => result.delivered) && orderedContributions && finalByLeader && (!human || beforeSteps === 1 && checkpoint === 'waiting' && askedQuestion),
        contributions, orderedContributions, finalByLeader, checkpoint, ...(human ? { askedQuestion } : {}),
        status: workflow.status, speakers, turnsBeforeHuman: human ? beforeSteps : undefined, bubblesBeforeHuman: human ? before.length : undefined, elapsedMs: Date.now() - start })
      writeFileSync(join(output, `project-${mode}-${human ? 'human' : 'agents'}.json`), JSON.stringify({ report: report.at(-1), messages }, null, 2))
    }
    if (!process.argv.includes('--projects') && !process.argv.includes('--one-game')) for (const kind of ['undercover', 'werewolf']) {
      record({ scenario: `${kind}-human-path-coverage`, passed: report.some(result => result.scenario === `${kind}-scripted-human` && result.humanPathExercised === true) })
    }
    store.close()
  }
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`REPORT ${output}`)
  app.exit(report.some(result => !result.passed) ? 1 : 0)
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Live QA failed'); app.exit(1) })
