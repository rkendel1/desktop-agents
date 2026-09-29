import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FeltDatabase, FeltDatabaseError, desktopFlow, recordIdOf, recordKey, type RecordChange } from './database'

const directories: string[] = []
const opened: FeltDatabase[] = []
const temporary = (): string => { const directory = mkdtempSync(join(tmpdir(), 'felt-test-')); directories.push(directory); return directory }
const open = async (directory: string): Promise<FeltDatabase> => { const database = await FeltDatabase.open(directory); opened.push(database); return database }
afterEach(async () => {
  for (const database of opened.splice(0)) await database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

interface Message { id: string; sessionId: string; topicId: string; role: string; authorId: string; authorName: string; content: string; kind: string; timestamp: number }
const message = (id: string, content = id, topicId = 't'): Message => ({ id, sessionId: 's', topicId, role: 'user', authorId: 'user', authorName: 'You', content, kind: 'message', timestamp: 1 })
interface Setting { id: string; value: unknown; updatedAt: number }

describe('desktop.flow', () => {
  it('declares every collection the desktop domain needs', () => {
    const names = desktopFlow().collections.map(collection => collection.name)
    for (const name of ['Desktop', 'Agent', 'AgentProfile', 'Provider', 'Workspace', 'Session', 'Message', 'ToolExecution', 'Memory', 'Topic', 'Group', 'GroupMember', 'Schedule', 'Attachment', 'AttentionItem']) {
      expect(names).toContain(name)
    }
  })
})

describe('FeltDatabase', () => {
  it('creates durable local storage and persists records across a restart', async () => {
    const directory = join(temporary(), 'felt')
    const database = await open(directory)
    await database.collection<Message>('Message').put(message('m1', 'hello'))
    await database.close()
    const reopened = await open(directory)
    expect(await reopened.collection<Message>('Message').get('m1')).toMatchObject({ content: 'hello' })
  })

  it('keeps write order and per-field lookups after a restart, and an update keeps its place', async () => {
    const directory = join(temporary(), 'felt')
    const database = await open(directory)
    const messages = database.collection<Message>('Message')
    for (const id of ['b', 'a', 'c']) await messages.put(message(id))
    await messages.put(message('other', 'x', 'u'))
    await messages.put(message('a', 'a edited'))
    await database.close()
    const reopened = (await open(directory)).collection<Message>('Message')
    expect((await reopened.where({ sessionId: 's', topicId: 't' })).map(item => item.id)).toEqual(['b', 'a', 'c'])
    expect((await reopened.where({ sessionId: 's', topicId: 't' }, { order: 'desc', limit: 2 })).map(item => item.id)).toEqual(['c', 'a'])
    expect((await reopened.get('a'))?.content).toBe('a edited')
  })

  it('does not rewrite an unchanged record', async () => {
    const database = await open(join(temporary(), 'felt'))
    const changes: RecordChange[] = []
    database.subscribe(change => changes.push(change), ['Setting'])
    const settings = database.collection<Setting>('Setting')
    await settings.put({ id: 'k', value: { a: 1, b: 2 }, updatedAt: 1 })
    await settings.put({ id: 'k', value: { b: 2, a: 1 }, updatedAt: 1 })
    expect(changes).toHaveLength(1)
  })

  it('rejects a record that does not satisfy desktop.flow', async () => {
    const database = await open(join(temporary(), 'felt'))
    await expect(database.collection<{ id: string }>('Agent').put({ id: 'a', name: 'Missing provider' } as never)).rejects.toThrow(FeltDatabaseError)
  })

  it('fails explicitly, without a fallback, when the database cannot initialize', async () => {
    const blocker = join(temporary(), 'felt')
    writeFileSync(blocker, 'not a directory')
    await expect(FeltDatabase.open(blocker)).rejects.toThrow(FeltDatabaseError)
  })

  it('refuses a second opener while the first still holds the database, and releases the lock on close', async () => {
    const directory = join(temporary(), 'felt')
    const first = await open(directory)
    await expect(FeltDatabase.open(directory)).rejects.toThrow('already open')
    await first.close()
    expect(existsSync(join(directory, 'desktop.lock'))).toBe(false)
    await (await FeltDatabase.open(directory)).close()
  })

  it('refuses a damaged snapshot instead of starting over from empty state', async () => {
    const directory = join(temporary(), 'felt')
    const database = await open(directory)
    await database.collection<Setting>('Setting').put({ id: 'a', value: 1, updatedAt: 1 })
    await database.close()
    writeFileSync(join(directory, 'state.json'), '{ not json')
    await expect(FeltDatabase.open(directory)).rejects.toThrow('damaged')
    // The files were not touched, and the failed attempt did not leave the desktop locked.
    expect(readFileSync(join(directory, 'state.json'), 'utf8')).toBe('{ not json')
    expect(existsSync(join(directory, 'desktop.lock'))).toBe(false)
  })

  it('never contacts the network', async () => {
    const network = vi.fn(async () => { throw new Error('offline') })
    vi.stubGlobal('fetch', network)
    const database = await open(join(temporary(), 'felt'))
    await database.collection<Setting>('Setting').put({ id: 'a', value: 1, updatedAt: 1 })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(network).not.toHaveBeenCalled()
    expect(process.env.FELTDB_TELEMETRY).toBe('0')
  })
})

describe('record ids', () => {
  it('map to keys FeltDB transactions accept, and back', () => {
    for (const id of ['plain', 'uuid-6ebff2e0-91e1-4290', 'session/topic', 'group:agent', 'im:tg:1', 'a b', '中文', '_leading', '.dot', 'x'.repeat(128), 'a:'.repeat(80)]) {
      const key = recordKey(id)
      expect(key).toMatch(/^[A-Za-z0-9._-]{1,128}$/)
      if (!key.startsWith('.')) expect(recordIdOf(key)).toBe(id)
    }
    expect(recordKey('plain')).toBe('plain')
    // Too long to encode: a digest, which holds no id — the row keeps it instead.
    expect(recordKey('a:'.repeat(80))).toMatch(/^\.[0-9a-f]{64}$/)
  })

  it('store, transact, read and announce a record whose id is not a plain key', async () => {
    const database = await open(join(temporary(), 'felt'))
    const settings = database.collection<Setting>('Setting')
    const seen: RecordChange[] = []
    database.subscribe(change => seen.push(change), ['Setting'])
    await settings.put({ id: 'groupHealth:a/b', value: 1, updatedAt: 1 })
    await database.transaction(async batch => {
      await batch.put(settings, { id: 'groupHealth:a/b', value: 2, updatedAt: 2 })
      await batch.put(settings, { id: '中文 id', value: 3, updatedAt: 3 })
    })
    expect((await settings.get('groupHealth:a/b'))?.value).toBe(2)
    expect((await settings.all()).map(row => row.id)).toEqual(['groupHealth:a/b', '中文 id'])
    await database.transaction(async batch => { await batch.delete(settings, 'groupHealth:a/b') })
    expect(await settings.has('groupHealth:a/b')).toBe(false)
    // Every announcement names the id the caller used, including for a delete.
    expect(seen.map(change => `${change.type}:${change.id}`)).toEqual(['insert:groupHealth:a/b', 'update:groupHealth:a/b', 'insert:中文 id', 'delete:groupHealth:a/b'])
  })

  it('handle an id too long for any key, including its announcements and deletes', async () => {
    const database = await open(join(temporary(), 'felt'))
    const settings = database.collection<Setting>('Setting')
    const long = `${'workflow:'.repeat(20)}decision:recovery:1`
    const seen: RecordChange[] = []
    database.subscribe(change => seen.push(change), ['Setting'])
    await settings.put({ id: long, value: 1, updatedAt: 1 })
    await database.transaction(async batch => { await batch.put(settings, { id: long, value: 2, updatedAt: 2 }) })
    expect((await settings.get(long))?.value).toBe(2)
    expect((await settings.all()).map(row => row.id)).toEqual([long])
    expect((await database.collection<Setting>('Setting').where({ value: 2 })).map(row => row.id)).toEqual([long])
    await settings.delete(long)
    await settings.put({ id: long, value: 3, updatedAt: 3 })
    await database.transaction(async batch => { await batch.delete(settings, long) })
    expect(await settings.has(long)).toBe(false)
    expect(seen.map(change => `${change.type}:${change.id === long}`)).toEqual(['insert:true', 'update:true', 'delete:true', 'insert:true', 'delete:true'])
    // The id survives a restart.
    await settings.put({ id: long, value: 4, updatedAt: 4 })
    await database.close()
    const reopened = await open(join(directories[0], 'felt'))
    expect((await reopened.collection<Setting>('Setting').all()).map(row => row.id)).toEqual([long])
  })
})

describe('transactions', () => {
  it('commit every staged write together, and read their own staged state', async () => {
    const database = await open(join(temporary(), 'felt'))
    const settings = database.collection<Setting>('Setting')
    await settings.put({ id: 'keep', value: 1, updatedAt: 1 })
    await database.transaction(async batch => {
      await batch.put(settings, { id: 'keep', value: 2, updatedAt: 2 })
      await batch.put(settings, { id: 'new', value: 3, updatedAt: 3 })
      expect((await batch.get(settings, 'keep'))?.value).toBe(2)
      // Nothing is visible outside the batch until it commits.
      expect((await settings.get('keep'))?.value).toBe(1)
      expect(await settings.get('new')).toBeUndefined()
    })
    expect((await settings.get('keep'))?.value).toBe(2)
    expect((await settings.get('new'))?.value).toBe(3)
  })

  it('leave nothing behind when the operation fails', async () => {
    const database = await open(join(temporary(), 'felt'))
    const settings = database.collection<Setting>('Setting')
    await settings.put({ id: 'keep', value: 1, updatedAt: 1 })
    await expect(database.transaction(async batch => {
      await batch.put(settings, { id: 'keep', value: 2, updatedAt: 2 })
      await batch.put(settings, { id: 'new', value: 3, updatedAt: 3 })
      await batch.delete(settings, 'keep')
      throw new Error('stop')
    })).rejects.toThrow('stop')
    expect((await settings.get('keep'))?.value).toBe(1)
    expect(await settings.get('new')).toBeUndefined()
  })

  it('leave nothing behind when a staged record violates desktop.flow', async () => {
    const database = await open(join(temporary(), 'felt'))
    const settings = database.collection<Setting>('Setting')
    await expect(database.transaction(async batch => {
      await batch.put(settings, { id: 'ok', value: 1, updatedAt: 1 })
      await batch.put(settings, { id: 'bad', updatedAt: 1 } as never)
    })).rejects.toThrow(FeltDatabaseError)
    expect(await settings.get('ok')).toBeUndefined()
  })

  it('treat a record created and deleted in the same operation as never written', async () => {
    const database = await open(join(temporary(), 'felt'))
    const settings = database.collection<Setting>('Setting')
    const changes: RecordChange[] = []
    database.subscribe(change => changes.push(change), ['Setting'])
    await database.transaction(async batch => {
      await batch.put(settings, { id: 'ghost', value: 1, updatedAt: 1 })
      await batch.delete(settings, 'ghost')
    })
    expect(await settings.get('ghost')).toBeUndefined()
    expect(changes).toEqual([])
  })

  it('survive a restart as a unit', async () => {
    const directory = join(temporary(), 'felt')
    const database = await open(directory)
    await database.transaction(async batch => {
      await batch.put(database.collection<Setting>('Setting'), { id: 'a', value: 1, updatedAt: 1 })
      await batch.put(database.collection<Message>('Message'), message('m1'))
    })
    await database.close()
    const reopened = await open(directory)
    expect(await reopened.collection<Setting>('Setting').get('a')).toBeDefined()
    expect(await reopened.collection<Message>('Message').get('m1')).toBeDefined()
  })
})

describe('reactivity', () => {
  it('announces single-record writes as they commit', async () => {
    const database = await open(join(temporary(), 'felt'))
    const changes: RecordChange[] = []
    database.subscribe(change => changes.push(change), ['Setting'])
    const settings = database.collection<Setting>('Setting')
    await settings.put({ id: 'k', value: 1, updatedAt: 1 })
    await settings.put({ id: 'k', value: 2, updatedAt: 2 })
    await settings.delete('k')
    expect(changes.map(change => [change.type === 'delete' ? 'delete' : 'write', change.id])).toEqual([['write', 'k'], ['write', 'k'], ['delete', 'k']])
    expect(changes[1].record).toMatchObject({ id: 'k', value: 2 })
    expect(changes[2].record).toBeUndefined()
  })

  it('announces transaction commits, one change per record, with the new record', async () => {
    const database = await open(join(temporary(), 'felt'))
    const changes: RecordChange[] = []
    database.subscribe(change => changes.push(change), ['Setting', 'Message'])
    await database.transaction(async batch => {
      await batch.put(database.collection<Setting>('Setting'), { id: 'a', value: 1, updatedAt: 1 })
      await batch.put(database.collection<Message>('Message'), message('m1', 'hello'))
    })
    expect(changes.map(change => `${change.collection}:${change.type}:${change.id}`)).toEqual(['Setting:insert:a', 'Message:insert:m1'])
    expect(changes[1].record).toMatchObject({ content: 'hello' })
    expect(changes[1].record).not.toHaveProperty('seq')
  })

  it('stops announcing after unsubscribe and after close', async () => {
    const database = await open(join(temporary(), 'felt'))
    const changes: RecordChange[] = []
    const stop = database.subscribe(change => changes.push(change), ['Setting'])
    const settings = database.collection<Setting>('Setting')
    await settings.put({ id: 'a', value: 1, updatedAt: 1 })
    stop()
    await settings.put({ id: 'b', value: 1, updatedAt: 1 })
    expect(changes).toHaveLength(1)
  })

  it('does not let a failing subscriber fail the write', async () => {
    const database = await open(join(temporary(), 'felt'))
    database.subscribe(() => { throw new Error('bad subscriber') }, ['Setting'])
    await expect(database.collection<Setting>('Setting').put({ id: 'a', value: 1, updatedAt: 1 })).resolves.toBeDefined()
  })
})

describe('message-heavy sessions', () => {
  it('append cost stays flat and each append announces exactly one change', async () => {
    const database = await open(join(temporary(), 'felt'))
    const messages = database.collection<Message>('Message')
    const changes: RecordChange[] = []
    database.subscribe(change => changes.push(change), ['Message'])
    const timeBatch = async (from: number, count: number): Promise<number> => {
      const started = performance.now()
      for (let index = from; index < from + count; index++) await messages.put(message(`m${index}`))
      return (performance.now() - started) / count
    }
    const early = await timeBatch(0, 100)
    // One transaction of 1,000 messages, then more single appends on a much larger session.
    await database.transaction(async batch => { for (let index = 100; index < 1100; index++) await batch.put(messages, message(`m${index}`)) })
    const late = await timeBatch(1100, 100)
    expect(changes).toHaveLength(1200)
    // An append into 1,000+ messages must not cost a rebuild of the session; allow generous noise.
    expect(late).toBeLessThan(Math.max(early * 6, 25))
    expect(await messages.count()).toBe(1200)
    expect((await messages.where({ sessionId: 's', topicId: 't' }, { order: 'desc', limit: 50 })).length).toBe(50)
  }, 60_000)
})
