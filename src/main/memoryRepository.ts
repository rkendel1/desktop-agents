import { createHash } from 'node:crypto'
import type { Batch, FeltDatabase, Records } from './felt/database'
import {
  emptyUserMemory, LOCAL_USER_ID, validateUserMemory,
  type MemorySearchHit, type UserMemoryDocument, type UserMemoryEdit
} from '../shared/userMemory'

export interface MemoryRecord {
  id: string
  scope: 'user' | 'agent' | 'group' | 'history'
  agentId?: string
  groupId?: string
  revision: number
  updatedAt: number
  document: unknown
}

export interface MemoryHistoryEntry { key: string; text: string; timestamp: string; kind?: 'profile' | 'memory'; evidence?: string; sourceAgentId?: string }
export interface MemoryWriteOptions { retainRemovedKeys?: string[]; forgetKeys?: string[]; clearHistory?: boolean }
interface HistoryDay { date: string; entries: MemoryHistoryEntry[] }

const localDate = (now: Date): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

/**
 * What the desktop remembers, stored as FeltDB `Memory` records: the shared
 * profile, each agent's own memory, each group's memory, and a dated history
 * of everything that changed. Nothing is mirrored into files.
 */
export class MemoryRepository {
  readonly user: UserMemories
  readonly group: GroupMemories

  /** `exclusive` serializes read-then-write operations with the rest of the repository. */
  constructor(felt: FeltDatabase, private readonly rows: Records<MemoryRecord>, agentExists: (id: string) => Promise<boolean>, isGroup: (id: string) => Promise<boolean>,
    exclusive: <T>(work: () => Promise<T>) => Promise<T>) {
    this.user = new UserMemories(felt, rows, agentExists, exclusive)
    this.group = new GroupMemories(felt, rows, isGroup, agentExists, exclusive)
  }

  async stageRemoveAgent(batch: Batch, agentId: string): Promise<void> {
    await batch.deleteWhere(this.rows, { agentId })
  }

  async stageRemoveGroup(batch: Batch, groupId: string): Promise<void> {
    await batch.deleteWhere(this.rows, { groupId })
  }
}

class UserMemories {
  constructor(private readonly felt: FeltDatabase, private readonly rows: Records<MemoryRecord>, private readonly agentExists: (id: string) => Promise<boolean>,
    private readonly exclusive: <T>(work: () => Promise<T>) => Promise<T>) {}

  private key(agentId?: string): string { return agentId ? `agent:${agentId}` : 'user:shared' }
  private historyKey(agentId: string | undefined, date: string): string { return `history:${agentId ?? 'shared'}:${date}` }

  private async authorize(agentId?: string): Promise<void> {
    if (agentId !== undefined && (!agentId || !(await this.agentExists(agentId)))) throw new Error('Agent not found')
  }

  async read(agentId?: string): Promise<UserMemoryDocument> {
    await this.authorize(agentId)
    const row = await this.rows.get(this.key(agentId))
    return row ? { ...(row.document as UserMemoryDocument), userId: LOCAL_USER_ID, agentId } : emptyUserMemory(LOCAL_USER_ID, agentId)
  }

  save(input: UserMemoryDocument, agentId?: string, options: MemoryWriteOptions = {}): Promise<UserMemoryDocument> {
    return this.exclusive(async () => {
      await this.authorize(agentId)
      if (input?.agentId !== agentId || input.groupId !== undefined) throw new Error('Memory scope changed. Reopen memory settings.')
      const document = validateUserMemory(input)
      const current = await this.read(agentId)
      if (document.revision !== current.revision) throw new Error('Memory changed. Reload before saving to avoid overwriting newer information.')
      const next = { ...document, userId: LOCAL_USER_ID, revision: current.revision + 1, updatedAt: Date.now() }
      // The memory and its dated history commit together.
      await this.felt.transaction(async batch => {
        await this.recordHistory(batch, next, current, agentId, { ...options, clearHistory: options.clearHistory || input.clearHistory === true })
        await batch.put(this.rows, { id: this.key(agentId), scope: agentId ? 'agent' : 'user', ...(agentId ? { agentId } : {}), revision: next.revision, updatedAt: next.updatedAt, document: next })
      })
      return next
    })
  }

  /** Dates that have history, newest first. */
  async dates(agentId?: string): Promise<string[]> {
    return (await this.rows.where({ scope: 'history', ...(agentId ? { agentId } : {}) }))
      .filter(row => agentId ? row.agentId === agentId : row.agentId === undefined)
      .map(row => (row.document as HistoryDay).date).sort().reverse()
  }

  private async entries(agentId: string | undefined, date: string): Promise<MemoryHistoryEntry[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid memory date')
    return ((await this.rows.get(this.historyKey(agentId, date)))?.document as HistoryDay | undefined)?.entries ?? []
  }

  private async recordHistory(batch: Batch, document: UserMemoryDocument, previous: UserMemoryDocument, agentId: string | undefined, options: MemoryWriteOptions): Promise<void> {
    const retained = new Set(options.retainRemovedKeys ?? [])
    const removed = new Set([...(options.forgetKeys ?? []), ...previous.facts.filter(old => !document.facts.some(f => f.key === old.key) && !retained.has(old.key)).map(f => f.key)])
    if (previous.notes && !document.notes) removed.add('__profile_notes')
    if (previous.memoryNotes && !document.memoryNotes) removed.add('__memory_notes')
    const now = new Date(), date = localDate(now)
    const updated: MemoryHistoryEntry[] = document.facts.filter(f => {
      const old = previous.facts.find(item => item.key === f.key)
      return !old || old.text !== f.text || (old.kind ?? 'memory') !== (f.kind ?? 'memory')
    }).map(f => ({ ...f, timestamp: now.toISOString() }))
    for (const [key, content, old, kind] of [
      ['__profile_notes', document.notes, previous.notes, 'profile'],
      ['__memory_notes', document.memoryNotes, previous.memoryNotes, 'memory']
    ] as const) if (content && content !== old) updated.push({ key, text: content, kind, timestamp: now.toISOString() })
    const days = await this.dates(agentId)
    if (updated.length && !days.includes(date)) days.push(date)
    for (const day of days) {
      if (!options.clearHistory && !removed.size && day !== date) continue
      const old = await this.entries(agentId, day)
      const entries = options.clearHistory ? [] : old.filter(entry => !removed.has(entry.key))
      if (day === date) entries.push(...updated)
      if (entries.length !== old.length || day === date || options.clearHistory) {
        const id = this.historyKey(agentId, day)
        if (!entries.length) await batch.delete(this.rows, id)
        else await batch.put(this.rows, { id, scope: 'history', ...(agentId ? { agentId } : {}), revision: 0, updatedAt: Date.now(), document: { date: day, entries } satisfies HistoryDay })
      }
    }
  }

  async hasHistory(agentId?: string): Promise<boolean> { return (await this.dates(agentId)).length > 0 }

  async search(query: string, agentId: string): Promise<{ hits: MemorySearchHit[]; truncated: boolean }> {
    await this.authorize(agentId)
    if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new Error('Search requires 1–500 characters')
    const words = [...new Set([...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(query.normalize('NFKC').toLowerCase())].filter(part => part.isWordLike).map(part => part.segment))]
    const results: (MemorySearchHit & { score: number })[] = []
    let truncated = false
    for (const id of [undefined, agentId]) {
      const scope = id ? 'agent' : 'shared'
      const current = await this.read(id)
      const add = (key: string, text: string, path: string, timestamp: string, historical: boolean) => {
        if (!text.trim()) return
        const normalized = `${key} ${path} ${timestamp} ${text}`.normalize('NFKC').toLowerCase()
        const score = words.filter(word => normalized.includes(word)).length
        if (!score) return
        const body = text.normalize('NFKC').toLowerCase()
        const at = Math.max(0, body.indexOf(words.find(word => body.includes(word)) ?? '') - 150)
        results.push({ scope, key, text: text.slice(at, at + 1000), path, timestamp, historical, score })
      }
      for (const fact of current.facts) add(fact.key, fact.text, fact.kind === 'profile' ? 'USER.md' : 'MEMORY.md', new Date(current.updatedAt).toISOString(), false)
      add('__profile_notes', current.notes, 'USER.md', '', false)
      add('__memory_notes', current.memoryNotes ?? '', 'MEMORY.md', '', false)
      const dates = await this.dates(id)
      truncated ||= dates.length > 5000
      for (const date of dates.slice(0, 5000)) {
        for (const entry of await this.entries(id, date)) {
          if (current.facts.some(f => f.key === entry.key && f.text === entry.text)) continue
          add(entry.key, entry.text, `memory/${date}.md`, entry.timestamp, true)
        }
      }
    }
    results.sort((a, b) => b.score - a.score || Number(a.historical) - Number(b.historical) || b.timestamp.localeCompare(a.timestamp))
    return { hits: results.slice(0, 8).map(({ score: _score, ...hit }) => hit), truncated: truncated || results.length > 8 }
  }

  async readHistory(scope: 'shared' | 'agent', date: string, agentId: string, offset = 0): Promise<{ text: string; nextOffset?: number }> {
    await this.authorize(agentId)
    if (!['shared', 'agent'].includes(scope) || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid memory history request')
    const day = date.replace(/\.md$/, '')
    const entries = await this.entries(scope === 'agent' ? agentId : undefined, day)
    const text = entries.map(entry => `${entry.timestamp} [${entry.key}]\n${entry.text}`).join('\n\n')
    return { text: text.slice(offset, offset + 8000), ...(text.length > offset + 8000 ? { nextOffset: offset + 8000 } : {}) }
  }

  remember(input: UserMemoryEdit, agentId: string, humanText: string): Promise<void> {
    return this.exclusive(async () => {
      await this.authorize(agentId)
      if (!input || !['shared', 'agent'].includes(input.scope) || !['remember', 'forget'].includes(input.action)
        || typeof input.key !== 'string' || !input.key.trim() || input.key.length > 100
        || typeof input.evidence !== 'string' || !input.evidence.trim() || input.evidence.length > 2000 || !humanText.includes(input.evidence)) throw new Error('Memory must be supported by the current human message')
      if (input.kind !== undefined && !['profile', 'memory'].includes(input.kind)) throw new Error('Invalid memory kind')
      if (input.scope === 'shared' && input.action === 'remember' && input.shareWithAll !== true) throw new Error('Shared memory requires an explicit request to share with other agents')
      const shared = await this.read(undefined), personal = await this.read(agentId)
      if (!shared.autoRemember || !personal.autoRemember) throw new Error('Automatic memory is disabled')
      const document = input.scope === 'shared' ? shared : personal
      const facts = document.facts.filter(fact => fact.key !== input.key)
      if (input.action === 'remember') {
        if (input.key.startsWith('__')) throw new Error('Reserved memory key')
        if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('Memory text is required')
        facts.push({ key: input.key, text: input.text, kind: input.kind ?? 'memory', savedAt: Date.now(), evidence: input.evidence, sourceAgentId: agentId })
      }
      // Retain a bounded current summary; evicted memory remains searchable by date.
      if (input.action === 'forget' && input.key === '__profile_notes') document.notes = ''
      if (input.action === 'forget' && input.key === '__memory_notes') document.memoryNotes = ''
      const archived: string[] = []
      const size = () => document.notes.length + (document.memoryNotes?.length ?? 0) + facts.reduce((total, fact) => total + fact.text.length, 0)
      while (facts.length > 100 || size() > 20000) {
        const oldest = facts.filter(fact => fact.key !== input.key && fact.kind !== 'profile').sort((a, b) => (a.savedAt ?? 0) - (b.savedAt ?? 0))[0]
        const index = oldest ? facts.indexOf(oldest) : -1
        if (index < 0) throw new Error('User profile is full; consolidate existing profile facts first')
        archived.push(facts.splice(index, 1)[0].key)
      }
      await this.save({ ...document, facts }, input.scope === 'agent' ? agentId : undefined, {
        retainRemovedKeys: archived, forgetKeys: input.action === 'forget' ? [input.key] : undefined
      })
    })
  }
}

class GroupMemories {
  constructor(private readonly felt: FeltDatabase, private readonly rows: Records<MemoryRecord>, private readonly isGroup: (id: string) => Promise<boolean>,
    private readonly agentExists: (id: string) => Promise<boolean>, private readonly exclusive: <T>(work: () => Promise<T>) => Promise<T>) {}

  private async authorize(groupId: string): Promise<void> {
    if (!(await this.isGroup(groupId))) throw new Error('Group not found')
  }

  async read(groupId: string): Promise<UserMemoryDocument> {
    await this.authorize(groupId)
    const row = await this.rows.get(`group:${groupId}`)
    return { ...(row ? row.document as UserMemoryDocument : emptyUserMemory(LOCAL_USER_ID)), userId: LOCAL_USER_ID, groupId, agentId: undefined }
  }

  save(input: UserMemoryDocument, groupId: string): Promise<UserMemoryDocument> {
    return this.exclusive(async () => {
      await this.authorize(groupId)
      if (input?.groupId !== groupId || input.agentId !== undefined) throw new Error('Memory scope changed. Reopen memory settings.')
      const document = validateUserMemory(input), current = await this.read(groupId)
      if (document.revision !== current.revision) throw new Error('Memory changed. Reload before saving to avoid overwriting newer information.')
      const next = { ...document, userId: LOCAL_USER_ID, revision: current.revision + 1, updatedAt: Date.now() }
      await this.felt.transaction(batch => batch.put(this.rows, { id: `group:${groupId}`, scope: 'group', groupId, revision: next.revision, updatedAt: next.updatedAt, document: next }))
      return next
    })
  }

  remember(input: UserMemoryEdit, groupId: string, agentId: string, speaker: { id: string; name: string }, humanText: string): Promise<void> {
    return this.exclusive(async () => {
      await this.authorize(groupId)
      if (!(await this.agentExists(agentId))) throw new Error('Agent not found')
      if (!speaker.id || !input || input.scope !== 'group' || !['remember', 'forget'].includes(input.action)
        || typeof input.key !== 'string' || !input.key.trim() || input.key.length > 100
        || typeof input.evidence !== 'string' || !input.evidence.trim() || input.evidence.length > 2000 || !humanText.includes(input.evidence)) throw new Error('Group memory must be supported by the current human message')
      const document = await this.read(groupId)
      if (!document.autoRemember) throw new Error('Automatic group memory is disabled')
      // The model never selects a speaker ID. Identical keys from different speakers cannot collide.
      const key = createHash('sha256').update(JSON.stringify([speaker.id, input.key])).digest('hex')
      const facts = document.facts.filter(fact => fact.key !== key)
      if (input.action === 'remember') {
        if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('Memory text is required')
        facts.push({ key, memoryKey: input.key, text: input.text, evidence: input.evidence, sourceAgentId: agentId, subjectId: speaker.id, subjectName: speaker.name })
      }
      await this.save({ ...document, facts }, groupId)
    })
  }
}

export type { UserMemories, GroupMemories }
