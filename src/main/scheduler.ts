import type { CreateRoutineInput, Routine, RoutineSchedule } from '../shared/types'
import type { DouchatRuntime } from './runtime'
import { DesktopRepository } from './desktopRepository'

const MAX_TIMER_DELAY = 60_000
const ONE_TIME_RETRY_DELAY = 60_000
const ONE_TIME_MAX_ATTEMPTS = 2

export function nextRoutineOccurrence(schedule: RoutineSchedule, after: number): number {
  if (schedule.kind === 'once') return schedule.runAt
  if (schedule.kind === 'interval') {
    const minutes = Math.max(1, Math.round(schedule.intervalMinutes))
    return after + minutes * 60_000
  }

  const days = new Set(schedule.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))
  const [rawHour, rawMinute] = schedule.time.split(':').map(Number)
  const hour = Number.isFinite(rawHour) ? Math.min(23, Math.max(0, rawHour)) : 9
  const minute = Number.isFinite(rawMinute) ? Math.min(59, Math.max(0, rawMinute)) : 0

  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(after)
    candidate.setSeconds(0, 0)
    candidate.setDate(candidate.getDate() + offset)
    candidate.setHours(hour, minute, 0, 0)
    if (days.has(candidate.getDay()) && candidate.getTime() > after) return candidate.getTime()
  }

  return after + 24 * 60 * 60_000
}

export class RoutineScheduler {
  private timer?: NodeJS.Timeout
  private disposed = false
  private readonly oneTimeAttempts = new Map<string, number>()
  /** The tick the timer started most recently, so shutdown can wait for it. */
  private tick: Promise<void> = Promise.resolve()

  constructor(
    private readonly store: DesktopRepository,
    private readonly runtime: DouchatRuntime
  ) {}

  start(): void {
    this.tick = this.scheduleNextTick().catch(() => undefined)
  }

  async createRoutine(input: CreateRoutineInput): Promise<Routine> {
    const routine = await this.store.createRoutine(input, nextRoutineOccurrence(input.schedule, Date.now()))
    await this.scheduleNextTick()
    return routine
  }

  async deleteRoutine(routineId: string): Promise<void> {
    if (!(await this.store.routines()).some((routine) => routine.id === routineId)) {
      throw new Error('Routine not found')
    }
    await this.store.deleteRoutine(routineId)
    await this.scheduleNextTick()
  }

  async setEnabled(routineId: string, enabled: boolean): Promise<void> {
    const routine = (await this.store.routines()).find((item) => item.id === routineId)
    if (!routine) throw new Error('Routine not found')
    if (enabled && routine.schedule.kind === 'once' && routine.schedule.runAt <= Date.now()) {
      throw new Error('One-time routine has already passed')
    }
    const nextRunAt = enabled ? nextRoutineOccurrence(routine.schedule, Date.now()) : routine.nextRunAt
    await this.store.setRoutineEnabled(routineId, enabled, nextRunAt)
    await this.scheduleNextTick()
  }

  async runNow(routineId: string): Promise<void> {
    const routine = (await this.store.routines()).find((item) => item.id === routineId)
    if (!routine) throw new Error('Routine not found')
    await this.runtime.runRoutine(routine, 'manual')
  }

  checkNow(): void {
    this.tick = this.runDueRoutines().catch(() => undefined)
  }

  /** Stop the timer and wait for a tick already running to finish. */
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    await this.tick
  }

  private async scheduleNextTick(): Promise<void> {
    if (this.disposed) return
    const earliest = (await this.store.routines())
      .filter((routine) => routine.enabled)
      .reduce((next, routine) => Math.min(next, routine.nextRunAt), Number.POSITIVE_INFINITY)
    if (this.disposed) return
    if (this.timer) clearTimeout(this.timer)
    const delay = Number.isFinite(earliest)
      ? Math.min(MAX_TIMER_DELAY, Math.max(250, earliest - Date.now()))
      : MAX_TIMER_DELAY
    this.timer = setTimeout(() => { this.tick = this.runDueRoutines().catch(() => undefined) }, delay)
  }

  private async runDueRoutines(): Promise<void> {
    if (this.disposed) return
    const now = Date.now()
    const due = (await this.store.routines()).filter((routine) => routine.enabled && routine.nextRunAt <= now)
    const runnable = due

    // Marking every due routine as triggered is one logical change: all of it, or none of it.
    if (runnable.length) {
      const triggeredAt = Date.now()
      await this.store.triggerRoutines(runnable.map((routine) => ({
        routineId: routine.id,
        triggeredAt,
        nextRunAt: nextRoutineOccurrence(routine.schedule, triggeredAt),
        ...(routine.schedule.kind === 'once' ? { disableAt: routine.schedule.runAt } : {})
      })))
    }
    await this.scheduleNextTick()

    const runs = await this.store.runs()
    const previousFailures = new Map(runnable.map((routine) => [
      routine.id,
      runs.filter((run) => run.routineId === routine.id && run.status === 'failed').length
    ]))
    const outcomes = await Promise.allSettled(runnable.map((routine) => this.runtime.runRoutine(routine, 'schedule')))
    for (const [index, outcome] of outcomes.entries()) {
      const routine = runnable[index]
      if (routine.schedule.kind !== 'once') continue
      if (outcome.status === 'fulfilled') {
        this.oneTimeAttempts.delete(routine.id)
        continue
      }
      const attempts = Math.max(
        (previousFailures.get(routine.id) ?? 0) + 1,
        (this.oneTimeAttempts.get(routine.id) ?? 0) + 1
      )
      this.oneTimeAttempts.set(routine.id, attempts)
      if (attempts < ONE_TIME_MAX_ATTEMPTS) {
        await this.store.setRoutineEnabled(routine.id, true, Date.now() + ONE_TIME_RETRY_DELAY)
      }
    }
    await this.scheduleNextTick()
  }
}
