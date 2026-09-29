import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { validateUserMemory, type UserMemoryDocument } from '../../shared/userMemory'

/**
 * Read-only access to the memory Markdown files that earlier releases kept
 * beside the database. They are read once, by the legacy import, and never
 * written again: memory now lives in FeltDB.
 */
const marker = '<!-- douchat-memory:'
const entryMarker = '<!-- douchat-entry:'
export interface LegacyHistoryEntry { key: string; text: string; timestamp: string; kind?: 'profile' | 'memory'; evidence?: string; sourceAgentId?: string }

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

export function legacyProfileDirectory(root: string, owner: string, agent?: string): string {
  return join(root, hash(owner), ...(agent ? ['agents', hash(agent)] : ['shared']))
}

export function parseMemoryMarkdown(text: string, userId: string, agentId?: string): UserMemoryDocument {
  if (text.length > 500_000) throw new Error('Memory file exceeds the size limit')
  const chunks = [...text.matchAll(/<!-- douchat-memory:(.*?) -->/g)]
  if (!chunks.length) throw new Error('Memory metadata is missing.')
  const header = JSON.parse(chunks[0][1])
  if ((header.format === 2 && !['profile', 'memory'].includes(header.section)) || ![1, 2].includes(header.format) || header.userId !== userId || header.agentId !== agentId || header.groupId !== undefined) throw new Error('Memory account or agent does not match')
  const body = (index: number) => text.slice(chunks[index].index! + chunks[index][0].length, chunks[index + 1]?.index ?? text.length).trim()
  const document = validateUserMemory({ ...header, notes: body(0), facts: chunks.slice(1).map((chunk, index) => {
    const entry = JSON.parse(chunk[1])
    if (!entry.fact) throw new Error('Invalid memory fact metadata')
    return { ...entry.fact, ...(header.format === 2 ? { kind: header.section === 'profile' ? 'profile' : 'memory' } : {}), text: body(index + 1) }
  }) })
  return { ...document, updatedAt: typeof header.updatedAt === 'number' ? header.updatedAt : 0 }
}

function historyEntries(text: string): LegacyHistoryEntry[] {
  const chunks = [...text.matchAll(/<!-- douchat-entry:(.*?) -->/g)]
  return chunks.map((chunk, i) => {
    const entry = JSON.parse(chunk[1])
    if (typeof entry.key !== 'string' || typeof entry.timestamp !== 'string') throw new Error('Invalid memory history metadata')
    return { ...entry, text: text.slice(chunk.index! + chunk[0].length, chunks[i + 1]?.index ?? text.length).trim() }
  })
}

export class LegacyMemoryFiles {
  constructor(private root: string) {}
  private directory(userId: string, agentId?: string): string { return legacyProfileDirectory(this.root, userId, agentId) }
  read(userId: string, agentId?: string): UserMemoryDocument | undefined {
    const path = join(this.directory(userId, agentId), 'USER.md')
    if (!existsSync(path)) return undefined
    const text = readFileSync(path, 'utf8')
    const profile = parseMemoryMarkdown(text, userId, agentId)
    const memoryPath = join(this.directory(userId, agentId), 'MEMORY.md')
    if (!/"format":2/.test(text.split('\n').find(line => line.startsWith(marker)) ?? '') || !existsSync(memoryPath)) return profile
    const memory = parseMemoryMarkdown(readFileSync(memoryPath, 'utf8'), userId, agentId)
    const merged = validateUserMemory({ ...profile, ...(memory.notes ? { memoryNotes: memory.notes } : {}), facts: [...profile.facts, ...memory.facts], revision: Math.max(profile.revision, memory.revision) })
    return { ...merged, updatedAt: Math.max(profile.updatedAt, memory.updatedAt) }
  }
  history(userId: string, agentId?: string): { date: string; entries: LegacyHistoryEntry[] }[] {
    const directory = join(this.directory(userId, agentId), 'memory')
    if (!existsSync(directory)) return []
    return readdirSync(directory).filter(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort().flatMap(name => {
      const path = join(directory, name)
      if (statSync(path).size > 4_000_000) return []
      return [{ date: name.slice(0, -3), entries: historyEntries(readFileSync(path, 'utf8')) }]
    })
  }
}

void entryMarker
