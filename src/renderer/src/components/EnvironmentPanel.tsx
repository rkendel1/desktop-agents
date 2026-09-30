import { Fragment, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { ComputeEnvironmentView, DevelopmentEnvironmentDetail, DevelopmentEnvironmentView, DevelopmentSetupProgress, EnvironmentAction, EnvironmentReason, EnvironmentState, Project, RecipeResolutionView, RecipeSummary } from '../../../shared/types'
import { t, tr } from '../preferences'

/**
 * The project's development environment, as Compute reports it. Foundry keeps a reference; this panel shows Compute's answer for it,
 * asked again on a timer and whenever the window returns. It has no logic of its own about the Computer: the state label is a
 * translation of Compute's readiness/lifecycle words (done in the main process), and the buttons call the control plane, which asks
 * Compute and reports what Compute then says. It is not a Compute dashboard.
 */
export const STATE_LABEL: Record<EnvironmentState, string> = {
  none: 'No environment', creating: 'Creating', configuring: 'Configuring', ready: 'Ready', degraded: 'Degraded', 'not-ready': 'Not ready', failed: 'Failed',
  stopping: 'Stopping', stopped: 'Stopped', destroying: 'Destroying', destroyed: 'Destroyed', missing: 'Unavailable', 'compute-unavailable': 'Compute unavailable', unknown: 'Unknown'
}
/** Compute's own words for bootstrap and readiness, capitalised for display. */
const CONFIGURATION: Record<string, string> = { succeeded: 'Configured', running: 'Configuring', failed: 'Failed', not_started: 'Not started' }
const TRANSITIONAL: EnvironmentState[] = ['creating', 'configuring', 'stopping', 'destroying']
const ACTION_LABEL: Record<EnvironmentAction, string> = { open: 'Open', restart: 'Restart', stop: 'Stop', start: 'Start', retry: 'Retry', destroy: 'Destroy', create: 'Create Developer Environment' }
const STEP_MARK = { done: '✓', active: '●', pending: '○', failed: '✗' } as const
const KNOWN_TONE: Partial<Record<EnvironmentState, string>> = { ready: 'succeeded', degraded: 'awaiting-approval', creating: 'running', configuring: 'running', stopping: 'running', destroying: 'running', failed: 'failed', 'not-ready': 'failed', unknown: 'failed', missing: 'failed', 'compute-unavailable': 'failed' }

const cleanMessage = (cause: unknown): string => cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').replace(/^(EnvironmentError|EnvironmentRefusal): /, '') : String(cause)
const capitalise = (value: string): string => value ? value[0]!.toUpperCase() + value.slice(1) : value
const bytes = (value?: number): string | undefined => value === undefined ? undefined : value >= 2 ** 30 ? `${+(value / 2 ** 30).toFixed(1)} GiB` : `${Math.round(value / 2 ** 20)} MiB`

/** The state as a pill: colour is a hint, the word is the message. */
export function EnvironmentStatus({ view }: { view: Pick<DevelopmentEnvironmentView, 'state'> }): ReactElement {
  return <span className={`coding-state coding-state-${KNOWN_TONE[view.state] ?? 'cancelled'}`} role="status">{t(STATE_LABEL[view.state])}</span>
}

/** Placement’s and Compute’s reasons, in Compute’s categories with a human sentence on top. */
function Reason({ reason }: { reason: EnvironmentReason }): ReactElement {
  return <div className="env-reason" role="alert">
    <p><strong>{t(reason.title)}</strong></p>
    <p>{t(reason.message)}</p>
    {!!reason.unsatisfied?.length && <ul className="env-unsatisfied">{reason.unsatisfied.map((item, index) =>
      <li key={`${item.code}-${index}`}><code>{item.code}</code>{item.required ? <> — {t('Required')}: <code>{item.required}</code></> : null}{item.available ? <span className="muted"> · {t('Available')}: {item.available}</span> : null}{item.detail ? <span className="muted"> · {item.detail}</span> : null}</li>)}</ul>}
    {(reason.category || reason.computeSays) && <details className="env-diagnostics"><summary>{t('Diagnostics')}</summary>
      {reason.category && <p className="coding-meta">{t('Compute category')}: <code>{reason.category}</code>{reason.retryable !== undefined ? ` · ${reason.retryable ? t('retryable') : t('not retryable')}` : ''}</p>}
      {reason.computeSays && <p className="coding-meta">{t('Compute says')}: {reason.computeSays}</p>}
    </details>}
  </div>
}

/** Recipe → Computer → Environment → Readiness, in the words of the four things a person is choosing between. */
function Explained(): ReactElement {
  return <dl className="env-explained">
    <dt>{t('Recipe')}</dt><dd>{t('What you asked Compute to provide.')}</dd>
    <dt>{t('Computer')}</dt><dd>{t('Where Compute will provide it.')}</dd>
    <dt>{t('Environment')}</dt><dd>{t('The configured execution context.')}</dd>
    <dt>{t('Readiness')}</dt><dd>{t('Whether reality actually satisfies the request.')}</dd>
  </dl>
}

function Resolution({ resolution }: { resolution: RecipeResolutionView }): ReactElement {
  const wants = resolution.requirements
  return <div className="env-resolution" aria-label={t('Recipe resolution')}>
    <p className="coding-meta"><strong>{t('Recipe')}</strong> {resolution.recipe ? `${resolution.recipe.name} · v${resolution.recipe.version}` : ''} — {t('Compute says')}: <span className={resolution.verdict === 'satisfiable' ? 'coding-ok' : 'coding-bad'}>{resolution.verdict === 'satisfiable' ? t('satisfiable') : resolution.verdict === 'unsatisfied' ? t('cannot be satisfied here') : t('invalid')}</span></p>
    {!!resolution.problems.length && <ul>{resolution.problems.map(problem => <li key={problem} className="coding-error">{problem}</li>)}</ul>}
    {wants && <p className="coding-meta">{t('Needs')}: {[capitalise(wants.lifecycle), wants.cpu !== undefined ? `${wants.cpu} CPU` : '', bytes(wants.memoryBytes), bytes(wants.diskBytes) ? `${bytes(wants.diskBytes)} disk` : '', wants.architecture, wants.network ? `network ${wants.network}` : '', wants.isolation ? `isolation ${wants.isolation}` : '',
      ...wants.capabilities, ...wants.features, ...wants.runtimes].filter(Boolean).join(' · ')}</p>}
    {resolution.placement && <div>
      <p className="coding-meta"><strong>{t('Computer')}</strong> {resolution.placement.selected ? <>{t('would run on')} <code>{resolution.placement.selected}</code></> : t('No target can host it.')}</p>
      <ul className="env-targets">{resolution.placement.targets.map(target => <li key={target.id}><span aria-hidden>{target.eligible ? '✓' : '✗'}</span> <code>{target.id}</code>{' '}
        {target.reasons.map((reason, index) => <span key={index} className="muted">{reason.code}{reason.required ? ` (${t('required')} ${reason.required})` : ''}{' '}</span>)}</li>)}</ul>
    </div>}
  </div>
}

/** Choose a recipe Compute has, see what Compute would do with it, and create the environment from it. Foundry writes no recipes. */
function CreateEnvironment({ project, onDone }: { project: Project; onDone: (view: DevelopmentEnvironmentView) => void }): ReactElement {
  const [recipes, setRecipes] = useState<RecipeSummary[] | { error: string }>()
  const [name, setName] = useState('')
  const [resolution, setResolution] = useState<RecipeResolutionView | { error: string }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const loadRecipes = useCallback(() => {
    let live = true
    setRecipes(undefined)
    window.douchat.environmentRecipes().then(list => { if (live) { setRecipes(list); setName(current => list.some(recipe => recipe.name === current) ? current : list[0]?.name || '') } }, cause => { if (live) setRecipes({ error: cleanMessage(cause) }) })
    return () => { live = false }
  }, [])
  useEffect(() => {
    return loadRecipes()
  }, [loadRecipes])
  useEffect(() => {
    if (!name) { setResolution(undefined); return }
    let live = true
    setResolution(undefined)
    window.douchat.environmentResolve(name).then(value => { if (live) setResolution(value) }, cause => { if (live) setResolution({ error: cleanMessage(cause) }) })
    return () => { live = false }
  }, [name])
  const resolved = resolution && !('error' in resolution) ? resolution : undefined
  return <div className="env-create" aria-label={t('Create developer environment')}>
    <Explained />
    {!recipes ? <p className="muted">{t('Asking Compute…')}</p> : 'error' in recipes ? <p className="coding-error" role="alert">{recipes.error}</p> : !recipes.length
      ? <div className="env-empty-recipes"><p className="muted">{t('No other Compute recipes are registered. Use the one-click Developer setup above, or manage recipes in Compute.')}</p>
        <div className="coding-actions"><button type="button" className="secondary-button" onClick={loadRecipes}>{t('Refresh recipes')}</button>
          <button type="button" className="secondary-button" onClick={() => void window.douchat.openComputeUi()}>{t('Manage Compute')}</button></div>
      </div>
      : <label>{t('Recipe')}
        <select value={name} onChange={event => setName(event.target.value)}>{recipes.map(recipe => <option key={recipe.name} value={recipe.name}>{recipe.name} · v{recipe.version}{recipe.description ? ` — ${recipe.description}` : ''}</option>)}</select>
      </label>}
    {resolution && 'error' in resolution && <p className="coding-error" role="alert">{resolution.error}</p>}
    {resolved && <Resolution resolution={resolved} />}
    {resolved && resolved.verdict !== 'satisfiable' && <p className="muted">{t('Choose another recipe, or change what Compute offers.')}</p>}
    <button className="primary-button" disabled={busy || resolved?.verdict !== 'satisfiable'} onClick={() => {
      setBusy(true); setError('')
      window.douchat.environmentCreate({ projectId: project.id, recipe: name, ...(resolved?.recipe ? { version: resolved.recipe.version } : {}) }).then(onDone, cause => setError(cleanMessage(cause))).finally(() => setBusy(false))
    }}>{t('Create environment')}</button>
    {error && <p className="coding-error" role="alert">{error}</p>}
  </div>
}

/** Optional inspection: Compute's inspect output, arranged for reading. Nothing is kept here, and nothing here can change anything. */
function Detail({ project, view }: { project: Project; view: DevelopmentEnvironmentView }): ReactElement {
  const [detail, setDetail] = useState<DevelopmentEnvironmentDetail | { error: string }>()
  useEffect(() => {
    let live = true
    window.douchat.environmentDetail(project.id).then(value => { if (live) setDetail(value) }, cause => { if (live) setDetail({ error: cleanMessage(cause) }) })
    return () => { live = false }
  }, [project.id, view.state, view.observedAt])
  if (!detail) return <p className="muted">{t('Asking Compute…')}</p>
  if ('error' in detail) return <p className="coding-error" role="alert">{detail.error}</p>
  const facts = detail.detail
  return <div className="env-detail">
    <dl className="ci-facts">
      <dt>{t('Recipe')}</dt><dd>{detail.recipe ? <>{detail.recipe.name} · v{detail.recipe.version} <span className="muted" title={detail.recipe.digest}>{detail.recipe.digest.slice(0, 19)}…</span></> : <span className="muted">—</span>}</dd>
      <dt>{t('Computer')}</dt><dd>{detail.computer ? <>{detail.computer.target ?? '—'}{detail.computer.platformLabel ? ` · ${detail.computer.platformLabel}` : ''}{detail.computer.certification ? <> · <span className={`coding-platform coding-platform-${detail.computer.certification.status}`}>{detail.computer.certification.status === 'certified' ? t('Certified') : detail.computer.certification.status === 'preview' ? t('Preview') : t('Unverified')}</span></> : null}</> : '—'}</dd>
      <dt>{t('Configuration')}</dt><dd>{detail.configuration ? t(CONFIGURATION[detail.configuration] ?? detail.configuration) : '—'}</dd>
      <dt>{t('Readiness')}</dt><dd>{detail.readiness ? t(capitalise(detail.readiness)) : '—'}{facts?.readinessExplanation ? <span className="muted"> — {facts.readinessExplanation}</span> : null}</dd>
      <dt>{t('Lifecycle')}</dt><dd>{detail.computer ? `${capitalise(detail.lifecycle ?? '')} · ${detail.computer.lifecycle}` : '—'}</dd>
      <dt>{t('Workloads')}</dt><dd>{detail.workloads ?? 0}</dd>
      <dt>{t('Created')}</dt><dd>{facts?.createdAt ? new Date(facts.createdAt).toLocaleString() : '—'}</dd>
      <dt>{t('Last transition')}</dt><dd>{facts?.lastTransition ? `${facts.lastTransition.what} · ${new Date(facts.lastTransition.at).toLocaleString()}` : '—'}</dd>
    </dl>
    {facts && <details className="env-advanced"><summary>{t('Advanced')}</summary>
      <ul className="env-conditions">{facts.conditions.map(condition => <li key={condition.name}><span aria-hidden>{condition.satisfied ? '✓' : '✗'}</span> <strong>{condition.name}</strong> <span className="muted">{condition.detail}</span></li>)}</ul>
      {!!facts.steps.length && <ul className="env-conditions">{facts.steps.map(step => <li key={`${step.kind}-${step.name}`}>{step.kind} <code>{step.name}</code> — {step.outcome}{step.error ? ` (${step.error})` : ''}</li>)}</ul>}
      <p className="coding-meta">{t('Environment id')}: <code>{facts.environmentId}</code>{facts.placementId ? <> · {t('placement')}: <code>{facts.placementId.slice(0, 19)}…</code></> : null}{facts.generation !== undefined ? ` · ${t('generation')} ${facts.generation}` : ''}</p>
      <pre className="coding-output">{JSON.stringify({ requirements: facts.requirements, machine: facts.machine, processes: facts.processes }, null, 2)}</pre>
    </details>}
  </div>
}

export interface WorkRow { label: string; value: string }

export function EnvironmentPanel({ project, work = [] }: { project: Project; work?: WorkRow[] }): ReactElement {
  const [view, setView] = useState<DevelopmentEnvironmentView | { error: string }>()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const [candidates, setCandidates] = useState<ComputeEnvironmentView[]>([])
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState('')
  const [setup, setSetup] = useState<DevelopmentSetupProgress>()
  const [open, setOpen] = useState(false)
  const alive = useRef(true)
  const load = useCallback(async (): Promise<void> => {
    try { const value = await window.douchat.environmentState(project.id); if (alive.current) setView(value) } catch (cause) { if (alive.current) setView({ error: cleanMessage(cause) }) }
  }, [project.id])
  const state = view && !('error' in view) ? view.state : undefined
  useEffect(() => { alive.current = true; setView(undefined); setCreating(false); setAttaching(false); setOpen(false); void load(); return () => { alive.current = false } }, [load])
  useEffect(() => {
    if (typeof window.douchat.onEnvironmentSetupProgress !== 'function') return
    return window.douchat.onEnvironmentSetupProgress(progress => {
      if (progress.projectId !== project.id || !alive.current) return
      setSetup(progress)
      if (progress.steps.find(step => step.id === 'computer')?.status === 'done') void load()
    })
  }, [load, project.id])
  // Compute is asked again: quickly while it is changing something, slowly otherwise, and whenever the window returns.
  useEffect(() => {
    const timer = setInterval(() => { void load() }, state && TRANSITIONAL.includes(state) ? 2000 : 15_000)
    const onFocus = (): void => { void load() }
    window.addEventListener('focus', onFocus)
    return () => { clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [load, state])

  const act = async (action: EnvironmentAction): Promise<void> => {
    if (action === 'open') { setOpen(current => !current); return }
    if (action === 'create') {
      setBusy(action); setError(''); setCreating(false)
      try {
        const result = await window.douchat.environmentSetupDeveloper(project.id)
        if (alive.current) { setSetup(result); setView(result.view) }
      } catch (cause) { setError(cleanMessage(cause)); void load() } finally { setBusy('') }
      return
    }
    setBusy(action); setError('')
    try { const next = await window.douchat.environmentAct(project.id, action); if (alive.current) setView(next) } catch (cause) { setError(cleanMessage(cause)); void load() } finally { setBusy('') }
  }

  const chooseExisting = async (): Promise<void> => {
    if (attaching) { setAttaching(false); return }
    setAttaching(true); setBusy('discover'); setError('')
    try {
      const inventory = await window.douchat.computeInventory()
      if (!inventory.available) throw new Error(inventory.reason ?? 'Compute is unavailable.')
      const available = inventory.environments.filter(environment => environment.observed !== 'destroyed')
      if (!alive.current) return
      setCandidates(available)
      setSelectedEnvironmentId(available[0]?.environmentId ?? '')
    } catch (cause) { setError(cleanMessage(cause)) } finally { setBusy('') }
  }

  const attach = async (): Promise<void> => {
    const candidate = candidates.find(environment => environment.environmentId === selectedEnvironmentId)
    if (!candidate) return
    setBusy('attach'); setError('')
    try {
      const next = await window.douchat.environmentAttach({ projectId: project.id, environment: candidate.name, environmentId: candidate.environmentId })
      if (alive.current) { setView(next); setAttaching(false) }
    } catch (cause) { setError(cleanMessage(cause)); void load() } finally { setBusy('') }
  }

  return <section className="coding-section env-panel" aria-label={t('Environment')}>
    <h3>{t('Environment')}</h3>
    {!view ? <p className="muted">{t('Asking Compute…')}</p> : 'error' in view ? <p className="coding-error" role="alert">{view.error}</p> : <>
      <p className="coding-meta"><EnvironmentStatus view={view} />{view.reference ? <span className="muted"> · {view.reference.environment}</span> : null}</p>
      {view.reference && view.state !== 'missing' && view.state !== 'compute-unavailable' && <dl className="ci-facts env-facts">
        <dt>{t('Recipe')}</dt><dd>{view.recipe ? <span title={view.recipe.digest}>{view.recipe.name} · v{view.recipe.version}</span> : <span className="muted">—</span>}</dd>
        <dt>{t('Computer')}</dt><dd>{view.computer ? `${view.computer.target ?? '—'}${view.computer.platformLabel ? ` · ${view.computer.platformLabel}` : ''}` : <span className="muted">—</span>}</dd>
        <dt>{t('Configuration')}</dt><dd>{view.configuration ? t(CONFIGURATION[view.configuration] ?? view.configuration) : '—'}</dd>
        <dt>{t('Readiness')}</dt><dd>{view.readiness ? t(capitalise(view.readiness)) : '—'}</dd>
      </dl>}
      {view.reason && <Reason reason={view.reason} />}
      {setup && <div className="env-setup" aria-label={t('Setting up development environment')}>
        <p><strong>{t('Setting up development environment')}</strong></p>
        <ul className="env-progress">{setup.steps.map(step => <li key={step.id} className={`env-step env-step-${step.status}`}><span aria-hidden>{STEP_MARK[step.status]}</span> {t(step.label)}</li>)}</ul>
      </div>}
      {['creating', 'configuring', 'failed', 'not-ready'].includes(view.state) && !!view.progress.length && <ul className="env-progress" aria-label={t('Progress')}>
        {view.progress.map(step => <li key={step.id} className={`env-step env-step-${step.status}`}><span aria-hidden>{STEP_MARK[step.status]}</span> {t(step.label)}</li>)}</ul>}
      {view.state === 'none' && !creating && <p className="muted">{t('Foundry runs an agent’s work on a Compute environment: a Computer, configured for this project and verified ready.')}</p>}
      <div className="coding-actions">
        {view.actions.filter(action => action !== 'create' || !creating).map(action => <button key={action} className={action === 'destroy' ? 'secondary-button danger' : action === 'create' || action === 'open' ? 'primary-button' : 'secondary-button'} disabled={!!busy} onClick={() => void act(action)}>{t(ACTION_LABEL[action])}</button>)}
        {view.state === 'none' && <button className="secondary-button" disabled={!!busy} onClick={() => setCreating(current => !current)}>{t(creating ? 'Hide recipe choices' : 'Choose another recipe…')}</button>}
        {['none', 'missing'].includes(view.state) && <button className="secondary-button" disabled={!!busy} onClick={() => void chooseExisting()}>{t(attaching ? 'Hide existing environments' : 'Connect existing environment…')}</button>}
        {['none', 'missing'].includes(view.state) && <button className="secondary-button" disabled={!!busy} onClick={() => void window.douchat.openComputeUi()}>{t('Manage Compute')}</button>}
        {view.state === 'missing' && view.reference && <span className="muted">{t('Nothing is created until you choose to.')}</span>}
      </div>
      {error && <p className="coding-error" role="alert">{error}</p>}
      {attaching && <div className="env-attach">
        <p><strong>{t('Connect an existing Compute environment')}</strong></p>
        {!busy && !candidates.length ? <p className="muted">{t('Compute has no live or stopped environments to connect.')}</p> : candidates.length ? <div className="coding-inline">
          <label>{t('Environment')} <select value={selectedEnvironmentId} onChange={event => setSelectedEnvironmentId(event.target.value)}>
            {candidates.map(candidate => <option key={candidate.environmentId} value={candidate.environmentId}>{candidate.name} · {candidate.observed} · {candidate.environmentId}</option>)}
          </select></label>
          <button className="primary-button" disabled={!!busy || !selectedEnvironmentId} onClick={() => void attach()}>{t('Connect')}</button>
        </div> : null}
        <p className="coding-meta">{t('Foundry verifies the environment name and ID, then stores only this project’s connection. Compute remains the owner.')}</p>
      </div>}
      {creating && <CreateEnvironment project={project} onDone={next => { setView(next); setCreating(false) }} />}
      {open && view.reference && <Detail project={project} view={view} />}
    </>}
    {!!work.length && <div className="env-work" aria-label={t('Work')}>
      <h4>{t('Work')}</h4>
      <dl className="ci-facts">{work.map(row => <Fragment key={row.label}><dt>{t(row.label)}</dt><dd>{row.value}</dd></Fragment>)}</dl>
    </div>}
  </section>
}

/** A one-line reminder of where a session runs: “Environment developer · Linux x86_64 · Ready”, read from Compute. */
export function EnvironmentContext({ projectId }: { projectId: string }): ReactElement | null {
  const [view, setView] = useState<DevelopmentEnvironmentView>()
  useEffect(() => {
    let live = true
    const load = (): void => { try { window.douchat.environmentState(projectId).then(value => { if (live) setView(value) }, () => undefined) } catch { /* no environment API here: no context line */ } }
    load()
    const timer = setInterval(load, 10_000)
    return () => { live = false; clearInterval(timer) }
  }, [projectId])
  if (!view?.reference) return null
  return <p className="coding-meta env-context" aria-label={t('Environment')}>{tr('Environment {name}', { name: view.recipe?.name ?? view.reference.environment })}{view.computer?.platformLabel ? ` · ${view.computer.platformLabel}` : ''} · <EnvironmentStatus view={view} /></p>
}
