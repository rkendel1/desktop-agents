import { AgentArchivePanel } from './AgentArchivePanel'
import { UserMemoryPanel } from './UserMemoryPanel'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Cpu, IdCard, Puzzle, Radio, Settings2, ShieldCheck, WandSparkles, X } from 'lucide-react'
import type { AgentConfig, LocalAgent, ModelOption, UpdateAgentInput } from '../../../shared/types'
import { t, resolveInterfaceLanguage, usePreferences } from '../preferences'
import { EmbeddedAgentSettings } from './AgentDialogSurface'
import { BotModal } from './dialogs'
import { LocalModelDialog } from './LocalModelDialog'
import { AgentPermissionsDialog } from './AgentPermissions'
import { IMChannelsDialog } from './IMChannelsDialog'
import { AgentFilesPanel, AgentSkillsPanel } from './AgentCustomization'
import './AgentSettingsDialog.css'

export type AgentSettingsTab = 'memory' | 'profile' | 'customize' | 'models' | 'skills' | 'permissions' | 'channels' | 'advanced'
export function AgentSettingsDialog({ agent, localAgents, initialTab = 'profile', onClose, onUpdate, onDelete, onModelSettings }: {
  agent: AgentConfig; localAgents: LocalAgent[]; initialTab?: AgentSettingsTab
  onClose: () => void; onUpdate: (id: string, input: UpdateAgentInput) => Promise<void>; onDelete: (agent: AgentConfig) => void
  onModelSettings: () => void
}) {
  const preferences = usePreferences()
  const tr = (en: string, zh: string) => resolveInterfaceLanguage(preferences.language) === 'zh-CN' ? zh : en
  const [tab, setTab] = useState(initialTab)
  const [visited, setVisited] = useState<AgentSettingsTab[]>([initialTab])
  const [dirty, setDirty] = useState<Set<AgentSettingsTab>>(new Set())
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<AgentSettingsTab>()
  const dialog = useRef<HTMLDialogElement>(null)
  const busy = useRef(false)
  const tabs = [
    { id: 'profile', label: tr('Profile', '资料'), icon: IdCard },
    { id: 'customize', label: tr('Customize', '自定义'), icon: WandSparkles },
    { id: 'models', label: tr('Models', '模型'), icon: Cpu },
    { id: 'skills', label: tr('Skills', '技能'), icon: Puzzle },
    { id: 'permissions', label: tr('Permissions', '权限'), icon: ShieldCheck },
    { id: 'channels', label: tr('Channels', '渠道'), icon: Radio },
    { id: 'advanced', label: tr('Advanced', '高级'), icon: Settings2 }
  ] as const
  useEffect(() => {
    const element = dialog.current!
    const focused = document.activeElement as HTMLElement | null
    element.showModal()
    return () => { element.close(); focused?.focus() }
  }, [])
  const leave = (action: () => void) => {
    if (busy.current) return
    if (dirty.size && !window.confirm(tr('Discard unsaved changes?', '放弃尚未保存的修改？'))) return
    action()
  }
  const markDirty = (section: AgentSettingsTab) => { setDirty(current => new Set(current).add(section)); setSaved(undefined) }
  const save = async (section: AgentSettingsTab, input: UpdateAgentInput) => {
    if (busy.current) throw new Error(tr('A save is already in progress.', '正在保存，请稍候。'))
    busy.current = true; setSaving(true); setSaved(undefined)
    try {
      await onUpdate(agent.id, input)
      setDirty(current => { const next = new Set(current); next.delete(section); return next })
      setSaved(section)
    } finally { busy.current = false; setSaving(false) }
  }
  const noClose = () => {}
  return createPortal(<dialog ref={dialog} className="agent-settings-dialog messenger" aria-label={t('Edit agent')} onCancel={event => { event.preventDefault(); leave(onClose) }} onClick={event => { if (event.target === event.currentTarget) leave(onClose) }}>
    <div className="settings-modal agent-settings-layout">
      <aside className="settings-sidebar"><div className="settings-modal-title"><div className="wordmark">{t('Edit agent')}</div></div>
        <nav className="settings-tabs" aria-label={t('Edit agent')}>{tabs.map(item => <button key={item.id} className={tab === item.id ? 'active' : ''} title={item.label} aria-label={item.label} aria-current={tab === item.id ? 'page' : undefined} onClick={() => { setTab(item.id); setVisited(current => current.includes(item.id) ? current : [...current, item.id]) }}><item.icon size={18} /><span>{item.label}</span>{dirty.has(item.id) && <span className="agent-settings-dirty" aria-label={tr('Unsaved changes', '未保存')} />}</button>)}</nav>
      </aside>
      <div className="settings-content agent-settings-content">
        <button className="settings-close agent-settings-close" aria-label={t('Close')} disabled={saving} onClick={() => leave(onClose)}><X size={18} /></button>
        {saved === tab && <p className="agent-settings-saved" role="status">{tr('Saved', '已保存')}</p>}
        <EmbeddedAgentSettings.Provider value={true}>
          {visited.map(section => <fieldset disabled={saving} hidden={tab !== section} key={section} className="agent-settings-panel" onChangeCapture={() => { if (['profile', 'models', 'permissions'].includes(section)) markDirty(section) }}>
            {!['customize', 'skills', 'memory'].includes(section) && <header className="settings-heading agent-settings-heading"><div><h1>{tabs.find(item => item.id === section)!.label}</h1></div></header>}
            {section === 'profile' && <div onClickCapture={event => { if ((event.target as HTMLElement).closest('.edit-contact-avatar-field button')) markDirty('profile') }}><BotModal agent={agent} localAgents={localAgents} onSettings={() => leave(onModelSettings)} onClose={noClose} onCreate={async () => {}} onUpdate={(_id, input) => save('profile', input)} /></div>}
            {section === 'advanced' && <><AgentArchivePanel agent={agent} onBusyChange={value => { busy.current = value; setSaving(value) }} onImport={async input => {
              await save('advanced', input)
              setVisited(current => current.filter(section => section !== 'customize' && section !== 'skills'))
              setDirty(current => { const next = new Set(current); next.delete('customize'); next.delete('skills'); return next })
            }} /><div className="agent-settings-delete">
              <div><h2>{t('Delete agent')}</h2><p>{tr('Remove this agent from your contacts.', '将此智能体从联系人中删除。')}</p></div>
              <button className="secondary-button danger" onClick={() => leave(() => onDelete(agent))}>{t('Delete agent')}</button>
            </div></>}
            {section === 'customize' && <AgentFilesPanel agent={agent} onSave={input => save('customize', input)} onDirty={() => markDirty('customize')} />}
            {section === 'memory' && <UserMemoryPanel agentId={agent.id} onDirty={() => markDirty('memory')} onSaved={() => setDirty(current => { const next = new Set(current); next.delete('memory'); return next })} onBusyChange={value => { busy.current = value; setSaving(value) }} />}
            {section === 'models' && <LocalModelDialog agent={agent} onClose={noClose} onModelSettings={() => leave(onModelSettings)} onSave={(model, provider, thinkingLevel) => save('models', { ...(provider?.startsWith('custom:') ? { customModel: { providerId: provider.slice(7), model } } : { model }), thinkingLevel })} />}
            {section === 'skills' && <AgentSkillsPanel agent={agent} onSave={input => save('skills', input)} onDirty={() => markDirty('skills')} />}
            {section === 'permissions' && <AgentPermissionsDialog agent={agent} onClose={noClose} onSave={permissions => save('permissions', { permissions })} />}
            {section === 'channels' && <IMChannelsDialog agent={agent} onClose={noClose} />}
          </fieldset>)}
        </EmbeddedAgentSettings.Provider>
      </div>
    </div>
  </dialog>, document.body)
}
