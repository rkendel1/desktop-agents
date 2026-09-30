import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { budgetLabel, decisionNotice, type ModelDecision, type ModelFabricStatus, type ModelStatusEntry } from '../../../shared/modelFabric'
import { t, tr } from '../preferences'

/**
 * Foundry → Models: one promise — use the best AI currently available, and keep it free. The panel shows the pool and the policy and
 * lets the person turn things off; it never asks them to pick a model. Every number is Foundry’s answer for the current state,
 * asked again on a timer, and the metrics on a model are labelled as what Foundry itself observed, not what a vendor claims.
 */
const clean = (cause: unknown): string => cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(cause)
const CAPABILITIES: [keyof ModelStatusEntry['candidate']['capabilities'], string][] = [['coding', 'Coding'], ['reasoning', 'Reasoning'], ['toolUse', 'Tools'], ['structuredOutput', 'Structured output'], ['vision', 'Vision'], ['streaming', 'Streaming']]
const ACCESS: Record<string, string> = { local: 'Local (runs on this computer)', free: 'Free', beta: 'Free (beta)', trial: 'Free trial', 'user-authorized': 'Authorized by you (may cost money)', paid: 'Paid', unknown: 'Unknown (not used: pricing unknown)' }
const BASIS: Record<string, string> = { 'local-endpoint': 'runs on this computer', 'catalog-pricing': 'from the provider’s published prices', configured: 'as you configured it', none: 'no evidence' }
const compact = (tokens?: number): string => tokens === undefined ? '—' : tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}K`
const mark = (entry: ModelStatusEntry): string => entry.eligible ? (entry.health.state === 'degraded' ? '◐' : '●') : entry.rejection?.stage === 'health' ? '◐' : '○'
const words = (entry: ModelStatusEntry): string => {
  if (entry.eligible) return entry.health.state === 'degraded' ? 'Recovering' : 'Ready'
  const reason = entry.rejection
  if (reason?.stage === 'health') return reason.reason === 'cooldown' ? 'Cooling down' : 'Unavailable'
  return (reason?.reason ?? 'not eligible').replace(/-/g, ' ').replace(/^./, letter => letter.toUpperCase())
}

function Detail({ entry, onEnabled, busy }: { entry: ModelStatusEntry; onEnabled: (enabled: boolean) => void; busy: boolean }): ReactElement {
  const { candidate, health } = entry
  const success = health.requests ? `${((health.successes / health.requests) * 100).toFixed(1)}%` : '—'
  return <div className="fabric-detail" aria-label={candidate.label ?? candidate.model}>
    <h4>{candidate.label ?? candidate.model}</h4>
    <p className="coding-meta">{candidate.providerName}</p>
    <p><span aria-hidden>{mark(entry)}</span> {t(words(entry))}{entry.rejection?.detail ? <span className="muted"> — {entry.rejection.detail}</span> : null}</p>
    <h5>{t('Capabilities')}</h5>
    <ul className="fabric-capabilities">{CAPABILITIES.map(([key, name]) => <li key={key}><span aria-hidden>{candidate.capabilities[key] ? '✓' : '–'}</span> {t(name)}</li>)}</ul>
    <dl className="ci-facts">
      <dt>{t('Context')}</dt><dd>{compact(candidate.capabilities.contextTokens ?? candidate.limits.contextTokens)}</dd>
      <dt>{t('Access')}</dt><dd>{t(ACCESS[candidate.access] ?? candidate.access)} <span className="muted">— {t(BASIS[candidate.accessBasis] ?? '')}</span></dd>
      <dt>{t('Checked')}</dt><dd>{new Date(candidate.observedAt).toLocaleString()} <span className="muted">· {tr('trusted until {time}', { time: new Date(candidate.expiresAt).toLocaleTimeString() })}</span></dd>
    </dl>
    <h5>{t('Foundry observed')}</h5>
    <dl className="ci-facts">
      <dt>{t('Latency')}</dt><dd>{health.p50LatencyMs !== undefined ? `${Math.round(health.p50LatencyMs)}ms` : '—'}{health.p95LatencyMs !== undefined ? <span className="muted"> · p95 {Math.round(health.p95LatencyMs)}ms</span> : null}</dd>
      <dt>{t('Success')}</dt><dd>{success}</dd>
      <dt>{t('Requests')}</dt><dd>{health.requests}{health.rateLimited ? <span className="muted"> · {tr('{count} rate limited', { count: health.rateLimited })}</span> : null}{health.timeouts ? <span className="muted"> · {tr('{count} timeouts', { count: health.timeouts })}</span> : null}</dd>
    </dl>
    <p className="muted">{t('Measured by Foundry on this computer while you used it. These are not vendor claims or benchmarks.')}</p>
    <label className="fabric-switch"><input type="checkbox" checked={candidate.enabled} disabled={busy} onChange={event => onEnabled(event.target.checked)} /> {t('Use automatically')}</label>
  </div>
}

export function ModelFabricPanel(): ReactElement {
  const [status, setStatus] = useState<ModelFabricStatus | { error: string }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showModels, setShowModels] = useState(false)
  const [chosen, setChosen] = useState<string>()
  const load = useCallback(async (): Promise<void> => { try { setStatus(await window.douchat.modelFabricStatus()) } catch (cause) { setStatus({ error: clean(cause) }) } }, [])
  useEffect(() => {
    void load()
    const timer = setInterval(() => { void load() }, 15_000)
    return () => clearInterval(timer)
  }, [load])
  const run = async (work: () => Promise<ModelFabricStatus>): Promise<void> => {
    setBusy(true); setError('')
    try { setStatus(await work()) } catch (cause) { setError(clean(cause)) } finally { setBusy(false) }
  }

  if (!status) return <section className="fabric" aria-label={t('AI models')}><p className="muted">{t('Asking Foundry…')}</p></section>
  if ('error' in status) return <section className="fabric" aria-label={t('AI models')}><p className="coding-error" role="alert">{status.error}</p></section>

  const { policy } = status
  const connected = status.providers.filter(provider => provider.connected && provider.models > 0)
  const selected = status.entries.find(entry => entry.candidate.id === chosen)
  const lastFailure = status.recentDecisions.find(decision => decision.outcome !== 'succeeded')
  const lastSwitch = status.recentDecisions.map(decision => ({ decision, notice: decisionNotice(decision, new Map(status.entries.map(entry => [entry.candidate.id, `${entry.candidate.label ?? entry.candidate.model} · ${entry.candidate.providerName}`] as const))) })).find(item => item.notice?.kind === 'switched')
  const why = (() => {
    if (!status.current) return t('No eligible model right now.')
    const health = status.current.health
    return health.requests ? t('Best available match: the eligible model with the best record here, then the fastest.') : t('No history yet: the first eligible model, in a fixed order. Foundry learns as models answer.')
  })()

  return <section className="fabric" aria-label={t('AI models')}>
    <h2>{t('Models')}</h2>
    <p className="fabric-title"><span aria-hidden className={`fabric-dot ${status.eligible ? 'ok' : 'none'}`}>●</span> <strong>{t('Free AI')}</strong></p>
    <p className="muted">{t('Foundry automatically finds available free and beta models and switches when a model reaches its limit.')}</p>

    <dl className="ci-facts fabric-facts">
      <dt>{t('Cost')}</dt><dd><strong>$0.00</strong> <span className="muted">— {t(budgetLabel(policy.budget))}: {t('a paid model can never be called.')}</span></dd>
      <dt>{t('Available')}</dt><dd>{tr('{models} models · {providers} providers', { models: status.eligible, providers: connected.filter(provider => provider.eligible > 0).length })}</dd>
      <dt>{t('Current')}</dt><dd>{status.current ? <>{status.current.candidate.label ?? status.current.candidate.model}<br /><span className="muted">{status.current.candidate.providerName}</span></> : <span className="coding-error">{t('None available')}</span>}</dd>
      <dt>{t('Why this model?')}</dt><dd>{why}</dd>
    </dl>
    <p className="muted">{t(status.costNote)}</p>

    {!status.eligible && <p className="coding-error" role="alert">{status.discovered ? t('No free model is available right now. Nothing paid will be used. Try again shortly.') : t('No models discovered yet. Connect a provider below, then find models.')}</p>}
    {lastFailure && <p className="coding-error" role="alert">{t('Foundry couldn’t complete the last request.')} {t('All currently available free models are unavailable or rate limited.')} {t('No paid model was used.')} {t('Try again shortly.')}</p>}
    {lastSwitch?.notice && <p className="fabric-notice" role="status"><strong>{t(lastSwitch.notice.title)}</strong> — {lastSwitch.notice.detail}</p>}

    <div className="fabric-switches">
      <label className="fabric-switch"><input type="checkbox" checked={policy.automatic} disabled={busy} onChange={event => void run(() => window.douchat.modelFabricPolicy({ automatic: event.target.checked }))} /> {t('Automatic model selection')}</label>
      <label className="fabric-switch"><input type="checkbox" checked disabled /> {t('Free only')}</label>
      <label className="fabric-switch"><input type="checkbox" checked={policy.failover} disabled={busy} onChange={event => void run(() => window.douchat.modelFabricPolicy({ failover: event.target.checked }))} /> {t('Automatically fail over')}</label>
      <label className="fabric-switch"><input type="checkbox" checked={policy.useBeta} disabled={busy} onChange={event => void run(() => window.douchat.modelFabricPolicy({ useBeta: event.target.checked }))} /> {t('Automatically use beta models')}</label>
    </div>
    {!policy.automatic && <p className="muted">{t('Automatic selection is off: each agent keeps using its own model, as before.')}</p>}

    <div className="coding-actions">
      <button className="secondary-button" onClick={() => setShowModels(current => !current)}>{showModels ? t('Hide available models') : t('View available models')}</button>
      <button className="secondary-button" disabled={busy} onClick={() => void run(() => window.douchat.modelFabricDiscover())}>{t('Find models')}</button>
    </div>
    {error && <p className="coding-error" role="alert">{error}</p>}

    {showModels && <div className="fabric-models" aria-label={t('Available models')}>
      {!status.entries.length ? <p className="muted">{t('Nothing discovered yet.')}</p> : <table>
        <thead><tr><th>{t('Provider')}</th><th>{t('Model')}</th><th>{t('Access')}</th><th>{t('Status')}</th></tr></thead>
        <tbody>{status.entries.map(entry => <tr key={entry.candidate.id} className={chosen === entry.candidate.id ? 'selected' : ''}>
          <td>{entry.candidate.providerName}</td>
          <td><button className="link-button" onClick={() => setChosen(entry.candidate.id === chosen ? undefined : entry.candidate.id)}>{entry.candidate.label ?? entry.candidate.model}</button></td>
          <td>{t(entry.candidate.access === 'beta' ? 'Free (beta)' : entry.candidate.access.replace(/^./, letter => letter.toUpperCase()))}</td>
          <td><span aria-hidden>{mark(entry)}</span> {t(words(entry))}</td></tr>)}</tbody>
      </table>}
      {selected && <Detail entry={selected} busy={busy} onEnabled={enabled => void run(() => window.douchat.modelFabricEnable(selected.candidate.id, enabled))} />}
    </div>}

    <h3>{t('Providers')}</h3>
    {!status.providers.length ? <p className="muted">{t('No provider is connected. Add one below; its key stays in the system credential store.')}</p> : <ul className="fabric-providers">
      {status.providers.map(provider => <li key={provider.id}><strong>{provider.name}</strong> — {provider.connected ? t('Connected') : t('Not connected')}
        <span className="muted"> · {tr('{models} models, {eligible} eligible', { models: provider.models, eligible: provider.eligible })}</span>
        {provider.error && <span className="coding-error"> · {provider.error}</span>}</li>)}
    </ul>}
    <p className="muted">{t('Connect a provider with its own key under “Custom models” below. Foundry never asks for one Foundry-owned key.')}</p>
    {!!status.recentDecisions.length && <details className="fabric-activity"><summary>{t('Recent routing decisions')}</summary>
      <ul>{status.recentDecisions.map((decision: ModelDecision) => <li key={decision.requestId}>{decision.outcome === 'succeeded' ? '✓' : '✗'} {decision.selected ?? t('no model')} <span className="muted">· {decision.attempts.length} {t('attempts')} · {decision.costPolicy}</span></li>)}</ul></details>}
  </section>
}
