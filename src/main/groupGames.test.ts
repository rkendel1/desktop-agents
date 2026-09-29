import { openAtFile } from './testSupport'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopRepository } from './desktopRepository'
import { GroupGames } from './groupGames'
import { nextGameTurn, type GameState, type GameTurn } from '../shared/groupGame'

const resources: { directory: string; store: DesktopRepository }[] = []
function setup(count = 6) {
  const directory = mkdtempSync(join(tmpdir(), 'douchat-games-'))
  const store = openAtFile(join(directory, 'state.db'), { seedDemo: true })
  resources.push({ directory, store })
  const agents = Array.from({ length: count }, (_, index) => store.createAgent({ name: `测试员${index}`, role: '', instructions: '', color: '', provider: 'test', model: 'fixture' }))
  const conversation = store.createGroup({ name: '游戏测试', agentIds: agents.map(agent => agent.id) })
  const reply = vi.fn(async (_agent, prompt: string) => {
    const view = JSON.parse(prompt.slice(prompt.indexOf('{"game"'))) as { turn: GameTurn }
    return JSON.stringify(view.turn.kind === 'speak' ? { text: '这很常见，但我还需要观察大家。' } : { targetId: view.turn.targetIds[0] ?? '' })
  })
  const callbacks = { language: () => 'zh-CN' as const, reply, changed: vi.fn(), activity: vi.fn() }
  return { store, conversation, agents, callbacks, games: new GroupGames(store, callbacks), directory }
}
afterEach(() => { for (const { directory, store } of resources.splice(0)) { try { store.close() } catch {} rmSync(directory, { recursive: true, force: true }) } })

describe('persisted group games', () => {
  it.each(['谁是卧底', '狼人杀'])('runs %s end-to-end without human nudges and never publishes private envelopes', async name => {
    const { store, games, conversation, callbacks } = setup()
    await games.start(conversation.id, { kind: name === '谁是卧底' ? 'undercover' : 'werewolf', includeHuman: false, agentIds: conversation.agentIds })
    const state = store.groupGames()[0]
    expect(state.status).toBe('finished')
    const messages = store.topicMessages(conversation.id, conversation.activeTopicId)
    expect(messages.filter(message => message.text.startsWith('游戏结束'))).toHaveLength(1)
    expect(messages.some(message => message.text.startsWith('你的身份') || message.text.startsWith('你的词语') || message.text.startsWith('查验结果'))).toBe(false)
    expect(callbacks.reply.mock.calls.length).toBeGreaterThan(6)
    expect(new Set(messages.map(message => message.id)).size).toBe(messages.length)
  })

  it.each(['谁是卧底', '狼人杀'])('waits for the real human input path in %s and automatically continues', async name => {
    const { store, games, conversation } = setup(5)
    await games.start(conversation.id, { kind: name === '谁是卧底' ? 'undercover' : 'werewolf', includeHuman: true, agentIds: conversation.agentIds })
    let humanTurns = 0
    for (let budget = 0; budget < 100; budget++) {
      const state = store.groupGames()[0]
      if (state.status === 'finished') break
      expect(state.status).toBe('waiting')
      const turn = nextGameTurn(state)!
      expect(turn.actorId).toBe('human')
      await games.act(state.id, { ...turn, text: '这是我的观察。', targetId: turn.targetIds[0] ?? '' })
      humanTurns++
    }
    expect(humanTurns).toBeGreaterThan(0)
    expect(store.groupGames()[0].status).toBe('finished')
  })

  it('resumes a saved game without changing roles or replaying published slots', async () => {
    const { store, games, conversation, callbacks, directory } = setup(5)
    await games.start(conversation.id, { kind: 'undercover', includeHuman: true, agentIds: conversation.agentIds })
    const before = store.groupGames()[0]
    const messageIds = store.topicMessages(conversation.id, conversation.activeTopicId).map(message => message.id)
    store.close()
    const reopened = openAtFile(join(directory, 'state.db'))
    resources.at(-1)!.store = reopened
    const restored = new GroupGames(reopened, callbacks)
    const turn = nextGameTurn(reopened.groupGames()[0])!
    await restored.act(before.id, { ...turn, text: '恢复后我的描述。' })
    expect(reopened.groupGames()[0].players.map(player => [player.id, player.role, player.word])).toEqual(before.players.map(player => [player.id, player.role, player.word]))
    const messages = reopened.topicMessages(conversation.id, conversation.activeTopicId)
    for (const id of messageIds) expect(messages.filter(message => message.id === id)).toHaveLength(1)
  })

  it('rejects stale commits and unknown slots', async () => {
    const { store, games, conversation } = setup(5)
    await games.start(conversation.id, { kind: 'undercover', includeHuman: true, agentIds: conversation.agentIds })
    const state = store.groupGames()[0]
    expect(() => store.commitGame({ ...state, revision: state.revision + 1 }, state.revision - 1)).toThrow('更新')
    await expect(games.act(state.id, { slotId: 'fake', actorId: 'human' })).rejects.toThrow()
  })

  it('pauses on repeated model failure and resumes from the same pending player', async () => {
    const { store, conversation, callbacks } = setup()
    const broken = vi.fn().mockRejectedValue(new Error('provider offline'))
    const games = new GroupGames(store, { ...callbacks, reply: broken })
    await games.start(conversation.id, { kind: 'undercover', includeHuman: false, agentIds: conversation.agentIds })
    const paused = store.groupGames()[0]
    expect(paused.status).toBe('paused')
    expect(broken).toHaveBeenCalledTimes(3)
    const roles = paused.players.map(player => player.role)
    const replacement = new GroupGames(store, callbacks)
    await replacement.control(paused.id, 'resume')
    expect(store.groupGames()[0].status).toBe('finished')
    expect(store.groupGames()[0].players.map(player => player.role)).toEqual(roles)
  })

  it('forfeits invalid agent actions but pauses when malformed output becomes systemic', async () => {
    const { store, conversation, callbacks } = setup()
    const malformed = vi.fn(async () => '{"targetId":"outside-the-game"}')
    const games = new GroupGames(store, { ...callbacks, reply: malformed })
    await games.start(conversation.id, { kind: 'undercover', includeHuman: false, agentIds: conversation.agentIds })
    const state = store.groupGames()[0]
    expect(state.skippedTurns).toBe(2)
    expect(state.status).toBe('paused')
    expect(state.winner).toBeUndefined()
    expect(malformed).toHaveBeenCalledTimes(6)
    const resumed = new GroupGames(store, callbacks)
    await resumed.control(state.id, 'resume')
    expect(store.groupGames()[0].status).toBe('finished')
  })

  it('cancels an in-flight generation and rejects its late output', async () => {
    const { store, conversation, callbacks } = setup()
    let release!: (text: string) => void
    const games = new GroupGames(store, { ...callbacks, reply: () => new Promise(resolve => { release = resolve }) })
    const running = games.start(conversation.id, { kind: 'undercover', includeHuman: false, agentIds: conversation.agentIds })
    const before = store.groupGames()[0]
    const stopping = games.control(before.id, 'cancel')
    release('{"text":"LATE_OUTPUT"}')
    await Promise.all([running, stopping])
    expect(store.groupGames()[0].status).toBe('cancelled')
    expect(store.topicMessages(conversation.id, conversation.activeTopicId).some(message => message.text.includes('LATE_OUTPUT'))).toBe(false)
    await expect(games.act(before.id, { actorId: before.players[0].id, slotId: 'fake' })).rejects.toThrow('自己的')
  })

  it('recovers an interrupted model call from disk without duplicating committed turns', async () => {
    const { store, conversation, callbacks, directory } = setup()
    let release!: (text: string) => void
    const games = new GroupGames(store, { ...callbacks, reply: () => new Promise(resolve => { release = resolve }) })
    const running = games.start(conversation.id, { kind: 'undercover', includeHuman: false, agentIds: conversation.agentIds })
    const before = store.groupGames()[0]
    const ids = store.topicMessages(conversation.id, conversation.activeTopicId).map(message => message.id)
    games.stopAll(); release('{"text":"UNCOMMITTED_OUTPUT"}'); await running
    expect(store.groupGames()[0].revision).toBe(before.revision)
    store.close()
    const reopened = openAtFile(join(directory, 'state.db'))
    resources.at(-1)!.store = reopened
    const restored = new GroupGames(reopened, callbacks)
    await restored.pump(before.id)
    const after = reopened.groupGame(before.id)!
    expect(after.status).toBe('finished')
    expect(after.players.map(player => [player.role, player.word])).toEqual(before.players.map(player => [player.role, player.word]))
    const messages = reopened.topicMessages(conversation.id, conversation.activeTopicId)
    for (const id of ids) expect(messages.filter(message => message.id === id)).toHaveLength(1)
    expect(messages.some(message => message.text.includes('UNCOMMITTED_OUTPUT'))).toBe(false)
  })

  it('rejects a second human submission for the same slot', async () => {
    const { store, games, conversation } = setup(5)
    await games.start(conversation.id, { kind: 'undercover', includeHuman: true, agentIds: conversation.agentIds })
    const game = store.groupGames()[0]
    const turn = nextGameTurn(game)!
    const action = { ...turn, text: '我的唯一有效发言。' }
    const results = await Promise.allSettled([games.act(game.id, action), games.act(game.id, action)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(store.topicMessages(conversation.id, conversation.activeTopicId).filter(message => message.text === action.text)).toHaveLength(1)
  })

  it('cannot publish an in-flight answer after a player leaves the group', async () => {
    const { store, conversation, agents, callbacks } = setup()
    let release!: (text: string) => void
    let calls = 0
    const games = new GroupGames(store, { ...callbacks, reply: () => ++calls === 1 ? new Promise(resolve => { release = resolve }) : Promise.resolve('{"text":"REMOVED_PLAYER_OUTPUT"}') })
    const running = games.start(conversation.id, { kind: 'undercover', includeHuman: false, agentIds: conversation.agentIds })
    store.updateConversation(conversation.id, { agentIds: agents.slice(1).map(agent => agent.id) })
    release('{"text":"REMOVED_PLAYER_OUTPUT"}'); await running
    expect(store.groupGames()[0].status).toBe('paused')
    expect(store.topicMessages(conversation.id, conversation.activeTopicId).some(message => message.text.includes('REMOVED_PLAYER_OUTPUT'))).toBe(false)
  })
})
