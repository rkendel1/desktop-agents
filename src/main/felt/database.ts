import {
  createFeltDB, getReactiveDependencyGraph, parseFlowSpec, validateFlowSpec,
  type FlowCollection, type FlowSpec, type StateFirstDB
} from '@feltdb/core'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import desktopFlowSource from './desktop.flow?raw'

/** Bumped only when a stored record shape changes incompatibly. */
export const DESKTOP_SCHEMA_VERSION = 1

/**
 * FeltDB could not be opened, or a record does not satisfy `desktop.flow`.
 * The desktop never answers this by falling back to another persistence layer.
 */
export class FeltDatabaseError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(cause instanceof Error ? `${message}: ${cause.message}` : message)
    this.name = 'FeltDatabaseError'
  }
}

export function desktopFlow(): FlowSpec {
  const spec = parseFlowSpec(desktopFlowSource)
  const errors = validateFlowSpec(spec).filter(diagnostic => diagnostic.severity === 'error')
  if (errors.length) throw new FeltDatabaseError(`desktop.flow is invalid: ${errors.map(error => error.message).join('; ')}`)
  return spec
}

export const desktopFlowDigest = (): string => createHash('sha256').update(desktopFlowSource).digest('hex')

/** What FeltDB tells a subscriber: which record of which collection changed, and how. */
export interface RecordChange {
  collection: string
  type: 'insert' | 'update' | 'delete'
  id: string
  /** The record after the change, without storage fields. Absent for a delete. */
  record?: Record<string, unknown>
}

/**
 * FeltDB transactions accept only keys of letters, digits, `.`, `_` and `-`
 * (at most 128). The desktop's ids are richer — a topic is `session/topic`, a
 * message id may hold `:` or be long — so a key is:
 *   - the id itself when that is allowed;
 *   - `_` + the id's UTF-8 bytes in base64url, when that fits;
 *   - `.` + the id's SHA-256 in hex, otherwise.
 * Whenever the key differs from the id the row also keeps the id (`rid`), so
 * callers only ever see ids.
 */
const SAFE_KEY = /^[A-Za-z0-9-][A-Za-z0-9._-]{0,127}$/
export function recordKey(id: string): string {
  if (SAFE_KEY.test(id)) return id
  const encoded = `_${Buffer.from(id, 'utf8').toString('base64url')}`
  return encoded.length <= 128 ? encoded : `.${createHash('sha256').update(id, 'utf8').digest('hex')}`
}
/** The id a key was made from, when the key alone can say (a hashed key cannot). */
export function recordIdOf(key: string): string {
  return key.startsWith('_') ? Buffer.from(key.slice(1), 'base64url').toString('utf8') : key
}

type Stored<T> = T & { id: string; seq: number; __version?: number; rid?: string }

const TYPE_CHECKS: Record<string, (value: unknown) => boolean> = {
  text: value => typeof value === 'string',
  integer: value => Number.isInteger(value),
  number: value => typeof value === 'number' && Number.isFinite(value),
  boolean: value => typeof value === 'boolean',
  json: value => value !== undefined
}

/** Key order must not decide whether a record "changed". */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    }
    return item
  })
}

/** What callers see: the record as they wrote it, with none of FeltDB's storage fields. */
function strip<T>(row: Stored<T>): T {
  const { seq: _seq, __version: _version, rid, ...rest } = row
  // FeltDB stores the key in `id`; `rid` holds the id when the two differ.
  return structuredClone({ ...rest, id: rid ?? rest.id }) as unknown as T
}

export interface PageRequest {
  where?: { field: string; eq?: unknown; neq?: unknown; lt?: unknown; lte?: unknown; gt?: unknown; gte?: unknown }[]
  order?: 'asc' | 'desc'
  limit: number
}

/**
 * One FeltDB collection, typed by `desktop.flow`.
 *
 * This is a handle, not a copy: every read is answered by FeltDB and every
 * write is acknowledged by FeltDB before it resolves. It keeps no rows.
 */
export class Records<T extends { id: string }> {
  private readonly required: { name: string; type: string }[]

  constructor(private readonly database: FeltDatabase, readonly name: string, definition: FlowCollection) {
    this.required = definition.fields.filter(field => !field.optional).map(field => ({ name: field.name, type: field.type }))
  }

  /** @internal */
  private get collection() { return this.database.db.collection<Stored<T>>(this.name) }

  /** @internal Raw stored form, including the write-order field. */
  async stored(id: string): Promise<Stored<T> | undefined> {
    return (await this.collection.get(recordKey(id))) ?? undefined
  }

  /** @internal The stored form of a record: its own fields, its write position, and its id when the key cannot carry it. */
  private row(record: T, previous?: Stored<T>): Stored<T> {
    const key = recordKey(record.id)
    return { ...record, id: record.id, seq: previous?.seq ?? this.database.nextSequence(), ...(key !== record.id ? { rid: record.id } : {}) } as Stored<T>
  }

  /** @internal */
  validate(record: T): void {
    for (const field of this.required) {
      const value = (record as Record<string, unknown>)[field.name]
      const check = TYPE_CHECKS[field.type]
      if (value === undefined || (check && !check(value))) {
        throw new FeltDatabaseError(`${this.name}.${field.name} must be ${field.type} (desktop.flow)`)
      }
    }
  }

  async get(id: string): Promise<T | undefined> {
    const row = await this.stored(id)
    return row ? strip(row) : undefined
  }

  async has(id: string): Promise<boolean> {
    return this.collection.exists(recordKey(id))
  }

  async count(): Promise<number> {
    return this.collection.count()
  }

  /** Every record, in the order it was first written. */
  async all(): Promise<T[]> {
    const rows = await this.collection.find({}, { orderBy: [{ field: 'seq', direction: 'asc' }] })
    return rows.map(strip)
  }

  /** Records whose fields equal `query`, in write order (or newest first). */
  async where(query: Partial<T>, options: { limit?: number; order?: 'asc' | 'desc' } = {}): Promise<T[]> {
    const rows = await this.collection.find(query as Partial<Stored<T>>, {
      orderBy: [{ field: 'seq', direction: options.order ?? 'asc' }],
      ...(options.limit !== undefined ? { limit: options.limit } : {})
    })
    return rows.map(strip)
  }

  /** A bounded page through FeltDB's query engine, for range conditions. */
  async page(request: PageRequest): Promise<T[]> {
    const page = await this.database.db.query<Stored<T>>({
      collection: this.name,
      where: request.where ?? [],
      orderBy: [{ field: 'seq', direction: request.order ?? 'asc' }],
      limit: request.limit
    })
    return page.records.map(strip)
  }

  /** Insert or replace. An unchanged record is not rewritten. */
  async put(record: T): Promise<T> {
    this.validate(record)
    const previous = await this.stored(record.id)
    const next = this.row(record, previous)
    if (previous && canonical(strip(previous)) === canonical(strip(next))) return strip(next)
    await this.collection.put(next as Partial<Stored<T>>, recordKey(record.id))
    return strip(next)
  }

  async delete(id: string): Promise<boolean> {
    const key = recordKey(id)
    if (!(await this.collection.exists(key))) return false
    await this.database.deleting(this.name, key, id, () => this.collection.delete(key))
    return true
  }

  /** Delete every record matching `query`; returns how many were removed. */
  async deleteWhere(query: Partial<T>): Promise<number> {
    let removed = 0
    for (const record of await this.where(query)) if (await this.delete(record.id)) removed++
    return removed
  }

  /** @internal Field-level flow check plus stored position, for staging in a batch. */
  async prepare(record: T, overlay?: Stored<T>): Promise<{ next: Stored<T>; previous?: Stored<T>; changed: boolean }> {
    this.validate(record)
    const previous = overlay ?? await this.stored(record.id)
    const next = this.row(record, previous)
    return { next, previous, changed: !previous || canonical(strip(previous)) !== canonical(strip(next)) }
  }
}

type Operation =
  | { kind: 'put'; collection: string; id: string; value: Stored<{ id: string }>; existed: boolean }
  | { kind: 'delete'; collection: string; id: string; existed: boolean }

/**
 * The writes of one logical operation. Nothing reaches FeltDB until the
 * operation finishes; then every write commits in a single FeltDB transaction,
 * or none does.
 */
export class Batch {
  private readonly operations = new Map<string, Operation>()

  constructor(private readonly database: FeltDatabase) {}

  private key(collection: string, id: string): string { return `${collection}:${id}` }

  /** Reads see this batch's own staged writes over what FeltDB holds. */
  async get<T extends { id: string }>(records: Records<T>, id: string): Promise<T | undefined> {
    const staged = this.operations.get(this.key(records.name, id))
    if (staged) return staged.kind === 'put' ? strip(staged.value as Stored<T>) : undefined
    return records.get(id)
  }

  async put<T extends { id: string }>(records: Records<T>, record: T): Promise<void> {
    const key = this.key(records.name, record.id)
    const staged = this.operations.get(key)
    const overlay = staged?.kind === 'put' ? staged.value as Stored<T> : undefined
    const { next, previous, changed } = await records.prepare(record, overlay)
    if (!changed) return
    const existed = staged ? staged.existed : previous !== undefined
    this.operations.set(key, { kind: 'put', collection: records.name, id: record.id, value: next, existed })
  }

  async delete<T extends { id: string }>(records: Records<T>, id: string): Promise<void> {
    const key = this.key(records.name, id)
    const staged = this.operations.get(key)
    const existed = staged ? staged.existed : await records.has(id)
    if (!existed && !staged) return
    this.operations.set(key, { kind: 'delete', collection: records.name, id, existed })
  }

  async deleteWhere<T extends { id: string }>(records: Records<T>, query: Partial<T>): Promise<void> {
    for (const record of await records.where(query)) await this.delete(records, record.id)
  }

  /** @internal */
  staged(): Operation[] {
    // A record created and deleted inside the same batch never existed.
    return [...this.operations.values()].filter(operation => !(operation.kind === 'delete' && !operation.existed))
  }
}

/**
 * The desktop's durable local authority: an embedded @feltdb/core database
 * whose collections are defined by `desktop.flow`.
 *
 * Opening fails closed. If FeltDB cannot start — or would start on anything
 * other than durable local storage — the caller gets a `FeltDatabaseError`.
 * There is no second store to fall back to.
 */
export class FeltDatabase {
  readonly flow: FlowSpec
  private readonly records = new Map<string, Records<{ id: string }>>()
  private readonly unsubscribes = new Set<() => void>()
  private sequence = 0
  private closed = false
  /** While a delete is announced, the id its key was made from — a hashed key cannot say. Lives only for that call. */
  private readonly announcing = new Map<string, string>()

  private constructor(readonly directory: string, readonly db: StateFirstDB, private readonly lockPath: string) {
    this.flow = desktopFlow()
    for (const collection of this.flow.collections) this.records.set(collection.name, new Records(this, collection.name, collection))
  }

  /**
   * One process owns the desktop's state. FeltDB serializes writers, but the
   * lock makes a second desktop fail loudly instead of interleaving with the first.
   */
  private static acquire(directory: string): string {
    const path = join(directory, 'desktop.lock')
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, 'wx', 0o600)
        writeSync(fd, String(process.pid))
        closeSync(fd)
        return path
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        let holder = 0
        try { holder = Number(readFileSync(path, 'utf8')) } catch { /* unreadable: treat as stale */ }
        let alive = false
        if (holder > 0) {
          try { process.kill(holder, 0); alive = true } catch (kill) { alive = (kill as NodeJS.ErrnoException).code === 'EPERM' }
        }
        if (alive) throw new FeltDatabaseError(`FeltDB at ${directory} is already open (process ${holder})`)
        rmSync(path, { force: true })
      }
    }
    throw new FeltDatabaseError(`FeltDB at ${directory} could not be locked`)
  }

  /**
   * FeltDB answers an unreadable snapshot with no usable backup by starting
   * over from empty state, which would hide every record the journal still
   * holds. The desktop refuses instead, and leaves the files as they are.
   */
  private static assertReadable(directory: string): void {
    const parses = (file: string): boolean | undefined => {
      let text: string
      try { text = readFileSync(join(directory, file), 'utf8') } catch { return undefined }
      try { JSON.parse(text); return true } catch { return false }
    }
    if (parses('state.json') === false && parses('state.json.backup') !== true) {
      throw new FeltDatabaseError(`The desktop's data in ${directory} is damaged and has no usable backup. It was left untouched; restore it from a backup or move it aside to start fresh.`)
    }
  }

  static async open(directory: string): Promise<FeltDatabase> {
    let lockPath: string
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      FeltDatabase.assertReadable(directory)
      lockPath = FeltDatabase.acquire(directory)
    } catch (error) {
      throw error instanceof FeltDatabaseError ? error : new FeltDatabaseError(`FeltDB could not open ${directory}`, error)
    }
    // FeltDB reports anonymous usage unless told not to. This desktop is
    // local-first and never contacts a service it was not asked to.
    process.env.FELTDB_TELEMETRY = '0'
    let db: StateFirstDB | undefined
    try {
      db = createFeltDB({ namespace: 'desktop', mode: 'local', path: directory })
      const runtime = db.runtime()
      if (runtime.storage !== 'file' || !runtime.persistent || !runtime.durable || !runtime.reactive) {
        throw new FeltDatabaseError(`FeltDB opened ${runtime.storage} storage instead of durable local storage`)
      }
      const database = new FeltDatabase(directory, db, lockPath)
      await database.validate()
      return database
    } catch (error) {
      try { await db?.close() } catch { /* the original failure is the useful one */ }
      rmSync(lockPath, { force: true })
      throw error instanceof FeltDatabaseError ? error : new FeltDatabaseError(`FeltDB could not read ${directory}`, error)
    }
  }

  /** Every declared collection must be readable, and gets the indexes `desktop.flow` names. */
  private async validate(): Promise<void> {
    for (const definition of this.flow.collections) {
      const collection = this.db.collection<Stored<{ id: string }>>(definition.name)
      for (const index of definition.indexes) {
        const fields = index.expression.split(',').map(field => field.trim())
        collection.createIndex(fields.length === 1
          ? { name: index.name, type: 'hash', field: fields[0] }
          : { name: index.name, type: 'compound', fields })
      }
      try {
        for (const row of await collection.all()) this.sequence = Math.max(this.sequence, row.seq ?? 0)
      } catch (error) {
        throw new FeltDatabaseError(`FeltDB could not read ${definition.name}`, error)
      }
    }
  }

  collection<T extends { id: string }>(name: string): Records<T> {
    const records = this.records.get(name)
    if (!records) throw new FeltDatabaseError(`desktop.flow declares no collection ${name}`)
    return records as unknown as Records<T>
  }

  /** @internal Run a delete whose announcement must carry the id, not only the key. */
  async deleting<T>(collection: string, key: string, id: string, work: () => Promise<T>): Promise<T> {
    const name = `${collection}:${key}`
    this.announcing.set(name, id)
    try { return await work() } finally { this.announcing.delete(name) }
  }

  /** @internal Monotonic across restarts: time-based, and never behind what is stored. */
  nextSequence(): number {
    this.sequence = Math.max(this.sequence + 1, Date.now() * 1000)
    return this.sequence
  }

  /**
   * Stage the writes of one logical operation, then commit them together.
   *
   * `work` reads freely and stages writes; if it throws, nothing was written.
   * FeltDB commits the staged writes as one durable transaction, so a crash
   * leaves either all of them or none.
   *
   * FeltDB 0.11.9 does not announce transaction commits to subscribers, so the
   * committed changes are published to FeltDB's own reactive graph afterwards —
   * the same notification a single-record write makes.
   */
  async transaction<T>(work: (batch: Batch) => Promise<T>): Promise<T> {
    if (this.closed) throw new FeltDatabaseError('FeltDB is closed')
    const batch = new Batch(this)
    const result = await work(batch)
    const operations = batch.staged()
    if (!operations.length) return result
    await this.db.transaction(tx => {
      for (const operation of operations) {
        const collection = tx.collection(operation.collection)
        if (operation.kind === 'put') collection.set(recordKey(operation.id), operation.value)
        else collection.delete(recordKey(operation.id))
      }
    })
    const graph = getReactiveDependencyGraph()
    const timestamp = Date.now()
    for (const operation of operations) {
      const key = `${operation.collection}:${recordKey(operation.id)}`
      if (operation.kind === 'put') {
        await graph.emitChange(operation.collection, { type: operation.existed ? 'update' : 'insert', key, value: { ...operation.value, __version: 1 }, timestamp })
      } else {
        await this.deleting(operation.collection, recordKey(operation.id), operation.id,
          () => graph.emitChange(operation.collection, { type: 'delete', key, value: null, timestamp }))
      }
    }
    return result
  }

  /**
   * Subscribe to changes as FeltDB announces them. Listeners run inside the
   * writer's own call, so they must return quickly.
   */
  subscribe(listener: (change: RecordChange) => void, collections: string[] = this.flow.collections.map(collection => collection.name)): () => void {
    const graph = getReactiveDependencyGraph()
    const stops = collections.map(name => graph.subscribe(name, change => {
      const key = change.key.slice(name.length + 1)
      const record = change.value && typeof change.value === 'object' ? strip(change.value as Stored<{ id: string }>) as unknown as Record<string, unknown> : undefined
      const id = (record?.id as string | undefined) ?? this.announcing.get(change.key) ?? recordIdOf(key)
      try { listener({ collection: name, type: change.type, id, ...(change.type === 'delete' || !record ? {} : { record }) }) } catch { /* a subscriber never fails a write */ }
    }))
    const stop = (): void => { for (const unsubscribe of stops) unsubscribe(); this.unsubscribes.delete(stop) }
    this.unsubscribes.add(stop)
    return stop
  }

  get path(): string { return this.directory }

  /** Stop notifying, await FeltDB's own close, and release the lock. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const stop of [...this.unsubscribes]) stop()
    try { await this.db.close() } finally { rmSync(this.lockPath, { force: true }) }
  }
}
