import type { HealthState, ModelHealthSnapshot, ModelId, PermanentFailure, RetryReason } from '../../shared/modelFabric'

/**
 * Operational routing state, observed by Foundry: how each model has actually behaved in this session of the app. It is deliberately
 * not authority — policy and configuration live in settings, discovery in the registry — and it is not global: a ledger is an object
 * a `ModelFabric` owns and passes to the router. It is lost when Foundry closes, which only costs a little history.
 *
 * These are runtime signals, not benchmarks of quality.
 */
const BASE_COOLDOWN_MS: Record<RetryReason, number> = { 'rate-limited': 30_000, 'capacity-unavailable': 30_000, timeout: 15_000, 'temporary-provider-error': 15_000 }
const MAX_COOLDOWN_MS = 15 * 60_000
const AUTH_PAUSE_MS = 10 * 60_000
const UNAVAILABLE_AFTER = 5
const LATENCY_WINDOW = 100
const RECENT_MS = 5 * 60_000

interface Record_ {
  requests: number; successes: number; failures: number; rateLimited: number; timeouts: number
  latencies: number[]; lastSuccessAt?: number; lastFailureAt?: number; lastFailure?: string; cooldownUntil?: number; pausedUntil?: number; pausedFor?: string
  consecutiveFailures: number; recentFailures: number[]
  toolCalls: number; toolCallSuccesses: number; structuredOutputs: number; structuredOutputSuccesses: number
  tasks: Map<string, { attempts: number; successes: number }>
}
const blank = (): Record_ => ({ requests: 0, successes: 0, failures: 0, rateLimited: 0, timeouts: 0, latencies: [], consecutiveFailures: 0, recentFailures: [], toolCalls: 0, toolCallSuccesses: 0, structuredOutputs: 0, structuredOutputSuccesses: 0, tasks: new Map() })
const percentile = (sorted: number[], p: number): number | undefined => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : undefined

export interface Outcome { latencyMs: number; taskClass: string; usedTools?: boolean; toolCallOk?: boolean; structured?: boolean; structuredOk?: boolean }

export class HealthLedger {
  private readonly records = new Map<ModelId, Record_>()
  constructor(private readonly now: () => number = Date.now) {}

  private of(id: ModelId): Record_ { let record = this.records.get(id); if (!record) { record = blank(); this.records.set(id, record) } return record }

  success(id: ModelId, outcome: Outcome): void {
    const record = this.of(id)
    record.requests++; record.successes++; record.consecutiveFailures = 0; record.cooldownUntil = undefined
    record.lastSuccessAt = this.now()
    record.latencies.push(outcome.latencyMs); if (record.latencies.length > LATENCY_WINDOW) record.latencies.shift()
    if (outcome.usedTools) { record.toolCalls++; if (outcome.toolCallOk !== false) record.toolCallSuccesses++ }
    if (outcome.structured) { record.structuredOutputs++; if (outcome.structuredOk !== false) record.structuredOutputSuccesses++ }
    const task = record.tasks.get(outcome.taskClass) ?? { attempts: 0, successes: 0 }
    task.attempts++; task.successes++; record.tasks.set(outcome.taskClass, task)
    // A model that answered is back in the pool, and a pause for a credential problem is over.
    record.pausedUntil = undefined; record.pausedFor = undefined
  }

  /** A retryable failure: the model rests for a cooldown that doubles with each consecutive failure (or the provider’s own retry-after). */
  retryable(id: ModelId, reason: RetryReason, outcome: Pick<Outcome, 'latencyMs' | 'taskClass'>, message: string, retryAfterMs?: number): number {
    const record = this.of(id)
    this.failed(record, outcome, message)
    if (reason === 'rate-limited') record.rateLimited++
    if (reason === 'timeout') record.timeouts++
    const backoff = BASE_COOLDOWN_MS[reason] * 2 ** Math.min(record.consecutiveFailures - 1, 10)
    const cooldown = Math.min(MAX_COOLDOWN_MS, Math.max(backoff, retryAfterMs ?? 0))
    record.cooldownUntil = this.now() + cooldown
    return record.cooldownUntil
  }

  /** A failure that retrying would not fix. A credential problem pauses the model until it answers again or the pause ends; a bad request does not penalise it. */
  permanent(id: ModelId, kind: PermanentFailure, outcome: Pick<Outcome, 'latencyMs' | 'taskClass'>, message: string): void {
    const record = this.of(id)
    this.failed(record, outcome, message)
    if (kind === 'authentication') { record.pausedUntil = this.now() + AUTH_PAUSE_MS; record.pausedFor = 'authentication failed' }
  }

  private failed(record: Record_, outcome: Pick<Outcome, 'latencyMs' | 'taskClass'>, message: string): void {
    record.requests++; record.failures++; record.consecutiveFailures++
    record.lastFailureAt = this.now(); record.lastFailure = message.slice(0, 300)
    record.recentFailures.push(this.now()); if (record.recentFailures.length > 20) record.recentFailures.shift()
    const task = record.tasks.get(outcome.taskClass) ?? { attempts: 0, successes: 0 }
    task.attempts++; record.tasks.set(outcome.taskClass, task)
  }

  /** The person changed credentials or asked to retry now. */
  reset(id: ModelId): void { this.records.delete(id) }
  resetProvider(provider: string): void { for (const id of [...this.records.keys()]) if (id.startsWith(`${provider}/`)) this.records.delete(id) }

  state(id: ModelId): HealthState {
    const record = this.records.get(id)
    if (!record) return 'healthy'
    const now = this.now()
    if (record.pausedUntil && record.pausedUntil > now) return 'unavailable'
    if (record.cooldownUntil && record.cooldownUntil > now) return record.consecutiveFailures >= UNAVAILABLE_AFTER ? 'unavailable' : 'cooldown'
    return record.consecutiveFailures > 0 ? 'degraded' : 'healthy'
  }

  /** Until when the model is excluded, and why — for the router’s rejection. */
  exclusion(id: ModelId): { state: 'cooldown' | 'unavailable'; until: number; reason: string } | undefined {
    const state = this.state(id)
    if (state !== 'cooldown' && state !== 'unavailable') return undefined
    const record = this.records.get(id)!
    const paused = record.pausedUntil && record.pausedUntil > this.now()
    return { state, until: paused ? record.pausedUntil! : record.cooldownUntil!, reason: paused ? record.pausedFor ?? 'paused' : record.lastFailure ?? 'recent failures' }
  }

  snapshot(id: ModelId): ModelHealthSnapshot {
    const record = this.records.get(id) ?? blank()
    const sorted = [...record.latencies].sort((a, b) => a - b)
    const now = this.now()
    return {
      state: this.state(id), requests: record.requests, successes: record.successes, failures: record.failures, rateLimited: record.rateLimited, timeouts: record.timeouts,
      ...(sorted.length ? { averageLatencyMs: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length), p50LatencyMs: percentile(sorted, 0.5), p95LatencyMs: percentile(sorted, 0.95) } : {}),
      ...(record.lastSuccessAt ? { lastSuccessAt: record.lastSuccessAt } : {}), ...(record.lastFailureAt ? { lastFailureAt: record.lastFailureAt } : {}), ...(record.lastFailure ? { lastFailure: record.lastFailure } : {}),
      ...(record.cooldownUntil && record.cooldownUntil > now ? { cooldownUntil: record.cooldownUntil } : {}),
      consecutiveFailures: record.consecutiveFailures, toolCalls: record.toolCalls, toolCallSuccesses: record.toolCallSuccesses, structuredOutputs: record.structuredOutputs, structuredOutputSuccesses: record.structuredOutputSuccesses
    }
  }

  /** What the ranking reads. A plain value, so the same signals always rank the same way. */
  signals(id: ModelId, taskClass: string): RankingSignals {
    const record = this.records.get(id) ?? blank()
    const task = record.tasks.get(taskClass) ?? { attempts: 0, successes: 0 }
    const sorted = [...record.latencies].sort((a, b) => a - b)
    const now = this.now()
    return { requests: record.requests, successes: record.successes, taskAttempts: task.attempts, taskSuccesses: task.successes, toolCalls: record.toolCalls, toolCallSuccesses: record.toolCallSuccesses,
      structuredOutputs: record.structuredOutputs, structuredOutputSuccesses: record.structuredOutputSuccesses, recentFailures: record.recentFailures.filter(at => now - at < RECENT_MS).length, p50LatencyMs: percentile(sorted, 0.5) }
  }
}

export interface RankingSignals {
  requests: number; successes: number; taskAttempts: number; taskSuccesses: number
  toolCalls: number; toolCallSuccesses: number; structuredOutputs: number; structuredOutputSuccesses: number
  recentFailures: number; p50LatencyMs?: number
}
