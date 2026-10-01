import { useContext, useEffect, useRef, useState, type ReactElement } from 'react'
import { X } from 'lucide-react'
import type { AgentConfig, LocalAgent } from '../../../shared/types'
import { configurableLocalAgents, localModelId, type LocalModelList } from '../../../shared/localModels'
import { isChatModelProvider, type CustomModelConfig } from '../../../shared/customModels'
import { DEFAULT_CLOUD_THINKING_LEVEL, THINKING_LEVELS, THINKING_LEVEL_LABELS, localThinkingLevels, type ThinkingLevel } from '../../../shared/thinkingLevels'
import { t, tr } from '../preferences'
import { EmbeddedAgentSettings, AgentDialogSurface as NativeDialog } from './AgentDialogSurface'

export function LocalModelDialog({ agent, localAgents = [], onModelSettings, onClose, onSave }: {
  agent: AgentConfig; localAgents?: LocalAgent[]; onModelSettings?: () => void; onClose: () => void
  onSave: (model: string, provider: string | undefined, thinkingLevel: ThinkingLevel | 'default', modelSelectionStrategy: 'best' | 'lowest-cost' | undefined, localAgentId: string | undefined) => Promise<void>
}): ReactElement {
  const embedded = useContext(EmbeddedAgentSettings)
  const [model, setModel] = useState(agent.model && agent.model !== 'default' ? agent.model : '')
  const [manualModel, setManualModel] = useState(false)
  const [list, setList] = useState<LocalModelList>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [thinking, setThinking] = useState<ThinkingLevel | 'default'>(agent.thinkingLevel ?? 'default')
  const [revision, setRevision] = useState(0)
  const installedLocalAgents = localAgents.filter(item => item.installed)
  const [selectedLocalAgentId, setSelectedLocalAgentId] = useState(agent.localAgentId ?? '')
  const custom = !selectedLocalAgentId
  const [customModels, setCustomModels] = useState<CustomModelConfig>()
  const [customProviderId, setCustomProviderId] = useState(agent.modelSelectionStrategy === 'lowest-cost' ? '@lowest-cost' : agent.modelSelectionStrategy === 'best' || agent.automaticModelSelection ? '@automatic' : agent.followDefaultModel ? '@default' : agent.provider?.startsWith('custom:') ? agent.provider.slice('custom:'.length) : '@default')
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (!custom) return
    let active = true
    setLoading(true)
    window.douchat.getCustomModels().then(result => { if (active) setCustomModels(result) })
      .catch(() => { if (active) setError(t("Could not load custom models. Try again in Settings.")) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [custom])
  useEffect(() => {
    if (custom) return
    let active = true
    setLoading(true); setError('')
    window.douchat.listLocalAgentModels(agent.id, selectedLocalAgentId).then(result => { if (active) setList(result) })
      .catch(() => { if (active) setError(t('Could not load models. Retry or enter a model ID.')) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [agent.id, revision, custom, selectedLocalAgentId])
  const supported = configurableLocalAgents.includes(selectedLocalAgentId)
  const chatProviders = customModels?.providers.filter(isChatModelProvider) ?? []
  const selectedProvider = chatProviders.find(provider => provider.id === customProviderId)
  const automaticSelection = customProviderId === '@automatic' || customProviderId === '@lowest-cost'
  const validSelection = automaticSelection || customProviderId === '@default' ? Boolean(customModels?.defaultModel) : selectedProvider?.models.includes(model)
  const localModels = list?.models ?? []
  const reasoningProvider = customProviderId === '@default' ? chatProviders.find(provider => customModels?.defaultModel.startsWith(provider.id + '/')) : selectedProvider
  const reasoningModel = customProviderId === '@default' ? customModels?.defaultModel.slice((reasoningProvider?.id.length ?? 0) + 1) : model
  const discoveredThinking = reasoningModel ? reasoningProvider?.thinkingLevels?.[reasoningModel] : undefined
  const thinkingLevels: readonly ThinkingLevel[] = !custom ? localThinkingLevels(selectedLocalAgentId)
    : discoveredThinking?.length ? ['off', ...discoveredThinking]
      : reasoningProvider?.reasoningModels?.includes(reasoningModel ?? '') ? THINKING_LEVELS : []
  const thinkingSupported = thinkingLevels.length > 0
  const defaultThinkingLabel = custom ? tr('Default ({level})', { level: t(THINKING_LEVEL_LABELS[DEFAULT_CLOUD_THINKING_LEVEL]) }) : t('Use agent’s thinking setting')
  return <NativeDialog width={560} className="modal-backdrop" onClose={() => !saving && onClose()}>
    <form className="agent-modal agent-permissions-modal local-model-modal" role="dialog" aria-modal="true" aria-labelledby="local-model-title" onSubmit={async event => {
      event.preventDefault()
      if (saving || (custom && (loading || !validSelection))) return
      try {
        const selected = custom ? model : localModelId(model) ?? 'default'
        setSaving(true); setError('')
        const level = thinkingSupported ? thinking : agent.thinkingLevel ?? 'default'
        await (custom
          ? onSave(automaticSelection ? 'default' : selected, `custom:${automaticSelection ? '@default' : customProviderId}`, level, automaticSelection ? (customProviderId === '@lowest-cost' ? 'lowest-cost' : 'best') : undefined, undefined)
          : onSave(selected, undefined, level, undefined, selectedLocalAgentId))
        if (alive.current) onClose()
      } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : t('Could not save changes')) }
      finally { if (alive.current) setSaving(false) }
    }}>
      <header className="edit-contact-heading"><h2 id="local-model-title">{t('Configure model')}</h2>
        <button type="button" className="icon-button" aria-label={t('Close')} disabled={saving} onClick={onClose}><X size={20} /></button></header>
      <div className="permission-body local-model-body">
      <p className="permission-agent-name">{agent.name}</p>
      <div className="custom-model-selection"><label className="field-row"><span>{t('Execution type')}</span><select aria-label={t('Execution type')} value={custom ? 'provider' : 'local'} disabled={saving} onChange={event => {
        const next = event.target.value === 'local' ? (agent.localAgentId && installedLocalAgents.some(item => item.id === agent.localAgentId) ? agent.localAgentId : installedLocalAgents[0]?.id ?? '') : ''
        setSelectedLocalAgentId(next); setManualModel(false); setModel(next === agent.localAgentId && agent.model !== 'default' ? agent.model : '')
      }}><option value="provider">{t('Model provider')}</option><option value="local" disabled={!installedLocalAgents.length}>{t('Local command-line agent')}</option></select></label></div>
      {custom ? <>
        <div className="custom-model-selection">
          <label className="field-row"><span>{t('Provider')}</span><select aria-label={t('Provider')} value={customProviderId} disabled={saving || loading} onChange={event => {
            const providerId = event.target.value
            setCustomProviderId(providerId)
            if (!providerId.startsWith('@')) setModel(customModels?.providers.find(provider => provider.id === providerId)?.models[0] ?? '')
          }}>
            <option value="@default" disabled={!customModels?.defaultModel}>{t('Follow default model')}</option>
            <option value="@automatic" disabled={!customModels?.defaultModel}>{t('Choose the best model for the job')}</option>
            <option value="@lowest-cost" disabled={!customModels?.defaultModel}>{t('Choose the best price available')}</option>
            {chatProviders.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
          </select></label>
          {!customProviderId.startsWith('@') && <label className="field-row"><span>{t('Model')}</span><select aria-label={t('Model')} value={model} disabled={saving || loading} onChange={event => setModel(event.target.value)}>
            {(selectedProvider?.models ?? []).map(id => <option key={id} value={id}>{selectedProvider?.modelLabels?.[id] ?? id}</option>)}
          </select></label>}
        </div>
        {loading && <p role="status">{t("Loading model settings…")}</p>}
        {automaticSelection && <p className="settings-note">{customProviderId === '@lowest-cost' ? t('Foundry will use the lowest-cost eligible configured model. The current routing policy only permits models classified as free.') : t('Foundry will evaluate each request and choose the best eligible configured model under your model-routing policy.')}</p>}
        <p className="settings-note">{t("Use your own API key. Your model provider handles billing.")} <button type="button" className="local-settings-link" disabled={saving} onClick={onModelSettings}>{t("Configure model")}</button></p>
      </> : <>
        <div className="custom-model-selection">
          <label className="field-row"><span>{t('Local agent')}</span><select aria-label={t('Local agent')} value={selectedLocalAgentId} disabled={saving} onChange={event => {
            const next = event.target.value
            setSelectedLocalAgentId(next); setManualModel(false); setModel(next === agent.localAgentId && agent.model !== 'default' ? agent.model : '')
          }}>{installedLocalAgents.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label className="field-row"><span>{t('Model')}</span><select aria-label={t('Model')} value={manualModel ? '__manual__' : model} disabled={saving || loading || !supported} onChange={event => {
            const value = event.target.value
            setManualModel(value === '__manual__')
            if (value !== '__manual__') setModel(value)
          }}>
            <option value="">{t('Use agent default')}</option>
            {model && !localModels.some(item => item.id === model) && <option value={model}>{model}</option>}
            {localModels.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            {supported && <option value="__manual__">{t("Enter a model ID manually")}</option>}
          </select></label>
        </div>
        {supported && manualModel && <label className="local-model-custom">{t('Model ID')}<input autoFocus value={model} disabled={saving} placeholder={t('Leave empty to use agent default')} onChange={event => setModel(event.target.value)} /></label>}
        <p className="settings-note">{loading ? t('Loading models…') : t("Use the local agent’s model configuration.")} <button type="button" className="local-settings-link" disabled={saving || loading} onClick={() => setRevision(n => n + 1)}>{t('Refresh')}</button></p>
      </>}
      {<>
      <div className="custom-model-selection">
        <label className="field-row"><span>{t('Thinking level')}</span><select aria-label={t('Thinking level')} value={thinkingSupported ? thinking : 'default'} disabled={saving || loading || !thinkingSupported} onChange={event => setThinking(event.target.value as ThinkingLevel | 'default')}>
          <option value="default">{defaultThinkingLabel}</option>
          {thinkingLevels.map(level => <option key={level} value={level}>{t(THINKING_LEVEL_LABELS[level])}</option>)}
        </select></label>
      </div>
      <p className="local-model-thinking-note">{!thinkingSupported
        ? custom ? t("This model is not marked as supporting thinking. Enable it in Settings → Models.") : t("This local agent does not support a thinking level.")
        : t("Higher levels answer more carefully but slower and cost more.")}</p>
      </>}
      {!custom && !supported && <p className="local-model-note">{t('This tool does not support a per-conversation model override.')}</p>}
      {error && <p className="settings-error" role="alert">{t(error)}</p>}
      </div>
      <footer className="edit-contact-footer"><button type="button" className="secondary-button" onClick={onClose} disabled={saving}>{t('Cancel')}</button><button className="primary-button" disabled={saving || (!custom && !supported && Boolean(model)) || (custom && (loading || !validSelection))}>{t(saving ? 'Saving…' : embedded ? 'Save' : 'Done')}</button></footer>
    </form>
  </NativeDialog>
}
