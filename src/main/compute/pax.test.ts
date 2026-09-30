import { expect, it } from 'vitest'
import { paxEvidence, type PaxRun } from './pax'

it('projects PAX evidence without adding detection or authority', () => {
  const run: PaxRun = { command: 'drift', argv: ['pax', '--json', 'drift'], exitCode: 1,
    json: { packageManager: 'pnpm', drift: true }, stdout: '', stderr: '', findings: { ambiguous: false, drift: true, failedClosed: false } }
  expect(paxEvidence(run)).toEqual([
    { id: 'pax-command', name: 'command', value: 'drift' },
    { id: 'pax-exit-code', name: 'exitCode', value: 1 },
    { id: 'pax-result', name: 'result', value: run.json },
    { id: 'pax-findings', name: 'findings', value: run.findings }
  ])
})
