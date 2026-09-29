import type { GroupWorkflow } from '../shared/groupWorkflow'

/** An interrupted tool-bearing reply is never automatically re-executed. */
export class GroupWorkflowJournal {
  private heartbeats: Promise<void> = Promise.resolve()
  constructor(readonly state: GroupWorkflow, private save: (value: GroupWorkflow) => Promise<void>) {}
  progress(key: string): void {
    const call = this.state.calls[key]
    if (call?.status === 'running' && this.state.status === 'running') call.lastProgressAt = Date.now()
  }
  async call<T>(key: string, kind: 'decision' | 'reply', execute: () => Promise<T>): Promise<T> {
    const existing = this.state.calls[key]
    if (existing?.status === 'done') return structuredClone(existing.value) as T
    if (existing?.status === 'running' && kind === 'reply') throw new Error('The previous attempt was interrupted at this step and may have performed external actions. Check the results and send a new explicit instruction. This step will not be repeated automatically.')
    const startedAt = Date.now()
    this.state.calls[key] = { status: 'running', kind, startedAt, heartbeatAt: startedAt }
    await this.save(this.state)
    // This pulse proves the local executor is alive, not that a remote model is
    // making progress. Real adapter events update lastProgressAt separately.
    const heartbeat = kind === 'reply' ? setInterval(() => {
      if (this.state.status !== 'running' || this.state.calls[key]?.status !== 'running') return
      this.state.calls[key].heartbeatAt = Date.now()
      // Heartbeats are stored in order, and the call does not finish before the last one lands.
      this.heartbeats = this.heartbeats.then(() => this.save(this.state)).catch(() => undefined)
    }, 15_000) : undefined
    try {
      const value = await execute()
      this.state.calls[key] = { ...this.state.calls[key], status: 'done', kind, value, finishedAt: Date.now() }
      clearInterval(heartbeat)
      await this.heartbeats
      await this.save(this.state)
      return value
    } finally { clearInterval(heartbeat) }
  }
  async finish(status: GroupWorkflow['status'], error?: string): Promise<void> {
    await this.heartbeats
    this.state.status = status; this.state.error = error; await this.save(this.state)
  }
}
