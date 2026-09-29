import { t, usePreferences } from '../preferences'
import { useEffect, useState } from 'react'
import { DEFAULT_DECISION_SETTINGS, type DecisionSettings as Settings } from '../../../shared/groupDecision'
import type { CustomModelConfig } from '../../../shared/customModels'
import { messageSendError } from '../messageQueue'

export function DecisionSettings() {
  usePreferences()
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_DECISION_SETTINGS })
  const [providers, setProviders] = useState<CustomModelConfig['providers']>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ error?: string; saveError?: string }>()
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let active = true
    void Promise.all([
      window.douchat.getDecisionSettings(),
      window.douchat.getCustomModels().then(config => config.providers).catch(() => [])
    ]).then(([value, configured]) => {
      if (!active) return
      setSettings(value)
      setProviders(configured)
      setLoaded(true)
    }).catch(error => { if (active) setNotice(messageSendError(error)) })
    return () => { active = false }
  }, [])
  const mode = settings.mode === 'leader' ? 'leader' : 'model'
  const provider = providers.find(item => item.id === settings.providerId)
  const update = (patch: Partial<Settings>) => { setSettings(value => ({ ...value, ...patch })); setNotice(''); setTestResult(undefined) }
  const chooseMode = (next: 'leader' | 'model') => {
    if (next === 'leader') update({ mode: 'leader', providerId: '', model: '' })
    else update({ mode: 'model', providerId: providers[0]?.id ?? '', model: providers[0]?.models[0] ?? '' })
  }
  async function testConnection() {
    setTesting(true); setNotice(''); setTestResult(undefined)
    try {
      const result = await window.douchat.testDecisionSettings(settings)
      if (!result.ok) throw new Error(result.error || 'Decision connection failed.')
      setTestResult({})
    } catch (error) {
      const fallback: Settings = { ...settings, mode: 'leader', providerId: '', model: '' }
      setSettings(fallback)
      try {
        setSettings(await window.douchat.saveDecisionSettings(fallback))
        setTestResult({ error: messageSendError(error) })
      } catch (saveError) {
        setTestResult({ error: messageSendError(error), saveError: messageSendError(saveError) })
      }
    } finally { setTesting(false) }
  }
  async function save() {
    setBusy(true); setNotice(''); setTestResult(undefined)
    try {
      setSettings(await window.douchat.saveDecisionSettings(settings))
      setNotice('Group decision settings saved. They apply to the next task.')
    } catch (error) { setNotice(messageSendError(error)) }
    finally { setBusy(false) }
  }
  return <section className="decision-settings" aria-label={t("Group decision service")}>
    <h2>{t("Group decision service")}</h2><p className="settings-note">{t("Choose who decides whether group messages need a reply and which members handle them. Members still use their own models to do the work.")}</p>
    <fieldset disabled={!loaded || busy || testing}>
      <label className="field-row"><span>{t("Decision mode")}</span><select value={mode} onChange={event => chooseMode(event.target.value as 'leader' | 'model')}>
        <option value="leader">{t("Default")}</option>{providers.length > 0 && <option value="model">{t("Decision model")}</option>}
      </select></label>
      {mode === 'leader' && <p className="settings-note decision-mode-note">{t("A group coordinator decides whether to reply, who handles the task, and in what order. No separate decision model is required.")}</p>}
      {mode === 'model' && <>
        <label className="field-row"><span>{t("Model provider")}</span><select value={settings.providerId} onChange={event => update({ providerId: event.target.value, model: providers.find(item => item.id === event.target.value)?.models[0] ?? '' })}>
          {providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label className="field-row"><span>{t("Model")}</span><select value={settings.model} onChange={event => update({ model: event.target.value })}>
          {(provider?.models ?? []).map(id => <option key={id} value={id}>{id}</option>)}
        </select></label>
      </>}
      <label className="field-row"><span>{t("Member health check interval (seconds)")}</span><input type="number" min={30} max={3600} step={30}
        value={settings.healthCheckIntervalSeconds ?? 300} onChange={event => update({ healthCheckIntervalSeconds: Number(event.target.value) })} /></label>
      <p className="settings-note">{t("Each group caches member availability and response time. New tasks refresh checks when the interval expires. Unavailable members receive no tasks until a successful check; unknown members may be rechecked after 30 seconds. Decisions consider health, skills, and response time.")}</p>
      <div className="decision-actions">
        {mode === 'model' && <button className="secondary-button" onClick={() => void testConnection()}>{t(testing ? "Testing…" : "Test connection")}</button>}
        <button className="primary-button" onClick={() => void save()}>{t("Save decision settings")}</button>
      </div>
      {mode === 'model' && <p className="settings-note">{t("A connection test sends one short request to your model provider, which may incur a small charge.")}</p>}
    </fieldset>
    {testResult && <p role={testResult.error ? 'alert' : 'status'} className="settings-note">
      {testResult.error ? <>{t("Decision connection failed.")} {t(testResult.error)}{' '}{t(testResult.saveError
        ? "Default mode is selected but could not be saved. Save it again."
        : "Switched to default decision mode and saved.")}{testResult.saveError && <> {t(testResult.saveError)}</>}</>
        : t("Decision service connected.")}
    </p>}
    {notice && <p role="status" className="settings-note">{t(notice)}</p>}
  </section>
}
