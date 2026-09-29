import { useContext, useEffect, useRef, useState, type ReactElement } from 'react'
import { X } from 'lucide-react'
import type { AgentConfig } from '../../../shared/types'
import { CustomModelSelection } from './CustomModelSelection'
import { configurableLocalAgents, localModelId, type LocalModelList } from '../../../shared/localModels'
import type { CustomModelConfig } from '../../../shared/customModels'
import { DEFAULT_CLOUD_THINKING_LEVEL, THINKING_LEVELS, THINKING_LEVEL_LABELS, localThinkingLevels, type ThinkingLevel } from '../../../shared/thinkingLevels'
import { t, tr } from '../preferences'
import { EmbeddedAgentSettings, AgentDialogSurface as NativeDialog } from './AgentDialogSurface'
import { localAgentDisplayName } from './common'

export function LocalModelDialog({ agent, onModelSettings, onClose, onSave }: {
  agent: AgentConfig; onModelSettings?: () => void; onClose: () => void; onSave: (model: string, provider: string | undefined, thinkingLevel: ThinkingLevel | 'default') => Promise<void>
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
  const custom = !agent.localAgentId
  const [customModels, setCustomModels] = useState<CustomModelConfig>()
  const [customProviderId, setCustomProviderId] = useState(agent.followDefaultModel ? '@default' : agent.provider?.startsWith('custom:') ? agent.provider.slice('custom:'.length) : '@default')
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
    window.douchat.listLocalAgentModels(agent.id).then(result => { if (active) setList(result) })
      .catch(() => { if (active) setError(t('Could not load models. Retry or enter a model ID.')) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [agent.id, revision, custom])
  const supported = configurableLocalAgents.includes(agent.localAgentId || '')
  const selectedProvider = customModels?.providers.find(provider => provider.id === customProviderId)
  const validSelection = customProviderId === '@default' ? Boolean(customModels?.defaultModel) : selectedProvider?.models.includes(model)
  const localModels = list?.models ?? []
  const reasoningProvider = customProviderId === '@default' ? customModels?.providers.find(provider => customModels.defaultModel.startsWith(provider.id + '/')) : selectedProvider
  const reasoningModel = customProviderId === '@default' ? customModels?.defaultModel.slice((reasoningProvider?.id.length ?? 0) + 1) : model
  const thinkingLevels: readonly ThinkingLevel[] = !custom ? localThinkingLevels(agent.localAgentId)
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
        await (custom ? onSave(selected, `custom:${customProviderId}`, level) : onSave(selected, undefined, level))
        if (alive.current) onClose()
      } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : t('Could not save changes')) }
      finally { if (alive.current) setSaving(false) }
    }}>
      <header className="edit-contact-heading"><h2 id="local-model-title">{t('Configure model')}</h2>
        <button type="button" className="icon-button" aria-label={t('Close')} disabled={saving} onClick={onClose}><X size={20} /></button></header>
      <div className="permission-body local-model-body">
      <p className="permission-agent-name">{agent.name}</p>
      {custom ? <>
        <CustomModelSelection config={customModels ?? { providers: [], defaultModel: '' }} providerId={customProviderId} model={model} disabled={saving || loading} onChange={(providerId, value) => { setCustomProviderId(providerId); setModel(value) }} />
        {loading && <p role="status">{t("Loading model settings…")}</p>}
        <p className="settings-note">{t("Use your own API key. Your model provider handles billing.")} <button type="button" className="local-settings-link" disabled={saving} onClick={onModelSettings}>{t("Configure model")}</button></p>
      </> : <>
        <div className="custom-model-selection">
          <label className="field-row"><span>{t('Local agent')}</span><select aria-label={t('Local agent')} value={agent.localAgentId} disabled><option value={agent.localAgentId}>{agent.localAgentName || localAgentDisplayName(agent.localAgentId!)}</option></select></label>
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
