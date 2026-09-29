import { describe, expect, it } from 'vitest'
import { applyGameAction, createGame, gamePlayerView, gameView, nextGameTurn, type GameKind, type GameState } from './groupGame'

function fixture(kind: GameKind, seed: number, human = false): GameState {
  return createGame({ id: `game-${seed}`, conversationId: 'group', topicId: 'main', kind, seed, now: 1, language: 'zh-CN',
    players: Array.from({ length: 6 }, (_, index) => ({ id: human && index === 2 ? 'human' : `p${index}`, name: `玩家${index}`, human: human && index === 2 })) })
}

describe.each(['undercover', 'werewolf'] as const)('%s rules', kind => {
  it.each([false, true])('finishes 100 seeded games, human=%s, without duplicate slots or hidden-state leakage', human => {
    for (let seed = 1; seed <= 100; seed++) {
      let state = fixture(kind, seed, human)
      const slots = new Set<string>()
      let previousAlive = 6
      for (let steps = 0; state.status !== 'finished'; steps++) {
        expect(steps).toBeLessThan(200)
        const turn = nextGameTurn(state)!
        expect(turn).toBeDefined()
        expect(slots.has(turn.slotId)).toBe(false); slots.add(turn.slotId)
        expect(state.players.find(player => player.id === turn.actorId)?.alive).toBe(true)
        const view = gamePlayerView(state, turn.actorId) as { players: object[]; messages: { audience: 'group' | string[] }[] }
        expect(view.players.every(player => !('role' in player) && !('word' in player))).toBe(true)
        expect(view.messages.every(message => message.audience === 'group' || message.audience.includes(turn.actorId))).toBe(true)
        const targetId = seed % 5 === 0 ? '' : turn.targetIds[(seed + steps) % turn.targetIds.length] ?? ''
        const original = JSON.stringify(state)
        state = applyGameAction(state, { slotId: turn.slotId, actorId: turn.actorId, text: `我的第 ${steps} 次发言：这个事物很常见。`, targetId })
        expect(JSON.stringify(state)).not.toBe(original)
        expect(state.players.filter(player => player.alive).length).toBeLessThanOrEqual(previousAlive)
        previousAlive = state.players.filter(player => player.alive).length
      }
      expect(state.winner).toBeTruthy()
      expect(state.events.filter(event => event.text.startsWith('游戏结束：'))).toHaveLength(1)
      expect(nextGameTurn(state)).toBeUndefined()
      expect(state.round).toBeLessThanOrEqual(4)
    }
  })

  it('rejects wrong actors, duplicate slots and late actions after cancellation', () => {
    const state = fixture(kind, 31)
    const turn = nextGameTurn(state)!
    const action = { slotId: turn.slotId, actorId: turn.actorId, text: '我开始描述', targetId: turn.targetIds[0] }
    expect(() => applyGameAction(state, { ...action, actorId: 'intruder' })).toThrow('过期')
    const next = applyGameAction(state, action)
    expect(() => applyGameAction(next, action)).toThrow('过期')
    expect(() => applyGameAction({ ...state, status: 'cancelled' }, action)).toThrow('过期')
  })
})

it('does not expose other roles, words or votes to the human UI', () => {
  const state = fixture('undercover', 13, true)
  const human = state.players.find(player => player.human)!
  const view = gameView(state)
  expect(view.human?.secret).toContain(human.word)
  const otherWord = state.players.find(player => player.word !== human.word)!.word!
  expect(JSON.stringify(view)).not.toContain(otherWord)
  expect(view.players.every(player => !('role' in player))).toBe(true)
  const spectator = gameView(fixture('werewolf', 13))
  expect(spectator.human).toBeUndefined()
  expect(JSON.stringify(spectator)).not.toContain('role')
})

it('delivers wolf discussion only to the wolf channel and a seer result only to the seer', () => {
  let state = fixture('werewolf', 2)
  const wolf = nextGameTurn(state)!
  state = applyGameAction(state, { slotId: wolf.slotId, actorId: wolf.actorId, text: 'WOLF_PRIVATE_CANARY' })
  for (const player of state.players) expect(JSON.stringify(gamePlayerView(state, player.id)).includes('WOLF_PRIVATE_CANARY')).toBe(player.role === 'wolf')
  while (state.phase !== 'seer') {
    const turn = nextGameTurn(state)!
    state = applyGameAction(state, { ...turn, text: '私聊意见', targetId: turn.targetIds[0] })
  }
  const inspect = nextGameTurn(state)!
  state = applyGameAction(state, { ...inspect, targetId: inspect.targetIds[0] })
  for (const player of state.players) expect(JSON.stringify(gamePlayerView(state, player.id)).includes('查验结果')).toBe(player.role === 'seer')
})

it('rejects self-votes and votes for removed members, while preserving the pending slot', () => {
  let state = fixture('undercover', 1)
  while (state.phase !== 'vote') { const turn = nextGameTurn(state)!; state = applyGameAction(state, { ...turn, text: '描述' }) }
  const turn = nextGameTurn(state)!
  expect(() => applyGameAction(state, { ...turn, targetId: turn.actorId })).toThrow('有效目标')
  expect(() => applyGameAction(state, { ...turn, targetId: 'removed' })).toThrow('有效目标')
  expect(nextGameTurn(state)).toEqual(turn)
})


it.each(['undercover', 'werewolf'] as const)('completes an English %s game with localized rules and persisted language', kind => {
  let state = createGame({ id: 'english', conversationId: 'g', topicId: 't', kind, seed: 42, now: 1, language: 'en',
    players: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `Player ${i}`, human: i === 0 })) })
  expect(JSON.stringify(gamePlayerView(state, 'p0'))).not.toMatch(/\p{Script=Han}/u)
  for (let steps = 0; state.status !== 'finished'; steps++) {
    expect(steps).toBeLessThan(200)
    state = JSON.parse(JSON.stringify(state)) // Resume with the stored locale.
    expect(state.language).toBe('en')
    const turn = nextGameTurn(state)!
    state = applyGameAction(state, { ...turn, text: 'My contribution', targetId: turn.targetIds[0] })
  }
  expect(state.winner).toBeTruthy()
  expect(JSON.stringify(gameView(state))).not.toMatch(/\p{Script=Han}/u)
  expect(nextGameTurn(state)).toBeUndefined()
})
