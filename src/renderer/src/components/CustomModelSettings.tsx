import { t, tr, usePreferences, resolveInterfaceLanguage } from '../preferences'
import { useEffect, useRef, useState } from 'react'
import { Plus, Pencil, Trash2, ShieldCheck, Check, ExternalLink, LoaderCircle, KeyRound } from 'lucide-react'
import { CUSTOM_MODEL_PRESETS, customEndpoint, providerRequiresApiKey, type CustomModelConfig, type CustomProviderInput, type CustomProviderView } from '../../../shared/customModels'
import { NativeDialog } from './NativeDialog'
import { messageSendError } from '../messageQueue'

type Draft = CustomProviderInput & { preset: string; hasKey: boolean }
export function CustomModelSettings() {
  const preferences = usePreferences()
  const presets = CUSTOM_MODEL_PRESETS.filter(p => p.id !== 'tokendance' || resolveInterfaceLanguage(preferences.language) === 'zh-CN')
  const [config, setConfig] = useState<CustomModelConfig>({ providers: [], defaultModel: '' })
  const [loading, setLoading] = useState(true)
  const [detectedOllama, setDetectedOllama] = useState<CustomProviderInput | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const selectedPreset = presets.find(p => p.id === draft?.preset)
  const [authMode, setAuthMode] = useState<'oauth' | 'apikey'>('oauth')
  const [authorizing, setAuthorizing] = useState(false)
  const [authorized, setAuthorized] = useState(false)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const generation = useRef(0)
  const authRequest = useRef(0)
  useEffect(() => {
    let active = true
    window.douchat.getCustomModels().then(value => { if (active) setConfig(value) }).catch(e => { if (active) setError(messageSendError(e)) }).finally(() => { if (active) setLoading(false) })
    void window.douchat.detectOllama?.().then(value => { if (active) setDetectedOllama(value) }).catch(() => {})
    return () => { active = false; generation.current++; void window.douchat.cancelTokenDanceAuthorization?.() }
  }, [])
  function edit(p?: CustomProviderView) {
    generation.current++; setError(''); setResult(null); setAuthMode('oauth'); setAuthorized(false)
    const preset = presets[0]
    setDraft(p ? { ...p, preset: presets.find(x => x.apiBase === p.apiBase)?.id ?? 'custom', apiKey: '' }
      : { ...preset, preset: preset.id, id: preset.id, apiKey: '', hasKey: false, modelLabels: {} })
  }
  function close() { generation.current++; authRequest.current++; void window.douchat.cancelTokenDanceAuthorization(); setAuthorizing(false); setDraft(null) }
  function useDetectedOllama() {
    if (!detectedOllama) return
    generation.current++; setError(''); setResult(null); setDraft({ ...detectedOllama, preset: 'ollama', apiKey: '', hasKey: false, modelLabels: {} })
  }
  async function authorize() {
    const authId = ++authRequest.current
    const request = ++generation.current
    setAuthorizing(true); setError(''); setResult(null)
    try {
      const apiKey = await window.douchat.authorizeTokenDance()
      if (request === generation.current) { setDraft(previous => previous && { ...previous, apiKey }); setAuthorized(true) }
    } catch (e) { if (request === generation.current) setError(messageSendError(e)) }
    finally { if (authRequest.current === authId) setAuthorizing(false) }
  }
  function change(patch: Partial<Draft>) { generation.current++; setResult(null); if (authorizing) void window.douchat.cancelTokenDanceAuthorization(); setDraft(previous => previous && { ...previous, ...patch }) }
  function input(): CustomProviderInput {
    const d = draft!
    const models = [...new Set(d.models.map(m => m.trim()).filter(Boolean))]
    return { id: d.id, name: d.name, kind: d.kind, apiBase: d.apiBase, apiKey: d.apiKey || undefined, ...(d.kind === 'anthropic' && d.workspaceId?.trim() ? { workspaceId: d.workspaceId.trim() } : {}), models, modelLabels: Object.fromEntries(models.map(model => [model, d.modelLabels?.[model]?.trim() || '']).filter(([, label]) => label)), reasoningModels: models.filter(model => d.reasoningModels?.includes(model)),
      ...(models.some(model => d.pricing?.[model]) ? { pricing: Object.fromEntries(models.filter(model => d.pricing?.[model]).map(model => [model, d.pricing![model]!])) } : {}) }
  }
  async function persist(providers: CustomProviderInput[], defaultModel: string) {
    setBusy(true); setError('')
    try { setConfig(await window.douchat.saveCustomModels(providers, defaultModel)); setDraft(null) }
    catch (e) { setError(messageSendError(e)) }
    finally { setBusy(false) }
  }
  async function test() {
    const provider = input(); const request = ++generation.current
    setTesting(true); setResult(null)
    try { const value = await window.douchat.testCustomModel({ provider, model: provider.models[0] ?? '' }); if (request === generation.current) setResult(value) }
    catch (e) { if (request === generation.current) setResult({ ok: false, error: messageSendError(e) }) }
    finally { setTesting(false) }
  }
  return <>
    <header className="settings-heading local-proxy-heading"><div><h1>{t("Models")}</h1><p>{t("Add API model services such as Anthropic, OpenAI, OpenRouter, or Ollama. Installed command-line agents are selected under Create agent → Local agent and do not appear here.")}</p></div><div className="custom-model-actions">{detectedOllama && !config.providers.some(provider => provider.id === 'ollama') && <button className="secondary-button" disabled={loading || busy} onClick={useDetectedOllama}><Check size={15} />{t("Use detected Ollama")}</button>}<button className="secondary-button" disabled={loading || busy} onClick={() => edit()}><Plus size={15} />{t("Add provider")}</button></div></header>
    {loading ? <p role="status">{t("Loading model settings…")}</p> : <>
      {config.providers.length > 0 && <div className="field-row custom-default-model">
        <label htmlFor="unified-default-model">{t('Default model')}</label>
        <select id="unified-default-model" value={config.defaultModel} disabled={busy} onChange={event => void persist(config.providers, event.target.value)}>
          {config.providers.flatMap(provider => provider.models.map(model => `${provider.id}/${model}`))
            .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }))
            .map(model => <option key={model} value={model}>{model}</option>)}
        </select>
        <p className="settings-note">{t('Agents following the default will use this model for their next reply. Individually selected models stay unchanged.')}</p>
      </div>}
      {!config.providers.length ? <div className="custom-model-empty"><strong>{t("No providers yet")}</strong><p>{t("Add a provider to create agents with your own models.")}</p><span>{t("Supports Ollama, OpenAI Chat Completions and Anthropic Messages")}</span></div> : <div className="custom-model-table"><table><thead><tr><th>{t("Provider")}</th><th>{t("API URL")}</th><th>{t("Models")}</th><th>{t("Actions")}</th></tr></thead><tbody>{config.providers.map(p => <tr key={p.id}><td><strong>{p.name}</strong><small>{p.kind === 'anthropic' ? 'Anthropic Messages' : p.kind === 'ollama' ? 'Ollama' : 'OpenAI Chat Completions'}</small></td><td><code>{p.apiBase}</code></td><td>{p.models.length}</td><td><div className="custom-model-actions"><button className="icon-button" aria-label={tr('Edit {name}', { name: p.name })} onClick={() => edit(p)}><Pencil size={16} /></button><button className="icon-button" aria-label={tr('Delete {name}', { name: p.name })} disabled={busy} onClick={() => { if (window.confirm(tr('Remove {name}? Agents using these models will be unable to chat until reconfigured. Chat history will be kept.', { name: p.name }))) void persist(config.providers.filter(provider => provider.id !== p.id), config.defaultModel) }}><Trash2 size={16} /></button></div></td></tr>)}</tbody></table></div>}
    </>}
    {error && !draft && <p className="settings-error" role="alert">{t(error)}</p>}
    {draft && <NativeDialog className="modal-backdrop" onClose={() => { if (!busy && !testing) close() }} width={600} height={730}>
      <form className="agent-modal custom-model-form" role="dialog" aria-modal="true" aria-labelledby="custom-model-title" onSubmit={e => { e.preventDefault(); if (busy || testing || authorizing || (providerRequiresApiKey(draft.kind) && !draft.hasKey && !draft.apiKey?.trim())) return; const p = input(); void persist(config.providers.some(x => x.id === p.id) ? config.providers.map(x => x.id === p.id ? p : x) : [...config.providers, p], config.defaultModel || `${p.id}/${p.models[0]}`) }}>
        <h2 id="custom-model-title">{draft.hasKey ? t("Edit provider") : t("Add provider")}</h2>
        {!draft.hasKey && <p className="settings-note">{t('Looking for Claude Code, Codex, Gemini, Grok, or OpenCode? These are local agents, not model providers. Select one when creating an agent under Runs with → Local agent.')}</p>}
        <div className="custom-model-fields"><label className="field-row"><span>{t("Provider preset")}</span><select value={selectedPreset?.id ?? 'custom'} disabled={busy} onChange={e => { const p = presets.find(x => x.id === e.target.value); setAuthMode('oauth'); setAuthorized(false); change(p ? { apiKey: '', hasKey: false, preset: p.id, id: p.id, name: p.name, kind: p.kind, apiBase: p.apiBase, models: p.id === 'ollama' ? [...(detectedOllama?.models ?? [''])] : [...p.models], modelLabels: {} } : { preset: 'custom', hasKey: false, id: '', name: '', apiBase: '', apiKey: '', models: [''], modelLabels: {} }) }}>{presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}<option value="custom">{t("Other / Custom")}</option></select></label>
        <label className="field-row"><span>{t("API type")}</span><select value={draft.kind} onChange={e => change({ kind: e.target.value as Draft['kind'] })}><option value="openai">OpenAI Chat Completions</option><option value="anthropic">Anthropic Messages</option><option value="ollama">Ollama</option></select></label></div>
        <div className="custom-model-fields"><label className="field-row"><span>{t("Identifier")}</span><input required pattern="[a-zA-Z0-9-]{1,80}" value={draft.id} onChange={e => change({ id: e.target.value })} placeholder={t("e.g. openrouter")} /></label><label className="field-row"><span>{t("Display name")}</span><input required value={draft.name} onChange={e => change({ name: e.target.value })} placeholder={t("e.g. OpenRouter")} /></label></div>
        <label className="field-row"><span>{t("API URL")}</span><input required type="url" value={draft.apiBase} onChange={e => { setAuthorized(false); change({ apiBase: e.target.value, apiKey: '' }) }} placeholder="https://api.example.com/v1" /></label>
        {draft.kind === 'anthropic' && <label className="field-row"><span>Workspace ID <small>(required only for organization-scoped keys)</small></span><input value={draft.workspaceId ?? ''} onChange={e => change({ workspaceId: e.target.value })} placeholder="wrkspc_…" /></label>}
        {selectedPreset?.id === 'tokendance' && <div className="field-row">
          <label htmlFor="tokendance-auth-mode">{t('Authentication method')}</label>
          <select id="tokendance-auth-mode" value={authMode} onChange={e => { change({}); setError(''); setAuthMode(e.target.value as 'oauth' | 'apikey') }}>
            <option value="oauth">{t('OAuth (recommended)')}</option><option value="apikey">{t('Enter API key manually')}</option>
          </select>
          {authMode === 'oauth' && <div className="provider-auth-card" data-state={authorizing ? 'pending' : authorized ? 'authorized' : draft.hasKey ? 'saved' : 'idle'}>
            <div className="provider-auth-heading">
              <span className="provider-auth-icon" aria-hidden="true"><ShieldCheck size={19} /></span>
              <div className="provider-auth-copy">
                <p className="settings-note">{t(authorized ? 'Save this provider to keep the new credential on this device.' : draft.hasKey ? 'Your saved credential is ready to use. Authorize again only to replace it.' : 'Continue in your browser. No API key to copy.')}</p>
              </div>
            </div>
            <div className="provider-auth-status" role="status" aria-live="polite">
              {authorizing ? <><LoaderCircle size={14} className="provider-auth-spinner" aria-hidden="true" />{t('Waiting for browser authorization…')}</> : (authorized || draft.hasKey) ? <><Check size={14} aria-hidden="true" />{authorized ? t('Authorization successful. Save to finish.') : t('Credential saved')}</> : null}
            </div>
            <div className="provider-auth-actions">
              <button className={`provider-auth-button ${authorized || draft.hasKey ? 'secondary-button' : 'primary-button'}`} type="button" disabled={busy || testing || authorizing || draft.apiBase.replace(/\/+$/, '') !== 'https://tokendance.space/gateway/v1'} onClick={() => void authorize()}><ExternalLink size={14} aria-hidden="true" />{(authorized || draft.hasKey) ? t('Authorize again') : t('Authorize TokenDance')}</button>
              {authorizing && <button className="provider-auth-button secondary-button" type="button" onClick={() => { generation.current++; void window.douchat.cancelTokenDanceAuthorization() }}>{t('Cancel authorization')}</button>}
            </div>
          </div>}
        </div>}
        {providerRequiresApiKey(draft.kind) && (selectedPreset?.id !== 'tokendance' || authMode === 'apikey') && <div className="field-row">
          <label htmlFor="provider-api-key">{t("API key")}</label>
          <input id="provider-api-key" type="password" autoComplete="new-password" required={!draft.hasKey} value={draft.apiKey} onChange={e => change({ apiKey: e.target.value })} placeholder={draft.hasKey ? t("Leave empty to keep the saved key") : t("Enter API key")} />
          {selectedPreset?.apiKeyUrl && <div className="provider-auth-card">
            <div className="provider-auth-heading">
              <span className="provider-auth-icon" aria-hidden="true"><KeyRound size={19} /></span>
              <div className="provider-auth-copy"><p className="settings-note">{t('Create an API key on the provider website, then paste it above.')}</p></div>
            </div>
            <div className="provider-auth-actions">
              <a className="provider-auth-button primary-button" href={selectedPreset.apiKeyUrl} target="_blank" rel="noopener noreferrer" onClick={event => { event.preventDefault(); window.open(event.currentTarget.href, '_blank', 'noopener,noreferrer') }}><ExternalLink size={14} aria-hidden="true" />{t('Create an API key')}</a>
            </div>
          </div>}
        </div>}
        <div className="field-row custom-model-list">
          <span id="custom-model-list-label">{t("Models (ID / display name)")}</span>
          <div className="custom-model-inputs" role="group" aria-labelledby="custom-model-list-label">
            {draft.models.map((model, index) => <div className="custom-model-input-row" key={index}>
              <input aria-label={t("Model ID ") + (index + 1)} value={model} disabled={busy || testing} placeholder={t("Model ID, e.g. org/model")} onChange={e => change({ models: draft.models.map((value, i) => i === index ? e.target.value : value) })} />
              <input aria-label={t("Model display name ") + (index + 1)} value={draft.modelLabels?.[model] || ''} disabled={busy || testing} placeholder={t("Display name (optional)")} onChange={e => change({ modelLabels: { ...draft.modelLabels, [model]: e.target.value } })} />
              <label className="custom-model-reasoning" title={t("The model accepts a thinking level")}><input type="checkbox" aria-label={t("Supports thinking ") + (index + 1)} checked={Boolean(model.trim() && draft.reasoningModels?.includes(model.trim()))} disabled={busy || testing || !model.trim()} onChange={e => { const id = model.trim(); const rest = (draft.reasoningModels ?? []).filter(item => item !== id); change({ reasoningModels: e.target.checked ? [...rest, id] : rest }) }} />{t("Thinking")}</label>
              <select className="custom-model-pricing" aria-label={t("Pricing ") + (index + 1)} title={t("What you know about this model’s price, when the provider’s catalog does not say. Unknown models are never used by free-only routing.")} value={draft.pricing?.[model.trim()] ?? ''} disabled={busy || testing || !model.trim()}
                onChange={e => { const id = model.trim(); const { [id]: _removed, ...rest } = draft.pricing ?? {}; change({ pricing: e.target.value ? { ...rest, [id]: e.target.value as 'free' | 'beta-free' | 'trial' } : rest }) }}>
                <option value="">{t("Price unknown")}</option><option value="free">{t("Free")}</option><option value="beta-free">{t("Free (beta)")}</option><option value="trial">{t("Free trial")}</option>
              </select>
              <button className="icon-button" type="button" aria-label={t("Remove model ") + (index + 1)} disabled={busy || testing || draft.models.length === 1} onClick={() => change({ models: draft.models.filter((_, i) => i !== index) })}><Trash2 size={16} /></button>
            </div>)}
          </div>
          <button className="custom-model-add" type="button" disabled={busy || testing} onClick={() => change({ models: [...draft.models, ''] })}><Plus size={15} />{t("Add model")}</button>
        </div>
        <div className="custom-model-test-note"><p className="settings-note">{t("The connection test sends a short message to the first model and may incur a small charge.")}</p><p className="settings-note custom-model-endpoint">{t("Test endpoint: ")}{customEndpoint(draft.apiBase, draft.kind)}</p></div>
        {result && <p role="status" className={result.ok ? 'custom-model-success' : 'settings-error'}>{result.ok ? t("Connection successful") : result.error}</p>}
        {error && <p className="settings-error" role="alert">{t(error)}</p>}
        <div className="modal-footer"><button className="secondary-button" type="button" disabled={busy || testing || authorizing || (providerRequiresApiKey(draft.kind) && !draft.hasKey && !draft.apiKey?.trim()) || !draft.models.some(model => model.trim())} onClick={() => void test()}>{testing ? t("Testing…") : t("Test connection")}</button><div className="custom-model-footer-actions"><button className="secondary-button" type="button" disabled={busy || testing} onClick={close}>{t("Cancel")}</button><button className="primary-button" disabled={busy || testing || authorizing || (providerRequiresApiKey(draft.kind) && !draft.hasKey && !draft.apiKey?.trim()) || !draft.models.some(model => model.trim())}>{busy ? t("Saving…") : t("Save")}</button></div></div>
      </form>
    </NativeDialog>}
  </>
}
