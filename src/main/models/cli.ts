import { budgetLabel, type ModelCandidate, type ModelFabricStatus, type ModelStatusEntry } from '../../shared/modelFabric'
import type { ModelFabric } from './fabric'
import { ModelRoutingError } from './router'

/**
 * `Foundry model …` — the fabric from a terminal. It runs the app headless (no window), reads and writes the same settings the Models
 * screen does, and prints what the fabric knows. Nothing here is a second implementation: it formats `ModelFabric`’s answers.
 *
 *   model                   the policy, the pool and the current pick
 *   model current           the same
 *   model list [--free]     the pool (--free: models whose access is free, beta, trial or local)
 *   model discover          ask the connected providers what they offer now
 *   model status            counts, current and fallbacks
 *   model test              send a one-line request through the router and show the decision
 *   --json                  machine-readable output
 */
export function modelCliInvocation(argv: readonly string[], packaged: boolean): string[] | undefined {
  const args = argv.slice(packaged ? 1 : 2)
  const at = args.findIndex(arg => !arg.startsWith('-'))
  return at >= 0 && args[at] === 'model' ? args.slice(at + 1) : undefined
}

const pad = (text: string, width: number): string => text.length >= width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width)
const capabilityWords = (candidate: ModelCandidate): string => {
  const c = candidate.capabilities
  const words = [c.coding && 'code', c.reasoning && 'reasoning', c.toolUse && 'tools', c.vision && 'vision', c.structuredOutput && 'json'].filter(Boolean)
  return words.length ? words.join('/') : 'chat'
}
export const statusMark = (entry: ModelStatusEntry): string => {
  if (entry.eligible) return entry.health.state === 'degraded' ? '◐ recovering' : '● ready'
  const reason = entry.rejection
  if (reason?.stage === 'health') return reason.reason === 'cooldown' ? '◐ cooldown' : '○ unavailable'
  if (reason?.stage === 'availability') return `○ ${reason.reason.replace(/-/g, ' ')}`
  return `○ ${(reason?.reason ?? 'not eligible').replace(/-/g, ' ')}`
}
const label = (entry: ModelStatusEntry | undefined): string => entry ? `${entry.candidate.providerName} / ${entry.candidate.label ?? entry.candidate.model}` : 'none available'

export function formatCurrent(status: ModelFabricStatus): string {
  const connected = status.providers.filter(provider => provider.connected && provider.eligible > 0).length
  return ['Foundry Model', '',
    `Policy       ${budgetLabel(status.policy.budget)}${status.policy.automatic ? '' : '  (automatic routing is off: agents use their own model)'}`,
    `Pool         ${connected} provider${connected === 1 ? '' : 's'}`,
    `Models       ${status.eligible} eligible`,
    `Current      ${label(status.current)}`,
    `Fallbacks    ${status.fallbacks.length} available`,
    `Cost         $0.00 (free only: no paid model can be called)`, ''].join('\n')
}

export function formatStatus(status: ModelFabricStatus): string {
  return ['MODEL FABRIC', '',
    `${status.discovered} discovered`, `${status.eligible} eligible`, `${status.rateLimited} rate limited`, `${status.unavailable} unavailable`, '',
    'Current:', `  ${label(status.current)}`, '',
    ...(status.fallbacks.length ? ['Fallback:', ...status.fallbacks.map(entry => `  ${label(entry)}`), ''] : []),
    status.discoveredAt ? `Last discovery: ${new Date(status.discoveredAt).toLocaleString()}` : 'Not discovered yet: run `Foundry model discover`.', '',
    status.costNote, ''].join('\n')
}

export function formatList(status: ModelFabricStatus, freeOnly: boolean): string {
  const entries = status.entries.filter(entry => !freeOnly || ['local', 'free', 'beta', 'trial'].includes(entry.candidate.access))
  const rows = entries.map(entry => `${pad(entry.candidate.providerName, 18)} ${pad(entry.candidate.label ?? entry.candidate.model, 34)} ${pad(capabilityWords(entry.candidate), 28)} ${freeOnly ? '' : `${pad(entry.candidate.access, 16)} `}${statusMark(entry)}`)
  const header = `${pad('Provider', 18)} ${pad('Model', 34)} ${pad('Capabilities', 28)} ${freeOnly ? '' : `${pad('Access', 16)} `}Status`
  return [freeOnly ? 'FREE MODELS' : 'MODELS', '', header, '─'.repeat(header.length + 6), ...(rows.length ? rows : ['(none discovered: run `Foundry model discover`)']), ''].join('\n')
}

export async function runModelCli(args: readonly string[], fabric: ModelFabric, out: { write(text: string): void }): Promise<number> {
  const json = args.includes('--json')
  const [command = 'current', ...rest] = args.filter(arg => arg !== '--json')
  const print = (value: unknown, text: string): void => out.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`)
  try {
    switch (command) {
      case 'current': { const status = await fabric.status(); print({ policy: status.policy, eligible: status.eligible, current: status.current?.candidate.id, fallbacks: status.fallbacks.map(entry => entry.candidate.id), cost: '$0.00' }, formatCurrent(status)); return 0 }
      case 'status': { const status = await fabric.status(); print(status, formatStatus(status)); return 0 }
      case 'list': {
        const free = rest.includes('--free')
        if (!(await fabric.registry()).discoveredAt) await fabric.discover()
        const status = await fabric.status(); print(status.entries.filter(entry => !free || ['local', 'free', 'beta', 'trial'].includes(entry.candidate.access)), formatList(status, free)); return 0
      }
      case 'discover': {
        const registry = await fabric.discover()
        const providers = new Set(registry.candidates.map(candidate => candidate.provider))
        const status = await fabric.status()
        print({ discovered: registry.candidates.length, eligible: status.eligible, providers: [...providers], errors: registry.errors },
          [`Discovered ${registry.candidates.length} model${registry.candidates.length === 1 ? '' : 's'} from ${providers.size} provider${providers.size === 1 ? '' : 's'}; ${status.eligible} eligible under ${budgetLabel(status.policy.budget)}.`,
            ...registry.errors.map(error => `  ${error.provider}: ${error.message}`)].join('\n'))
        return registry.errors.length && !registry.candidates.length ? 1 : 0
      }
      case 'test': {
        if (!(await fabric.registry()).discoveredAt) await fabric.discover()
        const started = Date.now()
        const { response, decision } = await fabric.complete(fabric.request('general'), 'Reply with the single word: pong.')
        print({ decision, reply: response.text.slice(0, 200) }, [`Selected   ${decision.selected}`, `Attempts   ${decision.attempts.map(attempt => `${attempt.model} ${attempt.outcome}${attempt.retryReason ? ` (${attempt.retryReason})` : ''}`).join(' → ')}`, `Policy     ${decision.costPolicy}`, `Latency    ${Date.now() - started} ms`, `Reply      ${response.text.trim().slice(0, 120)}`].join('\n'))
        return 0
      }
      default: out.write(`Unknown command “${command}”. Try: model, model list [--free], model discover, model status, model current, model test.\n`); return 2
    }
  } catch (error) {
    if (error instanceof ModelRoutingError) { print({ error: error.message, decision: error.decision }, `${error.message}\n\nCandidates: ${error.decision.candidatesConsidered.length}, rejected: ${error.decision.rejected.length}, attempts: ${error.decision.attempts.length}`); return 1 }
    out.write(`${error instanceof Error ? error.message : String(error)}\n`); return 1
  }
}
