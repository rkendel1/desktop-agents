import { openAtFile } from './testSupport'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextRoutineOccurrence, RoutineScheduler } from './scheduler'
import { DesktopRepository } from './desktopRepository'

const directories: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('nextRoutineOccurrence', () => {
  it('keeps an exact one-time reminder timestamp', () => {
    expect(nextRoutineOccurrence({ kind: 'once', runAt: 42_000 }, 1_000)).toBe(42_000)
  })

  it('advances interval schedules from the supplied timestamp', () => {
    expect(nextRoutineOccurrence({ kind: 'interval', intervalMinutes: 30 }, 1_000)).toBe(1_801_000)
  })

  it('finds the next selected local weekday and time', () => {
    const mondayMorning = new Date(2026, 7, 17, 8, 0, 0, 0).getTime()
    const result = nextRoutineOccurrence(
      { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' },
      mondayMorning
    )
    expect(new Date(result)).toEqual(new Date(2026, 7, 17, 9, 0, 0, 0))
  })

  it('rolls a weekly schedule into the following week once the time has passed', () => {
    const mondayAfternoon = new Date(2026, 7, 17, 15, 0, 0, 0).getTime()
    const result = nextRoutineOccurrence(
      { kind: 'weekly', days: [1], time: '09:00' },
      mondayAfternoon
    )
    expect(new Date(result)).toEqual(new Date(2026, 7, 24, 9, 0, 0, 0))
  })

  it('disables a one-time routine before running it', async () => {
    vi.useFakeTimers()
    const now = new Date(2026, 8, 21, 18, 0, 0).getTime()
    vi.setSystemTime(now)
    const directory = mkdtempSync(join(tmpdir(), 'douchat-once-routine-'))
    directories.push(directory)
    const store = openAtFile(join(directory, 'state.json'), { seedDemo: true })
    const runRoutine = vi.fn(async () => undefined)
    const scheduler = new RoutineScheduler(
      store,
      { runRoutine } as never,
      () => undefined
    )
    const agent = store.agents[0]
    const conversation = store.conversations.find((item) => item.agentIds.includes(agent.id))!
    const routine = scheduler.createRoutine({
      name: 'Drink water',
      prompt: 'Remind the human to drink water.',
      agentId: agent.id,
      conversationId: conversation.id,
      schedule: { kind: 'once', runAt: now + 5 * 60_000 },
      timezone: 'Asia/Shanghai'
    })
    vi.setSystemTime(now + 5 * 60_000)

    await (scheduler as unknown as { runDueRoutines: () => Promise<void> }).runDueRoutines()

    expect(store.routines[0]).toMatchObject({ id: routine.id, enabled: false, lastRunAt: now + 5 * 60_000 })
    expect(runRoutine).toHaveBeenCalledOnce()
    scheduler.dispose()
  })

  it('retries a failed one-time routine once, then leaves it stopped', async () => {
    vi.useFakeTimers()
    const now = new Date(2026, 8, 21, 19, 0, 0).getTime()
    vi.setSystemTime(now)
    const directory = mkdtempSync(join(tmpdir(), 'douchat-once-retry-'))
    directories.push(directory)
    const store = openAtFile(join(directory, 'state.json'), { seedDemo: true })
    const runRoutine = vi.fn(async () => { throw new Error('empty response') })
    const scheduler = new RoutineScheduler(store, { runRoutine } as never, () => undefined)
    const agent = store.agents[0]
    const conversation = store.conversations.find((item) => item.agentIds.includes(agent.id))!
    const routine = scheduler.createRoutine({
      name: 'Tell a joke',
      prompt: 'Tell the human a joke.',
      agentId: agent.id,
      conversationId: conversation.id,
      schedule: { kind: 'once', runAt: now + 60_000 },
      timezone: 'Asia/Shanghai'
    })
    vi.setSystemTime(now + 60_000)

    await (scheduler as unknown as { runDueRoutines: () => Promise<void> }).runDueRoutines()

    expect(store.routines[0]).toMatchObject({ id: routine.id, enabled: true, nextRunAt: now + 2 * 60_000 })
    vi.setSystemTime(now + 2 * 60_000)
    await (scheduler as unknown as { runDueRoutines: () => Promise<void> }).runDueRoutines()

    expect(store.routines[0]).toMatchObject({ id: routine.id, enabled: false })
    expect(runRoutine).toHaveBeenCalledTimes(2)
    scheduler.dispose()
  })

  it('still runs due local-agent routines when Douchat credits are empty', async () => {
    vi.useFakeTimers()
    const now = new Date(2026, 8, 21, 19, 45, 0).getTime()
    vi.setSystemTime(now)
    const directory = mkdtempSync(join(tmpdir(), 'douchat-local-routine-'))
    directories.push(directory)
    const store = openAtFile(join(directory, 'state.json'), { seedDemo: true })
    const agent = store.agents[0]
    store.updateAgent(agent.id, { localAgentId: 'codex', provider: 'local', model: 'codex' })
    const runRoutine = vi.fn(async () => undefined)
    const getDouchatCredits = vi.fn(async () => 0)
    const scheduler = new RoutineScheduler(store, { runRoutine } as never, () => undefined, getDouchatCredits)
    const conversation = store.conversations.find((item) => item.agentIds.includes(agent.id))!
    scheduler.createRoutine({
      name: 'Local greeting',
      prompt: 'Say hello locally.',
      agentId: agent.id,
      conversationId: conversation.id,
      schedule: { kind: 'interval', intervalMinutes: 3 },
      timezone: 'Asia/Shanghai'
    })
    vi.setSystemTime(now + 3 * 60_000)

    await (scheduler as unknown as { runDueRoutines: () => Promise<void> }).runDueRoutines()

    expect(getDouchatCredits).not.toHaveBeenCalled()
    expect(runRoutine).toHaveBeenCalledOnce()
    expect(store.routines[0]).toMatchObject({ enabled: true, lastRunAt: now + 3 * 60_000 })
    scheduler.dispose()
  })

})
