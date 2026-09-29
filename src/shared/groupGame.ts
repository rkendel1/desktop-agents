import { gameText, GameRuleError, gameWordPairs } from './gameText'
import type { InterfaceLanguage } from './language'

/** Versioned, deterministic game rules. Only gamePlayerView may cross into a player model. */
export type GameKind = 'undercover' | 'werewolf'
export type GamePhase = 'describe' | 'defend' | 'vote' | 'wolfDiscuss' | 'wolfVote' | 'seer' | 'finished'
export interface GamePlayer { id: string; name: string; human?: boolean; alive: boolean; role: 'civilian' | 'undercover' | 'wolf' | 'seer'; word?: string }
export interface GameEvent { id: string; authorId: string; authorName: string; text: string; audience: 'group' | string[] }
export interface GameState {
  language?: InterfaceLanguage
  version: 1
  id: string
  conversationId: string
  topicId: string
  kind: GameKind
  status: 'running' | 'waiting' | 'paused' | 'finished' | 'cancelled'
  phase: GamePhase
  round: number
  revision: number
  rng: number
  players: GamePlayer[]
  pending: string[]
  votes: Record<string, string>
  tieCandidates: string[]
  revote: boolean
  nightTarget?: string
  events: GameEvent[]
  winner?: string
  error?: string
  createdAt: number
  skippedTurns?: number
  consecutiveSkippedTurns?: number
}
export interface GameAction { slotId: string; actorId: string; text?: string; targetId?: string }
export interface GameTurn { slotId: string; actorId: string; kind: 'speak' | 'vote' | 'inspect'; audience: 'group' | string[]; targetIds: string[] }
export interface GameView {
  id: string; conversationId: string; topicId: string; kind: GameKind; status: GameState['status']; phase: GamePhase
  round: number; revision: number; winner?: string; error?: string
  players: { id: string; name: string; alive: boolean }[]
  human?: { secret: string; messages: GameEvent[]; turn?: GameTurn }
}

const language = (state: GameState): InterfaceLanguage => state.language ?? 'zh-CN' // Pre-language saved games used Chinese.
const text = (state: GameState, key: string, values: Record<string, string | number> = {}) => gameText(language(state), key, values)

function random(state: GameState, count: number): number {
  let value = state.rng | 0
  value ^= value << 13; value ^= value >>> 17; value ^= value << 5
  state.rng = value >>> 0
  return state.rng % count
}
function event(state: GameState, content: string, audience: GameEvent['audience'] = 'group', player?: GamePlayer): void {
  state.events.push({ id: `${state.id}:event:${state.events.length}`, authorId: player?.id ?? 'system', authorName: player?.name ?? text(state, 'Judge'), text: content, audience })
}
const alive = (state: GameState): GamePlayer[] => state.players.filter(player => player.alive)
function setPhase(state: GameState, phase: GamePhase, players: GamePlayer[]): void {
  state.phase = phase; state.pending = players.map(player => player.id); state.votes = {}
}
function finishIfWon(state: GameState): boolean {
  const living = alive(state)
  const enemies = living.filter(player => player.role === (state.kind === 'undercover' ? 'undercover' : 'wolf')).length
  const winner = enemies === 0 ? text(state, state.kind === 'undercover' ? 'Civilian' : 'Good')
    : state.kind === 'undercover' ? (living.length <= 2 ? text(state, 'Undercover') : '') : (enemies >= living.length - enemies ? text(state, 'Wolf') : '')
  if (!winner) return false
  state.winner = winner; state.phase = 'finished'; state.status = 'finished'; state.pending = []
  event(state, text(state, 'Game over: {winner} wins.\nRoles: {roles}', { winner, roles: state.players.map(player => `${player.name}: ${roleName(state, player.role)}${player.word ? ` (${player.word})` : ''}`).join('; ') }))
  return true
}
function roleName(state: GameState, role: GamePlayer['role']): string {
  return text(state, { civilian: 'Civilian', undercover: 'Undercover', wolf: 'Wolf', seer: 'Seer' }[role])
}
function startDay(state: GameState): void {
  state.tieCandidates = []; state.revote = false
  setPhase(state, 'describe', alive(state))
  event(state, text(state, 'Round {round}, {phase}. Speak in order: {members}.', { round: state.round, phase: text(state, state.kind === 'werewolf' ? 'day' : 'descriptions'), members: alive(state).map(player => `@${player.name}`).join(' → ') }))
}
function startNight(state: GameState): void {
  state.nightTarget = undefined
  setPhase(state, 'wolfDiscuss', alive(state).filter(player => player.role === 'wolf'))
  event(state, text(state, 'Night {round}. Wolves discuss and choose a target privately; the seer then inspects. Night actions stay private.', { round: state.round }))
}
function tally(state: GameState): string[] {
  const counts = new Map<string, number>()
  for (const target of Object.values(state.votes)) if (target) counts.set(target, (counts.get(target) ?? 0) + 1)
  const maximum = Math.max(0, ...counts.values())
  return [...counts].filter(([, count]) => count === maximum).map(([id]) => id)
}
function resolveNight(state: GameState): void {
  const killed = state.players.find(player => player.id === state.nightTarget && player.alive)
  if (killed) killed.alive = false
  event(state, killed ? text(state, 'Daybreak: {member} was eliminated last night.', { member: killed.name }) : text(state, 'Daybreak: nobody was eliminated last night.'))
  if (!finishIfWon(state)) startDay(state)
}
function settle(state: GameState): void {
  while (!state.pending.length && state.status !== 'finished') {
    if (state.phase === 'describe' || state.phase === 'defend') {
      setPhase(state, 'vote', alive(state))
      event(state, text(state, 'Surviving players vote privately{restriction}. One vote each, no self-votes. Results appear after all votes are collected.', { restriction: state.revote ? text(state, ' (tied candidates only)') : '' }))
    } else if (state.phase === 'vote') {
      event(state, text(state, 'Round {round} {phase} results: {votes}', { round: state.round, phase: text(state, state.revote ? 'revote' : 'vote'), votes: Object.entries(state.votes).map(([id, target]) => `${state.players.find(player => player.id === id)!.name} → ${state.players.find(player => player.id === target)?.name ?? text(state, 'abstain')}`).join('; ') }))
      let targets = tally(state)
      if (targets.length !== 1 && !state.revote) {
        state.tieCandidates = targets.length ? targets : alive(state).map(player => player.id)
        state.revote = true
        setPhase(state, 'defend', alive(state).filter(player => state.tieCandidates.includes(player.id)))
        event(state, text(state, "Tie: candidates defend in order, then vote again once. Another tie is resolved by the seeded draw announced at the start."))
        continue
      }
      if (!targets.length) targets = state.tieCandidates.length ? state.tieCandidates : alive(state).map(player => player.id)
      const eliminatedId = targets[random(state, targets.length)]
      const eliminated = state.players.find(player => player.id === eliminatedId)!
      eliminated.alive = false
      event(state, text(state, '{prefix}{member} was eliminated.', { prefix: targets.length > 1 ? text(state, 'Tie draw: ') : '', member: eliminated.name }))
      if (finishIfWon(state)) return
      state.round++
      if (state.kind === 'undercover') startDay(state)
      else startNight(state)
    } else if (state.phase === 'wolfDiscuss') {
      setPhase(state, 'wolfVote', alive(state).filter(player => player.role === 'wolf'))
    } else if (state.phase === 'wolfVote') {
      let targets = tally(state)
      // A total abstention is a legal peaceful night. Daytime still eliminates a player.
      if (targets.length) state.nightTarget = targets[random(state, targets.length)]
      setPhase(state, 'seer', alive(state).filter(player => player.role === 'seer'))
    } else if (state.phase === 'seer') resolveNight(state)
    else throw new GameRuleError("Invalid game phase.", language(state))
  }
  if (state.status !== 'finished') state.status = state.players.find(player => player.id === state.pending[0])?.human ? 'waiting' : 'running'
}

export function createGame(input: {
  id: string; conversationId: string; topicId: string; kind: GameKind
  players: { id: string; name: string; human?: boolean }[]; seed: number; now: number; language?: InterfaceLanguage
}): GameState {
  const locale = input.language ?? 'en'
  const count = input.players.length
  if (new Set(input.players.map(player => player.id)).size !== count || input.players.some(player => !player.id || !player.name)
    || input.players.filter(player => player.human).length > 1) throw new GameRuleError("Invalid player list. At most one human is supported.", locale)
  if (input.kind === 'undercover' ? count < 4 || count > 8 : count !== 6) throw new GameRuleError(input.kind === 'undercover' ? 'Undercover requires 4–8 players.' : 'Simplified Werewolf requires 6 players: 2 wolves, 1 seer, 3 civilians.', locale)
  const state: GameState = { version: 1, language: locale, id: input.id, conversationId: input.conversationId, topicId: input.topicId,
    kind: input.kind, status: 'running', phase: 'describe', round: 1, revision: 0, rng: input.seed || 1,
    players: input.players.map(player => ({ ...player, alive: true, role: 'civilian' })), pending: [], votes: {}, tieCandidates: [], revote: false, events: [], createdAt: input.now }
  const shuffled = [...state.players]
  for (let index = shuffled.length - 1; index > 0; index--) {
    const target = random(state, index + 1); [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]]
  }
  if (state.kind === 'undercover') {
    const pairs = gameWordPairs[locale]
    const pair = pairs[random(state, pairs.length)]
    shuffled[0].role = 'undercover'
    for (const player of state.players) player.word = player.role === 'undercover' ? pair[1] : pair[0]
  } else { shuffled[0].role = 'wolf'; shuffled[1].role = 'wolf'; shuffled[2].role = 'seer' }
  event(state, text(state, '{game} begins. The rules service is the judge and does not play. {rules}\nSpeak in seat order and vote privately. The first legal vote counts. A tie permits one defense and revote, then a random draw. Two invalid agent actions skip a speech or abstain; three consecutive invalid slots or a persistent service failure pause the game. Wait for human input; pausing and cancelling are supported.', {
    game: text(state, state.kind === 'undercover' ? 'Undercover game' : 'Simplified Werewolf'),
    rules: text(state, state.kind === 'undercover' ? 'One undercover; no blank cards or word-guess comeback. Eliminating the undercover wins for civilians; two survivors with the undercover alive wins for the undercover.' : 'Two wolves, one seer, three civilians; no special last-words skills. No wolves means good wins; wolves at least equal to surviving good players means wolves win.')
  }))
  for (const player of state.players) event(state, state.kind === 'undercover'
    ? text(state, 'Your word: {word}. Do not say it directly. You do not know whether you are undercover.', { word: player.word! })
    : text(state, 'Your role: {role}.{partners}', { role: roleName(state, player.role), partners: player.role === 'wolf' ? text(state, ' Wolf teammates: {members}.', { members: state.players.filter(other => other.role === 'wolf' && other.id !== player.id).map(other => other.name).join(', ') }) : '' }), [player.id])
  if (state.kind === 'undercover') startDay(state); else startNight(state)
  settle(state)
  return state
}

export function nextGameTurn(state: GameState): GameTurn | undefined {
  if (!['running', 'waiting'].includes(state.status) || !state.pending.length) return undefined
  const actorId = state.pending[0]
  const player = state.players.find(player => player.id === actorId)!
  const targetIds = alive(state).filter(target => target.id !== actorId
    && (state.phase !== 'wolfVote' || target.role !== 'wolf')
    && (state.phase !== 'vote' || !state.revote || state.tieCandidates.includes(target.id))).map(target => target.id)
  return { actorId, slotId: `${state.id}:${state.revision}:${state.phase}:${actorId}`,
    kind: state.phase === 'seer' ? 'inspect' : ['vote', 'wolfVote'].includes(state.phase) ? 'vote' : 'speak',
    audience: state.phase === 'wolfDiscuss' ? state.players.filter(other => other.alive && other.role === 'wolf').map(other => other.id)
      : ['describe', 'defend'].includes(state.phase) ? 'group' : [player.id], targetIds }
}

export function applyGameAction(current: GameState, action: GameAction): GameState {
  const turn = nextGameTurn(current)
  if (!turn || turn.slotId !== action.slotId || turn.actorId !== action.actorId) throw new GameRuleError("The speech or vote has expired. Use the current action.", language(current))
  const state: GameState = structuredClone(current)
  const player = state.players.find(player => player.id === action.actorId)!
  if (turn.kind === 'speak') {
    if (typeof action.text !== 'string' || !action.text.trim() || action.text.length > 2000) throw new GameRuleError("Enter a speech of 1\u20132000 characters.", language(current))
    if (/\[\[private|<!--\s*message_break/i.test(action.text)) throw new GameRuleError("Enter only the speech, without private-message or message-break directives.", language(current))
    if (state.kind === 'undercover' && player.word && action.text.includes(player.word)) throw new GameRuleError("Describe the word without saying it directly.", language(current))
    event(state, action.text.trim(), turn.audience, player)
  } else {
    if (typeof action.targetId !== 'string' || (action.targetId && !turn.targetIds.includes(action.targetId))) throw new GameRuleError("Select a valid target other than yourself or an eliminated player.", language(current))
    if (turn.kind === 'inspect') {
      const target = state.players.find(player => player.id === action.targetId)
      if (target) event(state, text(state, 'Inspection: {member} belongs to the {team} team.', { member: target.name, team: text(state, target.role === 'wolf' ? 'Wolf' : 'Good') }), [player.id])
    } else state.votes[player.id] = action.targetId
  }
  state.consecutiveSkippedTurns = 0
  state.revision++; state.pending.shift(); settle(state)
  return state
}

/** Called only after two completed but invalid model outputs, never on transport failure. */
export function skipGameTurn(current: GameState, slotId: string): GameState {
  const turn = nextGameTurn(current)
  if (!turn || turn.slotId !== slotId || current.players.find(player => player.id === turn.actorId)?.human) throw new GameRuleError("This action cannot be skipped.", language(current))
  const consecutive = (current.consecutiveSkippedTurns ?? 0) + 1
  if (consecutive >= 3) throw new GameRuleError("Three consecutive slots had no valid model output. Check player model settings before continuing.", language(current))
  const copy = structuredClone(current)
  if (turn.kind !== 'speak') event(copy, text(copy, "Two invalid model actions; abstaining or skipping under the rules."), turn.audience)
  const next = applyGameAction(copy, { slotId, actorId: turn.actorId, text: text(copy, "(No valid speech this turn; skipped under the rules.)"), targetId: '' })
  next.skippedTurns = (current.skippedTurns ?? 0) + 1
  next.consecutiveSkippedTurns = consecutive
  return next
}

export function gamePlayerView(state: GameState, actorId: string): object {
  const player = state.players.find(player => player.id === actorId)
  if (!player) throw new GameRuleError("Not a player in this game.", language(state))
  return { game: state.kind, language: language(state), round: state.round, phase: state.phase,
    player: { id: player.id, name: player.name, alive: player.alive, ...(state.kind === 'undercover' ? { word: player.word } : { role: player.role }) },
    players: state.players.map(({ id, name, alive }) => ({ id, name, alive })),
    messages: state.events.filter(event => event.audience === 'group' || event.audience.includes(actorId)).slice(-60),
    turn: nextGameTurn(state)?.actorId === actorId ? nextGameTurn(state) : undefined }
}

export function gameView(state: GameState): GameView {
  const human = state.players.find(player => player.human)
  const privateEvents = human ? state.events.filter(event => event.audience !== 'group' && event.audience.includes(human.id)) : []
  return { id: state.id, conversationId: state.conversationId, topicId: state.topicId, kind: state.kind, status: state.status, phase: state.phase,
    round: state.round, revision: state.revision, winner: state.winner, error: state.error,
    players: state.players.map(({ id, name, alive }) => ({ id, name, alive })),
    ...(human ? { human: { secret: privateEvents[0]?.text ?? '', messages: privateEvents,
      turn: nextGameTurn(state)?.actorId === human.id ? nextGameTurn(state) : undefined } } : {}) }
}
