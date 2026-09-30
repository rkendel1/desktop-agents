import type { CommandResult } from '../../shared/types'
import type { JevQuestion } from '../../shared/jev'

/**
 * PAX is the project-tooling boundary. Foundry asks it; it does not detect package managers, choose tools or plan operations itself.
 * These are the documented PAX commands, run in the project's checkout (on the Computer, for a Compute-backed session), and their
 * answers are returned as PAX gave them: JSON stays JSON, diagnostics stay text, exit status stays exit status, and an
 * ambiguity or drift is reported — never resolved, repaired or turned into something else here.
 */
export const PAX_INSPECTIONS = ['info', 'doctor', 'deps', 'scripts', 'workspaces', 'lock', 'graph', 'reality', 'drift'] as const
export const PAX_OPERATIONS = ['build', 'test', 'lint', 'typecheck'] as const
/** Materialising a workspace's dependencies is a delegated PAX execution too (`pax install`): PAX chooses the tool. */
export const PAX_PREPARATIONS = ['install'] as const
export type PaxInspection = typeof PAX_INSPECTIONS[number]
export type PaxOperation = typeof PAX_OPERATIONS[number] | typeof PAX_PREPARATIONS[number]

export interface PaxRun {
  command: string
  argv: string[]
  /** PAX's own exit status. For `drift`: 0 no drift, 1 drift, 2 ambiguous or invalid input. */
  exitCode: number | null
  /** stdout parsed as PAX's JSON document, when it is one. */
  json?: unknown
  stdout: string
  /** Human diagnostics, kept apart from the JSON. */
  stderr: string
  /** Things PAX itself reported, surfaced without interpretation. */
  findings: { ambiguous: boolean; drift: boolean; failedClosed: boolean }
}

export type PaxExecutor = (argv: string[], options: { signal?: AbortSignal }) => Promise<CommandResult>

function findings(command: string, result: CommandResult, json: unknown): PaxRun['findings'] {
  const issues = (json as { issues?: { status?: string }[] } | undefined)?.issues ?? []
  return {
    // A drift report says, per issue, whether it is drift or ambiguous. Both are passed on exactly as PAX gave them.
    ambiguous: issues.some(issue => issue.status === 'ambiguous') || (command === 'drift' && result.exitCode === 2),
    drift: issues.some(issue => issue.status === 'drift') || (command === 'drift' && result.exitCode === 1),
    // A delegated operation that PAX refused to choose a tool for (it prints why and exits non-zero).
    failedClosed: !['drift'].includes(command) && result.exitCode !== 0 && /use --tool|unable to determine|multiple .* detected/i.test(`${result.stderr}${result.stdout}`)
  }
}

/** Run one PAX command. `--json` is always asked for; `dryRun` is PAX's own planning contract and executes nothing. */
export async function runPax(execute: PaxExecutor, pax: string, command: PaxInspection | PaxOperation, options: { dryRun?: boolean; tool?: string; signal?: AbortSignal } = {}): Promise<PaxRun> {
  const argv = [pax, '--json', ...(options.tool ? ['--tool', options.tool] : []), ...(options.dryRun ? ['--dry-run'] : []), command]
  const result = await execute(argv, { signal: options.signal })
  let json: unknown
  try { json = JSON.parse(result.stdout) } catch { /* not JSON: kept as text */ }
  return { command, argv, exitCode: result.exitCode, ...(json !== undefined ? { json } : {}), stdout: result.stdout, stderr: result.stderr, findings: findings(command, result, json) }
}

/** Project PAX's own answer into explicit Jev evidence without re-detecting or reinterpreting project reality. */
export function paxEvidence(run: PaxRun): JevQuestion['inputs'] {
  return [
    { id: 'pax-command', name: 'command', value: run.command },
    { id: 'pax-exit-code', name: 'exitCode', value: run.exitCode },
    { id: 'pax-result', name: 'result', value: (run.json ?? { stdout: run.stdout, stderr: run.stderr }) as JevQuestion['inputs'][number]['value'] },
    { id: 'pax-findings', name: 'findings', value: run.findings }
  ]
}
