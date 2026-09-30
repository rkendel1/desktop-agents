import { useEffect, useState, type ReactElement } from 'react'
import type { CiOperationResult, CiPlan, CiRun, Project } from '../../../shared/types'
import { t, tr } from '../preferences'

const STATUS: Record<CiRun['status'], string> = { running: 'Running', passed: 'Passed', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted', blocked: 'Blocked' }
const PHASE: Record<CiRun['phase'], string> = { planning: 'Planning with PAX', acquiring: 'Acquiring a Computer', preparing: 'Preparing the workspace', executing: 'Running', capturing: 'Capturing evidence', releasing: 'Releasing the Computer', done: 'Done' }
const OPERATION_STATUS: Record<CiOperationResult['status'], string> = { passed: 'passed', failed: 'failed', cancelled: 'cancelled', 'timed-out': 'timed out', interrupted: 'interrupted' }

const seconds = (ms: number): string => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`

/** The platform label is Compute's own statement; Preview stays Preview however well a run went. */
function Platform({ platform }: { platform?: CiRun['platform'] }): ReactElement | null {
  return platform ? <span className={`coding-platform coding-platform-${platform.status}`}>{t(platform.label)}</span> : null
}

function Operation({ result }: { result: CiOperationResult }): ReactElement {
  const output = `${result.stdout}${result.stderr && !result.stdout.includes(result.stderr.trim()) ? `\n${result.stderr}` : ''}`.trim()
  return <li className={`ci-operation ci-operation-${result.status}`}>
    <details>
      <summary><span aria-hidden>{result.status === 'passed' ? '✓' : '✗'}</span> <strong>{result.operation}</strong>{' '}
        <span className="muted">{result.tool ? `${result.tool} · ` : ''}{t(OPERATION_STATUS[result.status])}{result.exitCode !== null ? ` · ${tr('exit {code}', { code: result.exitCode })}` : ''} · {seconds(result.durationMs)}</span></summary>
      <p className="coding-meta"><code>{result.command.join(' ')}</code></p>
      {output ? <pre className="coding-output">{output}</pre> : <p className="muted">{t('No output.')}</p>}
      {result.truncated && <p className="muted">{t('Only the end of the output is kept.')}</p>}
    </details>
  </li>
}

/** One run, as it was: the source that was tested, the Computer that ran it, PAX's plan, every operation, and whether the Computer was released. */
function Run({ run, onCancel }: { run: CiRun; onCancel: () => void }): ReactElement {
  const ran = new Set(run.operations.map(item => item.operation))
  const planned = (run.plan?.operations ?? []).filter(item => item.supported && item.operation !== 'install')
  return <div className="ci-run" aria-label={tr('CI run {number}', { number: run.number })}>
    <p className="coding-meta"><strong>{tr('Run #{number}', { number: run.number })}</strong> · <span role="status" className={`coding-state coding-state-${run.status}`}>{t(STATUS[run.status])}</span>
      {run.status === 'running' && <span className="muted"> · {t(PHASE[run.phase])}</span>}</p>
    <dl className="ci-facts">
      <dt>{t('Revision')}</dt><dd><code>{run.source.revision.slice(0, 12)}</code>{run.source.branch ? ` · ${run.source.branch}` : ''} <span className="muted">— {t('committed revision')}, {run.source.repository}</span></dd>
      <dt>{t('Environment')}</dt><dd>Compute Configured <Platform platform={run.platform} /></dd>
      <dt>{t('Computer')}</dt><dd>{run.computer ? <><code>{run.computer.environment}</code> <span className="muted">({t('ephemeral')}{run.computer.target ? ` · ${run.computer.target}` : ''})</span></> : <span className="muted">{t('None was acquired.')}</span>}</dd>
    </dl>
    {run.plan && <p className="ci-plan"><span aria-hidden>{run.plan.ambiguous ? '✗' : '✓'}</span> {t('PAX plan')}{run.plan.note ? <span className="muted"> — {run.plan.note}</span> : null}</p>}
    <ul className="ci-operations">
      {run.operations.map((result, index) => <Operation key={`${result.operation}-${index}`} result={result} />)}
      {run.status !== 'running' && planned.filter(item => !ran.has(item.operation)).map(item => <li key={item.operation} className="ci-operation ci-operation-notrun"><span aria-hidden>–</span> {item.operation} <span className="muted">{t('not run')}</span></li>)}
    </ul>
    {run.failure && <p className="coding-error" role="alert">{run.failure.message}</p>}
    {run.computer && <p className={run.computer.released ? 'muted' : 'coding-error'}>{run.status === 'running' ? t('The Computer is released when the run ends.')
      : run.computer.released ? t('Computer released') : `${t('The Computer was not confirmed released')}${run.computer.releaseNote ? `: ${run.computer.releaseNote}` : ''}`}</p>}
    {run.status === 'running' && <button className="secondary-button" onClick={onCancel}>{t('Cancel CI')}</button>}
  </div>
}

/** Run CI on an ephemeral Compute Computer, and read what happened. Everything here comes from Foundry's service and the shared flow; nothing is kept in the renderer. */
export function CiPanel({ project, runs }: { project: Project; runs: CiRun[] }): ReactElement {
  const [plan, setPlan] = useState<CiPlan | { error: string }>()
  const [tool, setTool] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [chosen, setChosen] = useState<string>()
  const latest = runs.find(run => run.id === chosen) ?? runs[0]
  const active = runs.some(run => run.status === 'running')
  useEffect(() => {
    let live = true
    setPlan(undefined)
    window.douchat.ciPlan(project.id, tool || undefined).then(value => { if (live) setPlan(value) }, cause => { if (live) setPlan({ error: cause instanceof Error ? cause.message : String(cause) }) })
    return () => { live = false }
  }, [project.id, tool, active, runs.length])
  const guard = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setError('')
    try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(cause)) }
    finally { setBusy(false) }
  }
  const resolved = plan && !('error' in plan) ? plan : undefined
  return <section className="coding-section" aria-label={t('CI')}>
    <h3>{t('CI')}</h3>
    {!plan ? <p className="muted">{t('Asking PAX and Compute…')}</p> : 'error' in plan ? <p className="coding-error" role="alert">{plan.error}</p> : <div className="ci-plan-card">
      <dl className="ci-facts">
        <dt>{t('Project')}</dt><dd>{plan.projectName}</dd>
        <dt>{t('Revision')}</dt><dd>{plan.source ? <><code>{plan.source.revision.slice(0, 12)}</code>{plan.source.branch ? ` · ${plan.source.branch}` : ''}</> : <span className="muted">—</span>}</dd>
        <dt>{t('Environment')}</dt><dd>Compute Configured <Platform platform={plan.platform} /></dd>
        <dt>{t('Operations')}</dt><dd>{plan.plan ? <ul className="ci-operations">{plan.plan.operations.filter(item => item.operation !== 'install').map(item =>
          <li key={item.operation}><span aria-hidden>{item.supported ? '✓' : '–'}</span> {item.operation} <span className="muted">{item.supported ? `${item.tool ?? ''} · ${item.command?.join(' ') ?? ''}` : item.reason}</span></li>)}</ul> : <span className="muted">—</span>}</dd>
        <dt>{t('Computer')}</dt><dd>{t('Ephemeral')}</dd>
      </dl>
      {plan.blockers.map(blocker => <p key={blocker} className="coding-error" role="alert">{blocker}</p>)}
      {resolved?.plan?.ambiguous && <label>{t('Choose a tool to resolve it')}
        <input value={tool} onChange={event => setTool(event.target.value)} placeholder="npm" aria-label={t('Tool')} /></label>}
      <button className="primary-button" disabled={busy || active || !resolved?.ready} onClick={() => void guard(async () => { const run = await window.douchat.startCi({ projectId: project.id, ...(tool ? { tool } : {}) }); setChosen(run.id) })}>{t('Run CI')}</button>
    </div>}
    {error && <p className="coding-error" role="alert">{error}</p>}
    {runs.length > 1 && <ul className="coding-session-list">{runs.slice(0, 10).map(run =>
      <li key={run.id}><button onClick={() => setChosen(run.id)}><span className={`coding-state coding-state-${run.status}`}>{t(STATUS[run.status])}</span> {tr('Run #{number}', { number: run.number })} · <code>{run.source.revision.slice(0, 8)}</code></button></li>)}</ul>}
    {latest && <Run run={latest} onCancel={() => void guard(() => window.douchat.cancelCi(latest.id))} />}
    {latest?.computer && <button className="secondary-button" onClick={() => void window.douchat.openComputeUi()}>{t('Open Compute')}</button>}
  </section>
}
