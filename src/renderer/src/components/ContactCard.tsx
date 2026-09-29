import type { CustomModelConfig } from '../../../shared/customModels'
import { t } from '../preferences'
import { Pencil, MessageSquare, Star, Users } from 'lucide-react'
import { useEffect, useState, type ReactElement } from 'react'
import type { AgentConfig, AppSnapshot, Conversation } from '../../../shared/types'
import type { ContactSelection } from './ContactList'
import { AgentAvatar, UserAvatar, ConversationAvatar, agentDisplayName, agentSourceLabel } from './common'

function Field({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="contact-field">
      <span>{label}</span>
      <p>{value}</p>
    </div>
  )
}

export function ContactCard({
  readOnly = false,
  snapshot,
  selection,
  onMessage,
  onStartDirect,
  onEditBot,
  onDeleteConversation,
  onRemoveFromContacts,
  onTogglePin
}: {
  readOnly?: boolean
  snapshot: AppSnapshot
  selection?: ContactSelection
  onMessage: (conversationId: string) => void
  onStartDirect: (agentId: string) => void
  onConfigureIM?: (agent: AgentConfig) => void
  onConfigureModel?: (agent: AgentConfig) => void
  onEditPermissions?: (agent: AgentConfig) => void
  onEditBot: (agent: AgentConfig) => void
  onRemoveFromContacts?: (conversation: Conversation) => void
  onDeleteConversation?: (conversation: Conversation) => void
  onDeleteBot: (agent: AgentConfig) => void
  onTogglePin: (conversation: Conversation) => void
}): ReactElement {
  const [customModels, setCustomModels] = useState<CustomModelConfig>()
  const [localModelLabel, setLocalModelLabel] = useState<{ agentId: string; model: string; name: string }>()
  const agent = selection?.kind === 'bot' ? snapshot.agents.find((item) => item.id === selection.id) : undefined
  const group =
    selection?.kind === 'group' ? snapshot.conversations.find((item) => item.id === selection.id) : undefined

  useEffect(() => {
    const provider = agent?.provider ?? ''
    if (!provider.startsWith('custom:')) { setCustomModels(undefined); return }
    let active = true
    window.douchat.getCustomModels().then(config => { if (active) setCustomModels(config) }).catch(() => { if (active) setCustomModels(undefined) })
    return () => { active = false }
  }, [agent?.provider])

  useEffect(() => {
    setLocalModelLabel(undefined)
    if (readOnly || !agent?.localAgentId || !agent.model || agent.model === 'default') return
    const { id, model } = agent
    let active = true
    window.douchat.listLocalAgentModels(id).then(list => {
      const selected = list.models.find(item => item.id === model)
      if (active && selected) setLocalModelLabel({ agentId: id, model, name: selected.name })
    }).catch(() => { /* Keep the saved model ID when discovery is unavailable. */ })
    return () => { active = false }
  }, [agent?.id, agent?.localAgentId, agent?.model, readOnly])

  if (!agent && !group) {
    return (
      <main className="workspace contact-empty">
        <div className="contact-empty-copy">
          <Users size={30} />
          <p>{t('Pick an agent or a group to see its profile.')}</p>
        </div>
      </main>
    )
  }

  if (agent) {
    const displayName = agentDisplayName(agent)
    const categoryLabel = t('Agents')
    const sourceLabel = agentSourceLabel(agent)
    const modelId = agent.model && agent.model !== 'default' ? agent.model : undefined
    const configuredProvider = agent.provider.startsWith('custom:') ? customModels?.providers.find(provider => `custom:${provider.id}` === agent.provider) : undefined
    const builtInModel = (snapshot.models ?? []).find(option => option.model === modelId)
    const localName = localModelLabel?.agentId === agent.id && localModelLabel.model === agent.model ? localModelLabel.name : undefined
    const resolvedModelLabel = agent.localAgentId
      ? localName || modelId || t('Use agent default')
      : configuredProvider?.modelLabels?.[agent.model] || builtInModel?.label || modelId || t('No model selected')
    const modelLabel = agent.followDefaultModel ? `${t('Follow default model')} · ${resolvedModelLabel}` : resolvedModelLabel
    const direct = snapshot.conversations.find(
      (conversation) => conversation.type === 'direct' && !conversation.id.startsWith('im-') && conversation.agentIds[0] === agent.id
    )
    const sharedGroupCount = snapshot.conversations.filter(
      (conversation) => conversation.type === 'group' && conversation.agentIds.includes(agent.id)
    ).length
    return (
      <main className="workspace contact-card-pane contact-profile-pane">
        <div className="contact-profile-scroll">
          <div className="contact-profile-sheet">
            <section className="contact-profile-header">
              <AgentAvatar agent={agent} size={64} />
              <div className="contact-profile-identity">
                <div className="contact-profile-name"><h1>{displayName}</h1>
                  {direct && <button className={`profile-star ${direct.pinned ? 'is-starred' : ''}`} onClick={() => onTogglePin(direct)} aria-label={t(direct.pinned ? 'Unpin' : 'Pin to top')} title={t(direct.pinned ? 'Unpin' : 'Pin to top')}><Star size={16} fill={direct.pinned ? 'currentColor' : 'none'} /></button>}
                </div>
                <p>{categoryLabel}</p>
              </div>

            </section>

            <section className="contact-profile-section">
              <h2>{t('Agent details')}</h2>
              <Field label={t('Name')} value={displayName} />
              <Field label={t('Run mode')} value={sourceLabel} />
              <Field label={t('Model')} value={modelLabel} />
              {agent.labels?.trim() && <Field label={t('Labels')} value={agent.labels} />}
            </section>

            <section className="contact-profile-section">
              <h2>{t('More information')}</h2>
              <Field label={t('Shared groups')} value={String(sharedGroupCount)} />
              {agent.createdAt > 0 && <Field label={t('Added on')} value={new Date(agent.createdAt).toLocaleDateString(document.documentElement.lang, { year: 'numeric', month: '2-digit', day: '2-digit' })} />}
            </section>

            <div className="contact-profile-actions">
              {readOnly
                ? <p className="contact-profile-message-hint">{t('This agent belongs to another member. Direct messaging is not available.')}</p>
                : <button onClick={() => direct ? onMessage(direct.id) : onStartDirect(agent.id)}><MessageSquare size={24} strokeWidth={1.7} /><span>{t('Send message')}</span></button>}
              {!readOnly && <button onClick={() => onEditBot(agent)}><Pencil size={24} strokeWidth={1.7} /><span>{t('Edit agent')}</span></button>}
            </div>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="workspace contact-card-pane group-profile-pane">
      <div className="group-profile-layout">
        <section className="group-profile-main" aria-labelledby="group-profile-name">
          <ConversationAvatar conversation={group!} agents={snapshot.agents} userName={snapshot.userName} userAvatar={snapshot.userAvatar} size={88} />
          <h1 id="group-profile-name">{group!.name}</h1>
          <button className="group-profile-primary" onClick={() => onMessage(group!.id)}>
            <MessageSquare size={17} />
            {t('Open the group chat')}
          </button>
        </section>
      </div>
      {onRemoveFromContacts && <button className="group-remove-contact" onClick={() => onRemoveFromContacts(group!)}>{t('Remove from contacts')}</button>}
    </main>
  )
}

export function SelfProfileCard({ name, avatar, onEdit }: { name: string; avatar: string; onEdit: () => void }): ReactElement {
  return <main className="workspace contact-card-pane contact-profile-pane">
    <div className="contact-profile-scroll"><div className="contact-profile-sheet">
      <section className="contact-profile-header"><UserAvatar name={name} src={avatar} size={64} /><div className="contact-profile-identity"><div className="contact-profile-name"><h1>{name}</h1></div><p>{t('Myself')}</p></div></section>
      <section className="contact-profile-section"><h2>{t('Contact details')}</h2><Field label={t('Name')} value={name} /></section>
      <div className="contact-profile-actions"><button onClick={onEdit}><Pencil size={24} strokeWidth={1.7} /><span>{t('Edit profile')}</span></button></div>
    </div></div>
  </main>
}
