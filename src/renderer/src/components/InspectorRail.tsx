import { NativeDialog } from './NativeDialog'
import { ContactKindBadge } from './ContactKindBadge'
import { ConversationWorkspaceSetting } from './ConversationWorkspaceSetting'
import type { ProfileAnchor } from './MemberProfilePopover'
import { t } from '../preferences'
import { CalendarClock, ChevronRight, Minus, Pause, Pencil, Play, Plus, Search, Trash2, X } from 'lucide-react'
import { useEffect, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { AgentConfig, AppSnapshot, ChatMessage, Conversation, Routine, RoutineSchedule, TaskRun } from '../../../shared/types'
import { AgentAvatar, UserAvatar, agentDisplayName, agentDisplayRole } from './common'

export function InspectorRail({
  snapshot,
  searchMessages,
  conversation,
  members,
  selectedAgentId,
  onSelectAgent,
  onSelectUser,
  onAddMembers,
  onRemoveMembers,
  onDeleteRoutine,
  onSetRoutineEnabled,
  onRunRoutineNow
}: {
  searchMessages?: (query: string) => Promise<ChatMessage[]>
  snapshot: Pick<AppSnapshot, 'groupMemberHealth' | 'messages' | 'agents' | 'userName' | 'userAvatar' | 'agentStatuses' | 'routines' | 'runs'>
  conversation?: Conversation
  members: AgentConfig[]
  selectedAgentId?: string
  onSelectAgent: (agentId: string, anchor: ProfileAnchor) => void
  onSelectUser: (anchor: ProfileAnchor) => void
  onAddMembers: () => void
  onRemoveMembers: () => void
  onDeleteRoutine?: (routineId: string) => Promise<void>
  onSetRoutineEnabled?: (routineId: string, enabled: boolean) => Promise<void>
  onRunRoutineNow?: (routineId: string) => Promise<void>
}): ReactElement {
  const [memberQuery, setMemberQuery] = useState('')
  const [recordsDialog, setRecordsDialog] = useState<'history' | 'routines' | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(conversation?.name ?? '')
  useEffect(() => {
    setMemberQuery(''); setRecordsDialog(null); setQuery(''); setResults([]); setConfirmClear(false); setConfirmReset(false); setError('')
    setEditingName(false); setNameDraft(conversation?.name ?? '')
  }, [conversation?.id])
  useEffect(() => { if (!editingName) setNameDraft(conversation?.name ?? '') }, [conversation?.name, editingName])
  useEffect(() => {
    let cancelled = false
    if (recordsDialog !== 'history' || !conversation) return
    if (!query.trim()) {
      setResults(snapshot.messages
        .filter((message) => message.conversationId === conversation.id && message.kind === 'message')
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, 100))
      return
    }
    setResults([])
    const timer = setTimeout(() => {
      void (searchMessages ? searchMessages(query) : window.douchat.searchMessages(conversation.id, query)).then((messages) => {
        if (!cancelled) setResults(messages.filter((message) => message.kind === 'message'))
      }).catch(() => { if (!cancelled) setError(t('Could not load messages')) })
    }, 200)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [recordsDialog, query, conversation?.id, snapshot.messages])
  async function update(action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true); setError('')
    try { await action(); setConfirmClear(false); setConfirmReset(false); return true }
    catch { setError(t('Could not save changes')); return false }
    finally { setBusy(false) }
  }
  async function saveGroupName(): Promise<void> {
    if (!conversation || conversation.type !== 'group') return
    const name = nameDraft.trim()
    if (!name || name === conversation.name) {
      setNameDraft(conversation.name)
      setEditingName(false)
      return
    }
    if (await update(() => window.douchat.updateConversation(conversation.id, { name }))) setEditingName(false)
  }
  function highlight(value: string): ReactElement {
    const needle = memberQuery.trim().toLocaleLowerCase()
    const index = value.toLocaleLowerCase().indexOf(needle)
    return index < 0 || !needle ? <>{value}</> : <>{value.slice(0, index)}<mark>{value.slice(index, index + needle.length)}</mark>{value.slice(index + needle.length)}</>
  }
  const orderedMembers = members
  const agent = members.find((item) => item.id === selectedAgentId) ?? members[0] ?? snapshot.agents[0]
  const currentUserName = snapshot.userName || t('You')
  const unavailable = (id: string) => !!conversation && snapshot.groupMemberHealth?.[conversation.id]?.[id]?.status === 'unavailable'
  const availabilityDot = (id: string) => unavailable(id)
    ? <span className="member-unavailable" role="img" aria-label={t('Temporarily unavailable')} title={`${t('Temporarily unavailable')} · ${t('Excluded from group tasks until a successful health check')}`} />
    : null
  const normalizedMemberQuery = memberQuery.trim().toLocaleLowerCase()
  const matchingMembers = orderedMembers.filter((member) => `${member.name} ${agentDisplayName(member)}`.toLocaleLowerCase().includes(normalizedMemberQuery))
  const currentUserMatches = currentUserName.toLocaleLowerCase().includes(normalizedMemberQuery)
  return <>
    <aside className="inspector-rail" aria-label={t('Chat details')}>
      <div className="inspector-scroll">
        {conversation && (
          <section className="member-section">
            {conversation.type === 'group' && <label className="group-member-search"><Search size={16} /><input aria-label={t('Search group members')} placeholder={t('Search group members')} value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} />{memberQuery && <button type="button" aria-label={t('Clear search')} onClick={() => setMemberQuery('')}><X size={14} /></button>}</label>}
            {conversation.type === 'group' && memberQuery.trim() ? <div className="group-member-results">
              {matchingMembers.map((member) => <button key={member.id} className={member.id === agent?.id ? 'active' : ''} aria-pressed={member.id === agent?.id} onClick={(event) => onSelectAgent(member.id, (event.currentTarget.querySelector('.agent-avatar') ?? event.currentTarget).getBoundingClientRect())}><div className="member-avatar-wrap"><AgentAvatar agent={member} size={40} />{availabilityDot(member.id)}</div><span><strong>{highlight(agentDisplayName(member))}</strong></span></button>)}
              {currentUserMatches && <button type="button" onClick={(event) => onSelectUser(event.currentTarget.getBoundingClientRect())} aria-label={`${currentUserName} · ${t('You')}`}><UserAvatar src={snapshot.userAvatar} name={currentUserName} size={40} /><span><strong>{highlight(currentUserName)}</strong></span></button>}
              {!matchingMembers.length && !currentUserMatches && <p>{t('No matching agents')}</p>}
            </div> : <div className="member-grid">
              {orderedMembers.map((member) => (
                <button
                  key={member.id}
                  style={{ order: members.indexOf(member) + 1 }}
                  className={`member-tile ${member.id === agent?.id ? 'active' : ''}`}
                  onClick={(event) => onSelectAgent(member.id, (event.currentTarget.querySelector('.agent-avatar') ?? event.currentTarget).getBoundingClientRect())}
                  title={`${agentDisplayName(member)} · ${agentDisplayRole(member)}`}
                >
                  <div className="member-avatar-wrap"><AgentAvatar agent={member} size={40} /><ContactKindBadge local={Boolean(member.localAgentId)} />{availabilityDot(member.id)}</div>
                  <span className="member-name-label"><span className="member-name-text">{agentDisplayName(member)}</span></span>
                  <span className={`member-state ${snapshot.agentStatuses[member.id] ?? 'idle'}`} />
                </button>
              ))}
              {conversation.type === 'group' && <button type="button" className="member-tile" style={{ order: 0 }} onClick={(event) => onSelectUser(event.currentTarget.getBoundingClientRect())} aria-label={`${currentUserName} · ${t('You')}`} title={`${currentUserName} · ${t('You')}`}>
                <div className="member-avatar-wrap"><UserAvatar src={snapshot.userAvatar} name={currentUserName} size={40} /><ContactKindBadge human /></div>
                <span className="member-name-label"><span className="member-name-text">{currentUserName}</span></span>
              </button>}
              {<button className="member-tile add" style={{ order: 10000 }} onClick={onAddMembers} aria-label={t('Add a member')}>
                <span className="member-add">
                  <Plus size={26} strokeWidth={1.5} />
                </span>
                <span>{t('Add')}</span>
              </button>}
              {conversation.type === 'group' && <button className="member-tile add" style={{ order: 10000 }} onClick={onRemoveMembers} aria-label={t('Remove group members')}><span className="member-add"><Minus size={26} strokeWidth={1.5} /></span><span>{t('Remove')}</span></button>}
            </div>}
            {conversation.type === 'group' && !memberQuery.trim() && <div className="group-conversation-details">
              <section className="group-name-setting">
                <h2>{t('Group chat name')}</h2>
                {editingName ? <input
                  autoFocus
                  aria-label={t('Group chat name')}
                  disabled={busy}
                  value={nameDraft}
                  onChange={(event) => setNameDraft(event.target.value)}
                  onFocus={(event) => event.currentTarget.select()}
                  onBlur={() => { if (!busy) void saveGroupName() }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.preventDefault(); void saveGroupName() }
                    if (event.key === 'Escape') { event.preventDefault(); setNameDraft(conversation.name); setEditingName(false) }
                  }}
                /> : <button type="button" className="group-name-value" disabled={busy} aria-label={`${t('Edit group chat name')}: ${conversation.name}`} onClick={() => setEditingName(true)}>
                  <span>{conversation.name}</span><Pencil size={15} />
                </button>}
              </section>
              <ConversationWorkspaceSetting conversation={conversation} />
              <div className="detail-toggles">
                <label>{t('Save to contacts')}<button type="button" className="detail-switch" role="switch" aria-label={t('Save to contacts')} aria-checked={!!conversation.savedToContacts} disabled={busy} onClick={() => void update(() => window.douchat.updateConversation(conversation.id, { savedToContacts: !conversation.savedToContacts }))} /></label>
                <label>{t('Mute notifications')}<button type="button" className="detail-switch" role="switch" aria-label={t('Mute notifications')} aria-checked={!!conversation.muted} disabled={busy} onClick={() => void update(() => window.douchat.updateConversation(conversation.id, { muted: !conversation.muted }))} /></label>
                <label>{t('Pin to top')}<button type="button" className="detail-switch" role="switch" aria-label={t('Pin to top')} aria-checked={!!conversation.pinned} disabled={busy} onClick={() => void update(() => window.douchat.setConversationPinned(conversation.id, !conversation.pinned))} /></label>
              </div>
            </div>}
            {conversation.type === 'direct' ? <div className="direct-chat-options">
              <ConversationWorkspaceSetting conversation={conversation} />
              <button className="detail-search-button" onClick={() => { setError(''); setQuery(''); setRecordsDialog('history') }}>{t('Search chat history')} <ChevronRight size={16} /></button>
              <button className="detail-search-button" onClick={() => { setError(''); setRecordsDialog('routines') }}>{t('View scheduled tasks')} <ChevronRight size={16} /></button>
              <div className="detail-toggles">
                <label>{t('Mute notifications')}<button type="button" className="detail-switch" role="switch" aria-label={t('Mute notifications')} aria-checked={!!conversation.muted} disabled={busy} onClick={() => void update(() => window.douchat.updateConversation(conversation.id, { muted: !conversation.muted }))} /></label>
                <label>{t('Pin to top')}<button type="button" className="detail-switch" role="switch" aria-label={t('Pin to top')} aria-checked={!!conversation.pinned} disabled={busy} onClick={() => void update(() => window.douchat.setConversationPinned(conversation.id, !conversation.pinned))} /></label>
              </div>
            </div> : null}
            {!memberQuery.trim() && <div className="detail-history-actions">
              <div className="detail-history-action">
                {confirmClear ? <div className="detail-clear-confirm"><p>{t('Clear all messages in this chat? This cannot be undone.')}</p><button disabled={busy} onClick={() => setConfirmClear(false)}>{t('Cancel')}</button><button className="danger" disabled={busy} onClick={() => void update(() => window.douchat.clearConversation(conversation.id))}>{t('Clear chat history')}</button></div> : <button className="detail-clear" disabled={busy} onClick={() => { setConfirmClear(true); setConfirmReset(false) }}>{t('Clear chat history')}</button>}
              </div>
              <div className="detail-history-action">
                {confirmReset ? <div className="detail-clear-confirm"><p>{t('Reset context? The current reply will stop and future replies will start fresh. Chat history will be kept.')}</p><button disabled={busy} onClick={() => setConfirmReset(false)}>{t('Cancel')}</button><button className="danger" disabled={busy} onClick={() => void update(() => window.douchat.resetConversationContext(conversation.id))}>{t('Reset context')}</button></div>
                  : <button className="detail-clear" disabled={busy} onClick={() => { setConfirmReset(true); setConfirmClear(false) }}>{t('Reset context')}</button>}
              </div>
            </div>}
            {error && <p role="alert">{t(error)}</p>}

          </section>
        )}

      </div>
    </aside>
    {conversation && recordsDialog === 'history' && createPortal(<ChatHistoryDialog
      conversation={conversation}
      messages={results}
      agents={snapshot.agents}
      userName={snapshot.userName}
      userAvatar={snapshot.userAvatar}
      query={query}
      error={error}
      onQuery={setQuery}
      onClose={() => setRecordsDialog(null)}
    />, document.body)}
    {conversation && recordsDialog === 'routines' && createPortal(<ConversationRoutinesDialog
      conversation={conversation}
      routines={(snapshot.routines ?? []).filter((routine) => routine.conversationId === conversation.id)}
      runs={snapshot.runs ?? []}
      agents={snapshot.agents}
      onDelete={onDeleteRoutine}
      onSetEnabled={onSetRoutineEnabled}
      onRunNow={onRunRoutineNow}
      onClose={() => setRecordsDialog(null)}
    />, document.body)}
  </>
}

function ChatHistoryDialog({ conversation, messages, agents, userName, userAvatar, query, error, onQuery, onClose }: {
  conversation: Conversation
  messages: ChatMessage[]
  agents: AgentConfig[]
  userName: string
  userAvatar: string
  query: string
  error: string
  onQuery: (query: string) => void
  onClose: () => void
}): ReactElement {
  return <NativeDialog className="modal-backdrop conversation-records-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()} onClose={onClose} width={640} height={720}>
    <section className="conversation-records-modal chat-history-modal" role="dialog" aria-modal="true" aria-labelledby="chat-history-title">
      <header className="records-header">
        <div className="records-title-spacer" />
        <div><h1 id="chat-history-title">{t('Chat history with {name}').replace('{name}', conversation.name)} <span>({messages.length})</span></h1></div>
        <button type="button" aria-label={t('Close')} title={t('Close')} onClick={onClose}><X size={18} /></button>
      </header>
      <label className="records-search"><Search size={18} /><input autoFocus value={query} onChange={(event) => onQuery(event.target.value)} placeholder={t('Search')} aria-label={t('Search chat history')} /></label>
      {error && <p className="records-error" role="alert">{t(error)}</p>}
      <div className="records-list" aria-live="polite">
        {!messages.length && <div className="records-empty"><Search size={28} /><strong>{query.trim() ? t('No matching messages') : t('No chat history yet')}</strong><p>{query.trim() ? t('Try another keyword.') : t('Messages from this conversation will appear here.')}</p></div>}
        {messages.map((message) => {
          const agent = agents.find((item) => item.id === message.authorId)
          return <article className="history-record" key={message.id}>
            {agent
              ? <AgentAvatar agent={agent} size={34} />
              : <UserAvatar src={message.authorId === 'user' ? userAvatar : ''} name={message.authorId === 'user' ? userName : message.authorName} size={34} />}
            <div><header><strong>{message.authorName}</strong><time>{new Date(message.createdAt).toLocaleString()}</time></header><p>{message.text}</p></div>
          </article>
        })}
        {messages.length === 100 && <p className="records-limit">{t('Showing latest 100 matches')}</p>}
      </div>
    </section>
  </NativeDialog>
}

function routineScheduleLabel(schedule: RoutineSchedule): string {
  if (schedule.kind === 'once') {
    return `${t('Once')} · ${new Date(schedule.runAt).toLocaleString()}`
  }
  if (schedule.kind === 'interval') {
    const minutes = Math.max(1, Math.round(schedule.intervalMinutes))
    if (minutes % 1440 === 0) return t('Every {count} days').replace('{count}', String(minutes / 1440))
    if (minutes % 60 === 0) return t('Every {count} hours').replace('{count}', String(minutes / 60))
    return t('Every {count} minutes').replace('{count}', String(minutes))
  }
  const days = [t('Sun'), t('Mon'), t('Tue'), t('Wed'), t('Thu'), t('Fri'), t('Sat')]
  return `${[...new Set(schedule.days)].sort().map((day) => days[day]).join(' · ')} · ${schedule.time}`
}

function routineStatus(routine: Routine, lastRun?: TaskRun): string {
  if (lastRun?.status === 'running') return t('Running')
  if (routine.enabled && lastRun?.status === 'failed') return t('Retrying')
  if (routine.enabled) return t('Active')
  if (lastRun?.status === 'failed') return t('Failed')
  if (routine.schedule.kind === 'once' && lastRun?.status === 'succeeded') return t('Completed')
  return t('Paused')
}

function ConversationRoutinesDialog({ conversation, routines, runs, agents, onDelete, onSetEnabled, onRunNow, onClose }: {
  conversation: Conversation
  routines: Routine[]
  runs: TaskRun[]
  agents: AgentConfig[]
  onDelete?: (routineId: string) => Promise<void>
  onSetEnabled?: (routineId: string, enabled: boolean) => Promise<void>
  onRunNow?: (routineId: string) => Promise<void>
  onClose: () => void
}): ReactElement {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const perform = async (key: string, action: () => Promise<void>): Promise<void> => {
    setBusy(key); setError('')
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy('') }
  }
  const remove = async (routine: Routine): Promise<void> => {
    if (!onDelete || !window.confirm(t('Delete this automation?'))) return
    await perform(`delete:${routine.id}`, () => onDelete(routine.id))
  }
  const keyword = query.trim().toLocaleLowerCase()
  const filtered = routines.filter((routine) => {
    const agent = agents.find((item) => item.id === routine.agentId)
    return !keyword || [routine.name, routine.prompt, agent ? agentDisplayName(agent) : '', routineScheduleLabel(routine.schedule)].join(' ').toLocaleLowerCase().includes(keyword)
  })
  const ordered = [...filtered].sort((left, right) => Number(right.enabled) - Number(left.enabled) || left.nextRunAt - right.nextRunAt)
  return <NativeDialog className="modal-backdrop conversation-records-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()} onClose={onClose} width={640} height={720}>
    <section className="conversation-records-modal routine-records-modal scheduled-tasks-modal" role="dialog" aria-modal="true" aria-labelledby="routine-records-title">
      <header className="records-header">
        <div className="records-title-spacer" />
        <div><h1 id="routine-records-title">{t('Scheduled tasks for {name}').replace('{name}', conversation.name)} <span>({routines.length})</span></h1></div>
        <button type="button" aria-label={t('Close')} title={t('Close')} onClick={onClose}><X size={18} /></button>
      </header>
      <label className="records-search"><Search size={18} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('Search')} aria-label={t('Search')} /></label>
      {error && <p className="records-error" role="alert">{t(error)}</p>}
      <div className="records-list routine-records-list">
        {!ordered.length && <div className="records-empty"><CalendarClock size={30} /><strong>{t(keyword ? 'No matching tasks' : 'No scheduled tasks in this chat')}</strong><p>{t(keyword ? 'Try another keyword.' : 'Ask this contact to remind you later or run something on a schedule.')}</p></div>}
        {ordered.map((routine) => {
          const agent = agents.find((item) => item.id === routine.agentId)
          const lastRun = runs.filter((run) => run.routineId === routine.id).sort((left, right) => right.createdAt - left.createdAt)[0]
          const expiredOnce = routine.schedule.kind === 'once' && routine.schedule.runAt <= Date.now()
          return <article className="routine-record" key={routine.id}>
            <div className="routine-record-copy">
              <header><strong>{routine.name}</strong><span data-status={lastRun?.status ?? (routine.enabled ? 'active' : 'paused')}>{routineStatus(routine, lastRun)}</span></header>
              <p>{routine.prompt}</p>
              <div><span className="routine-contact">{agent && <AgentAvatar agent={agent} size={20} />}{agent ? agentDisplayName(agent) : t('Unknown agent')}</span><span>{routineScheduleLabel(routine.schedule)}</span>{routine.enabled && <span>{t('Next run: {time}').replace('{time}', new Date(routine.nextRunAt).toLocaleString())}</span>}</div>
            </div>
            <div className="routine-record-actions">
              <button type="button" disabled={!onRunNow || Boolean(busy)} aria-label={t('Run now')} title={t('Run now')} onClick={() => onRunNow && void perform(`run:${routine.id}`, () => onRunNow(routine.id))}><Play size={16} /></button>
              <button type="button" disabled={!onSetEnabled || Boolean(busy) || (!routine.enabled && expiredOnce)} aria-label={routine.enabled ? t('Pause') : t('Resume')} title={routine.enabled ? t('Pause') : t('Resume')} onClick={() => onSetEnabled && void perform(`enabled:${routine.id}`, () => onSetEnabled(routine.id, !routine.enabled))}>{routine.enabled ? <Pause size={16} /> : <Play size={16} />}</button>
              <button type="button" className="danger" disabled={!onDelete || Boolean(busy)} aria-label={t('Delete')} title={t('Delete')} onClick={() => void remove(routine)}><Trash2 size={16} /></button>
            </div>
          </article>
        })}
      </div>
    </section>
  </NativeDialog>
}
