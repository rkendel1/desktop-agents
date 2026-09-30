import type { SelectedMention } from '../../shared/bot/mentions'
import { applyProjection, type ProjectionDelta } from '../../shared/projection'
import { AgentSettingsDialog } from './components/AgentSettingsDialog'
import { reportDiagnostic } from './diagnostics'
import { ChatErrorBoundary } from './components/ChatErrorBoundary'
import { AgentPermissionPrompt } from './components/AgentPermissions'
import { DialogErrorBoundary } from './components/DialogErrorBoundary'
import { messageSendError, MessageQueue, type QueuedMessage } from './messageQueue'
import { X } from 'lucide-react'
import { resolveInterfaceLanguage, t, tr, usePreferences } from './preferences'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  AgentConfig,
  LocalAgent,
  AppSnapshot,
  Conversation,
  CreateAgentInput,
  CreateGroupInput,
  MessageImageInput,
  MessageFileInput,
  UpdateAgentInput
} from '../../shared/types'
import { SettingsPanel, type SettingsTab } from './components/SettingsPanel'
import { AppRail, type AppView } from './components/AppRail'
import { BotInbox } from './components/BotInbox'
import { MemberProfilePopover, type ProfileAnchor } from './components/MemberProfilePopover'
import { ContactCard, SelfProfileCard } from './components/ContactCard'
import { ContactList, type ContactSelection } from './components/ContactList'
import { ChatPane } from './components/ChatPane'
import { ProjectsView, type ProjectSelection } from './components/ProjectsView'
import { InspectorRail } from './components/InspectorRail'
import { AddMembersModal, BotModal, GroupModal } from './components/dialogs'
import { agentDisplayName, conversationMembers } from './components/common'
import { WelcomeDialog } from './components/WelcomeDialog'
import { CodeArtifactWindow } from './components/CodeArtifactWindow'
import { isImeCommitEnter } from './ime'

type Dialog =
  | { kind: 'agent-permissions'; agent: AgentConfig }
  | { kind: 'self-profile'; anchor: ProfileAnchor }
  | { kind: 'member-profile'; agentId: string; anchor: ProfileAnchor }
  | { kind: 'im-channels'; agent: AgentConfig }
  | { kind: 'local-model'; agent: AgentConfig }
  | { kind: 'bot'; agent?: AgentConfig; localAgentId?: string; creating?: boolean }
  | { kind: 'add-members' | 'remove-members'; conversation: Conversation }
  | { kind: 'group'; conversation?: Conversation; initialAgentIds?: string[] }
  | null

export function App(): ReactElement {
  const artifactId = new URLSearchParams(window.location.search).get('artifact')
  return artifactId ? <CodeArtifactWindow artifactId={artifactId} /> : <WorkspaceApp />
}

function WorkspaceApp(): ReactElement {
  const preferences = usePreferences()
  const imeComposing = useRef(false)
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([])
  const [messageQueue] = useState(() => new MessageQueue(setQueuedMessages))
  useEffect(() => { messageQueue.kick() }, [snapshot, messageQueue])
  const detachedId = new URLSearchParams(window.location.search).get('conversation')
  const [activeId, setActiveId] = useState(detachedId || '')
  const [view, setView] = useState<AppView>('chats')
  const [codingSelection, setCodingSelection] = useState<ProjectSelection>({})
  const [settingsOpen, updateSettingsOpen] = useState(false)
  function setSettingsOpen(open: boolean): void {
    reportDiagnostic(open ? 'settings.open-request' : 'settings.close')
    updateSettingsOpen(open)
  }
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('profile')
  const [welcomeDismissed, setWelcomeDismissed] = useState(false)
  const [contact, setContact] = useState<ContactSelection>()
  const [dialog, setDialog] = useState<Dialog>(null)
  const [showInspector, setShowInspector] = useState(false)
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey
        || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return
      // Do not move focus out of a modal into the inactive window behind it.
      if (document.querySelector('dialog[open], [aria-modal="true"]')) return
      const input = document.querySelector<HTMLInputElement>('input[data-app-search]')
      if (!input || input.disabled) return
      event.preventDefault()
      input.focus()
      input.select()
    }
    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [])
  const [inspectorAgentId, setInspectorAgentId] = useState<string>()
  const interfaceLanguage = resolveInterfaceLanguage(preferences.language)
  useEffect(() => {
    void window.douchat.setInterfaceLanguage(interfaceLanguage)
  }, [interfaceLanguage])
  useEffect(() => {
    if (!showInspector) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setShowInspector(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [showInspector])

  const [toast, setToast] = useState('')
  const [localAgents, setLocalAgents] = useState<LocalAgent[]>([])
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState('')
  const scanInFlight = useRef(false)
  async function scanAgents(): Promise<void> {
    if (scanInFlight.current) return
    scanInFlight.current = true
    let scanTimer: ReturnType<typeof setTimeout> | undefined
    setScanning(true)
    setScanError('')
    try { setLocalAgents(await Promise.race([
      window.douchat.detectLocalAgents(),
      new Promise<LocalAgent[]>((_, reject) => { scanTimer = setTimeout(() => reject(new Error('检测暂未完成，请稍后点击检测重试。')), 20000) })
    ])) }
    catch (error) { setScanError(messageSendError(error)) }
    finally { clearTimeout(scanTimer); scanInFlight.current = false; setScanning(false) }
  }
  useEffect(() => {
    void scanAgents()
  }, [])

  // The desktop is local: its state is read as soon as the window opens.
  // Nothing here waits on a network, an account or a configured provider.
  useEffect(() => {
    // One read of the current durable state, then only what changes. A change that
    // arrives before the read finishes is held and applied after it, and one the
    // read already contains is skipped, so a restarted window shows exactly the current state.
    let sequence = -1
    let ready = false
    const held: ProjectionDelta[] = []
    const apply = (delta: ProjectionDelta): void => {
      if (delta.sequence <= sequence) return
      sequence = delta.sequence
      setSnapshot((current) => current ? applyProjection(current, delta.changes) : current)
    }
    const stop = window.douchat.onProjection((delta) => { if (ready) apply(delta); else held.push(delta) })
    void window.douchat.getSnapshot().then((initial) => {
      sequence = initial.sequence
      setSnapshot(initial.snapshot)
      ready = true
      for (const delta of held.splice(0)) apply(delta)
    })
    return stop
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2600)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (snapshot && !snapshot.conversations.some((conversation) => conversation.id === activeId && (!conversation.hidden || detachedId))) {
      setActiveId(snapshot.conversations.find((item) => !item.hidden)?.id ?? '')
    }
  }, [snapshot, activeId])

  useEffect(() => {
    if (!snapshot || !contact || !['bot', 'group'].includes(contact.kind)) return
    const exists =
      contact.kind === 'bot'
        ? snapshot.agents.some((agent) => agent.id === contact.id)
        : snapshot.conversations.some((item) => item.id === contact.id)
    if (!exists) setContact(undefined)
  }, [snapshot, contact])

  const conversation = snapshot?.conversations.find((item) => item.id === activeId)
  const topic = conversation?.topics.find((item) => item.id === conversation.activeTopicId) ?? conversation?.topics[0]
  const members = useMemo(() => conversationMembers(conversation, snapshot?.agents ?? []), [conversation, snapshot?.agents])
  const activity = snapshot?.activity.find((item) => item.conversationId === activeId)
  const workingIds = useMemo(
    () => new Set((snapshot?.activity ?? []).map((item) => item.conversationId)),
    [snapshot?.activity]
  )
  const totalUnread = snapshot?.conversations.reduce((sum, item) => sum + (item.muted || item.hidden ? 0 : item.unread), 0) ?? 0
  const messages = useMemo(
    () =>
      snapshot?.messages.filter(
        (message) => message.conversationId === activeId && (!topic || message.topicId === topic.id)
      ) ?? [],
    [snapshot?.messages, activeId, topic?.id]
  )

  // An open, quiet chat is read: the badge never lingers on what you are looking at.
  useEffect(() => {
    if (view !== 'chats' || !conversation || conversation.unread === 0 || conversation.manuallyUnread || activity) return
    const read = (): void => {
      if (document.visibilityState === 'visible' && document.hasFocus()) void window.douchat.markConversationRead(conversation.id)
    }
    read()
    window.addEventListener('focus', read)
    document.addEventListener('visibilitychange', read)
    return () => {
      window.removeEventListener('focus', read)
      document.removeEventListener('visibilitychange', read)
    }
  }, [view, conversation?.id, conversation?.unread, conversation?.manuallyUnread, activity])

  useEffect(() => {
    if (!members.length) {
      setInspectorAgentId(undefined)
      return
    }
    if (!members.some((agent) => agent.id === inspectorAgentId)) setInspectorAgentId(members[0].id)
  }, [conversation?.id, members, inspectorAgentId])

  const fail = (error: unknown, fallback: string): void =>
    setToast(t(error instanceof Error ? error.message : fallback))

  async function send(text: string, images?: MessageImageInput[], files?: MessageFileInput[], mentions?: SelectedMention[]): Promise<void> {
    if (!conversation) return
    const target = conversation
    const targetTopic = topic?.id
    messageQueue.enqueue(target.id, text || (files?.length ? files.map(file => file.name).join('、') : `[${images?.length ?? 0} 张图片]`), async () => {
      const current = snapshotRef.current?.conversations.find((item) => item.id === target.id)
      if (!current) throw new Error('会话已不可用，请移除这条排队消息。')
      const currentTopic = current.activeTopicId ?? current.topics[0]?.id
      if (currentTopic !== targetTopic) throw new Error('话题已切换，请切回原话题后重试。')
      await window.douchat.sendMessage(target.id, text, images, files, mentions)
    }, () => !snapshotRef.current?.activity.some((item) => item.conversationId === target.id))
  }

  async function createAgent(input: CreateAgentInput): Promise<void> {
    const created = await window.douchat.createAgent(input)
    if (created.conversationId) setActiveId(created.conversationId)
    setContact({ kind: 'bot', id: created.agent.id })
    setView('chats')
    setShowInspector(false)
    setToast(tr('{name} joined the workspace', { name: input.name?.trim() || t('Agent') }))
    if (input.deferGreeting) setDialog({ kind: 'bot', agent: created.agent, creating: true })
  }

  async function updateAgent(agentId: string, input: UpdateAgentInput): Promise<void> {
    await window.douchat.updateAgent(agentId, input)
    setToast(tr('{name} updated', { name: input.name ?? t('Agent') }))
  }

  function deleteAgent(agent: AgentConfig): void {
    if (!window.confirm(tr('Delete {name}? Their chat and group memberships are removed.', { name: agentDisplayName(agent) }))) return
    void window.douchat
      .deleteAgent(agent.id)
      .then(() => {
        setDialog(null)
        setToast(tr('{name} was removed', { name: agentDisplayName(agent) }))
      })
      .catch((error) => fail(error, 'Agent could not be deleted'))
  }

  async function createGroup(input: CreateGroupInput): Promise<void> {
    const created = await window.douchat.createGroup(input)
    setActiveId(created.conversationId)
    setToast(tr('{name} is ready', { name: input.name }))
  }

  async function startDirectChat(agentId: string): Promise<void> {
    const result = await window.douchat.startDirectChat(agentId)
    setActiveId(result.conversationId)
    setContact({ kind: 'bot', id: agentId })
    setView('chats')
    setShowInspector(false)
  }

  async function updateGroup(
    conversationId: string,
    input: { name: string; description: string; agentIds: string[]; leadAgentId: string }
  ): Promise<void> {
    await window.douchat.updateConversation(conversationId, input)
    setToast(t('Group updated'))
  }

  function deleteConversation(target: Conversation): void {
    /* Native confirmation is handled by the main process. */
    void window.douchat
      .deleteConversation(target.id)
      .catch((error) => fail(error, 'Chat could not be deleted'))
  }

  async function openChat(conversationId: string): Promise<void> {
    try {
      await window.douchat.updateConversation(conversationId, { hidden: false })
      await window.douchat.markConversationRead(conversationId)
      setActiveId(conversationId)
      setShowInspector(false)
      setView('chats')
    } catch (error) {
      fail(error, 'Chat could not be opened')
      throw error
    }
  }

  function togglePin(target: Conversation): void {
    void window.douchat.setConversationPinned(target.id, !target.pinned).catch((error) => fail(error, 'Chat could not be pinned'))
  }

  function editConversation(target: Conversation): void {
    if (target.type === 'group') setDialog({ kind: 'group', conversation: target })
    else {
      const agent = snapshot?.agents.find((item) => item.id === target.agentIds[0])
      if (agent) setDialog({ kind: 'bot', agent })
    }
  }

  if (!snapshot) {
    return (
      <div className="loading-screen">
        <span className="brand-mark"><i /><i /></span>
        <span>{t('Opening Foundry…')}</span>
      </div>
    )
  }

  const uiSnapshot = snapshot
  // A request from a coding session that is open on screen is answered in that session, with its project in view;
  // any other request interrupts with a prompt that says which session and project it belongs to.
  const codingOfRequest = (requestId: string) => {
    const activity = uiSnapshot.codingActivity?.find(item => item.approval?.id === requestId)
    const session = activity && uiSnapshot.codingSessions?.find(item => item.id === activity.sessionId)
    return activity && session ? { activity, session, project: uiSnapshot.projects?.find(item => item.id === session.projectId) } : undefined
  }
  const promptRequest = uiSnapshot.permissionRequests?.find(request => !(view === 'projects' && codingOfRequest(request.id)?.session.id === codingSelection.sessionId))
  const promptCoding = promptRequest ? codingOfRequest(promptRequest.id) : undefined
  const showWelcome = !welcomeDismissed && !snapshot.desktop?.onboardingCompleted && snapshot.agents.length === 0

  return (
    <div
      className={`app-shell messenger with-rail ${detachedId ? 'detached-chat' : ''} ${view === 'chats' && showInspector ? 'with-inspector' : ''}`}
      onCompositionStartCapture={() => { imeComposing.current = true }}
      onCompositionEndCapture={() => { imeComposing.current = false }}
      onKeyDownCapture={(event) => {
        if (!isImeCommitEnter(event.nativeEvent, imeComposing.current)) return
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <AppRail
        view={view}
        unread={totalUnread}
        codingAttention={(snapshot.codingActivity ?? []).filter(item => item.state === 'awaiting-approval').length}
        userName={snapshot.userName}
        userAvatar={snapshot.userAvatar}
        settingsOpen={settingsOpen}
        onSelect={(next) => {
          setSettingsOpen(false)
          setView(next)
        }}
        onOpenSettings={(profile) => {
          if (profile) setSettingsTab('profile')
          setSettingsOpen(true)
        }}
      />

      {view === 'projects' ? (
        <ProjectsView snapshot={uiSnapshot} selection={codingSelection} onSelect={setCodingSelection} />
      ) : view === 'contacts' ? (
        <>
          <ContactList
            snapshot={uiSnapshot}
            selected={contact}
            onSelect={setContact}
          />
          <ContactCard
            snapshot={uiSnapshot}
            selection={contact}
            onMessage={openChat}
            onStartDirect={(agentId) => { void startDirectChat(agentId) }}
            onEditBot={(agent) => setDialog({ kind: 'bot', agent })} onConfigureModel={(agent) => setDialog({ kind: 'local-model', agent })} onConfigureIM={(agent) => setDialog({ kind: 'im-channels', agent })}
              onEditPermissions={(agent) => setDialog({ kind: 'agent-permissions', agent })}
            onRemoveFromContacts={(group) => { void window.douchat.updateConversation(group.id, { savedToContacts: false }).catch((error) => fail(error, 'Could not save changes')) }} onDeleteConversation={deleteConversation} onDeleteBot={deleteAgent}
            onTogglePin={togglePin}
          />
        </>
      ) : (
        <>
      <BotInbox
        snapshot={uiSnapshot}
        activeId={activeId}
        workingIds={workingIds}
        onSelect={openChat}
        onCreateBot={() => setDialog({ kind: 'bot' })}
        onCreateGroup={() => setDialog({ kind: 'group' })}
        onUpdate={(target, input) => {
          void window.douchat.updateConversation(target.id, input).catch((error) => fail(error, 'Chat could not be updated'))
        }}
        onMarkAllRead={async () => {
          try { await window.douchat.markAllConversationsRead() }
          catch (error) { fail(error, 'Could not mark chats as read') }
        }}
        onOpenWindow={(target) => { void window.douchat.openConversationWindow(target.id).catch((error) => fail(error, 'Window could not be opened')) }}
        onEdit={editConversation}
        onTogglePin={togglePin}
        onDelete={deleteConversation}
      />

      <div className="chat-stage">
      <ChatErrorBoundary key={`${activeId}:${topic?.id}`}>
      <ChatPane
        key={`${activeId}:${topic?.id}`}
        userName={snapshot.userName}
        userAvatar={snapshot.userAvatar}
        conversation={conversation}
        topic={topic}
        messages={messages}
        allMessages={snapshot.messages}
        agents={[...snapshot.agents, ...members]}
        members={members}
        activity={activity}
        offline={snapshot.runtime.mode === 'offline' && !members.some((agent) => agent.localAgentId)}
        onConnect={() => {
          const agent = members.find((member) => member.id === conversation?.leadAgentId) ?? members[0]
          if (agent) setDialog({ kind: 'local-model', agent })
          else { setSettingsTab('models'); setSettingsOpen(true) }
        }}
        inspectorOpen={showInspector}
        onToggleInspector={() => setShowInspector((value) => !value)}
        onOpenAgentProfile={(agentId, anchor) => {
          setInspectorAgentId(agentId)
          setDialog({ kind: 'member-profile', agentId, anchor })
        }}
        onOpenUserProfile={(anchor) => setDialog({ kind: 'self-profile', anchor })}
        queuedMessages={queuedMessages.filter((item) => item.conversationId === conversation?.id)}
        onPromoteQueued={(id) => messageQueue.promote(id)}
        onRemoveQueued={(id) => messageQueue.remove(id)}
        onSend={send}
        onStop={() => conversation && void window.douchat.stopConversation(conversation.id)}
      />

      <div className={`chat-details-layer ${showInspector && conversation ? 'is-open' : ''}`} inert={!showInspector || !conversation} aria-hidden={!showInspector || !conversation}>
        <button className="chat-details-dismiss" onClick={() => setShowInspector(false)} aria-label={t('Close chat details')} tabIndex={-1} />
        <InspectorRail
          snapshot={{ ...uiSnapshot, agents: [...uiSnapshot.agents, ...members] }}
          conversation={conversation}
          members={members}
          selectedAgentId={inspectorAgentId}
          onSelectAgent={(agentId, anchor) => { setInspectorAgentId(agentId); setDialog({ kind: 'member-profile', agentId, anchor }) }}
          onSelectUser={(anchor) => setDialog({ kind: 'self-profile', anchor })}
          onRemoveMembers={() => conversation && setDialog({ kind: 'remove-members', conversation })}
          onAddMembers={() => conversation && (conversation.type === 'group' ? setDialog({ kind: 'add-members', conversation }) : setDialog({ kind: 'group', initialAgentIds: conversation.agentIds }))}
          onDeleteRoutine={(routineId) => window.douchat.deleteRoutine(routineId)}
          onSetRoutineEnabled={(routineId, enabled) => window.douchat.setRoutineEnabled(routineId, enabled)}
          onRunRoutineNow={(routineId) => window.douchat.runRoutineNow(routineId)}
        />
      </div>
      </ChatErrorBoundary>
      </div>
        </>
      )}

      <DialogErrorBoundary key={`${dialog?.kind ?? 'none'}:${settingsOpen}`} onClose={() => { setDialog(null); setSettingsOpen(false) }}>
      {dialog?.kind === 'self-profile' && <MemberProfilePopover anchor={dialog.anchor} onClose={() => setDialog(null)}>
        <button autoFocus className="icon-button member-profile-close" aria-label={t('Close')} onClick={() => setDialog(null)}><X size={18} /></button>
        <SelfProfileCard name={snapshot.userName} avatar={snapshot.userAvatar} onEdit={() => { setDialog(null); setSettingsTab('profile'); setSettingsOpen(true) }} />
      </MemberProfilePopover>}
      {dialog?.kind === 'member-profile' && (
        <MemberProfilePopover anchor={dialog.anchor} onClose={() => setDialog(null)}>
            <button autoFocus className="icon-button member-profile-close" aria-label={t('Close')} onClick={() => setDialog(null)}><X size={18} /></button>
            <ContactCard snapshot={{ ...uiSnapshot, agents: [...uiSnapshot.agents, ...members.filter((member) => !uiSnapshot.agents.some((agent) => agent.id === member.id))] }} readOnly={!uiSnapshot.agents.some((agent) => agent.id === dialog.agentId)} selection={{ kind: 'bot', id: dialog.agentId }}
              onMessage={(id) => { setDialog(null); void openChat(id).catch(() => undefined) }}
              onStartDirect={(agentId) => { setDialog(null); void startDirectChat(agentId) }}
              onEditBot={(agent) => setDialog({ kind: 'bot', agent })} onConfigureModel={(agent) => setDialog({ kind: 'local-model', agent })} onConfigureIM={(agent) => setDialog({ kind: 'im-channels', agent })}
              onEditPermissions={(agent) => setDialog({ kind: 'agent-permissions', agent })}
              onRemoveFromContacts={(group) => { void window.douchat.updateConversation(group.id, { savedToContacts: false }).catch((error) => fail(error, 'Could not save changes')) }} onDeleteConversation={deleteConversation} onDeleteBot={deleteAgent}
              onTogglePin={togglePin} />
        </MemberProfilePopover>
      )}
      {promptRequest && <AgentPermissionPrompt key={promptRequest.id} request={promptRequest} agent={uiSnapshot.agents.find(agent => agent.id === promptRequest.agentId)}
        coding={promptCoding && { projectName: promptCoding.project?.name ?? promptCoding.session.projectId, path: promptCoding.session.workingDirectory, task: promptCoding.session.task,
          onCancelSession: () => { void window.douchat.cancelCodingSession(promptCoding.session.id) } }}
        onResolve={async (allow) => { await window.douchat.resolveAgentPermission(promptRequest.id, allow) }} />}
      {dialog && ((dialog.kind === 'bot' && dialog.agent) || dialog.kind === 'agent-permissions' || dialog.kind === 'im-channels' || dialog.kind === 'local-model') && <AgentSettingsDialog
        key={dialog.agent!.id} agent={uiSnapshot.agents.find(agent => agent.id === dialog.agent!.id) ?? dialog.agent!}
        localAgents={localAgents}
        creating={dialog.kind === 'bot' && dialog.creating}
        initialTab={dialog.kind === 'agent-permissions' ? 'permissions' : dialog.kind === 'im-channels' ? 'channels' : dialog.kind === 'local-model' ? 'models' : 'profile'}
        onClose={() => { if (dialog.kind === 'bot' && dialog.creating) void window.douchat.finishAgentSetup(dialog.agent!.id); setDialog(null) }} onUpdate={updateAgent} onDelete={deleteAgent}
        onModelSettings={() => { if (dialog.kind === 'bot' && dialog.creating) void window.douchat.finishAgentSetup(dialog.agent!.id); setDialog(null); setSettingsTab('models'); setSettingsOpen(true) }} />}
      {dialog?.kind === 'bot' && !dialog.agent && <BotModal localAgents={localAgents}
        continueToSettings
        initialLocalAgentId={dialog.localAgentId}
        onModelSettings={() => { setDialog(null); setSettingsTab('models'); setSettingsOpen(true) }}
        onSettings={() => { setDialog(null); setSettingsOpen(true) }}
        onClose={() => setDialog(null)} onCreate={createAgent} onUpdate={updateAgent} />}
      {(dialog?.kind === 'add-members' || dialog?.kind === 'remove-members') && (
        <AddMembersModal
          remove={dialog.kind === 'remove-members'} snapshot={uiSnapshot} conversation={dialog.conversation} onClose={() => setDialog(null)} onUpdate={updateGroup} />
      )}
      {dialog?.kind === 'group' && (
        <GroupModal
          snapshot={uiSnapshot}
          conversation={dialog.conversation}
          initialAgentIds={dialog.initialAgentIds}
          onClose={() => setDialog(null)}
          onCreate={createGroup}
          onStartDirect={startDirectChat}
          onOpenConversation={openChat}
          onUpdate={updateGroup}
          onNewBot={() => setDialog({ kind: 'bot' })}
        />
      )}
      {settingsOpen && (
        <SettingsPanel
          user={{ name: snapshot.userName, image: snapshot.userAvatar }}
          agents={localAgents}
          routines={snapshot.routines}
          runs={snapshot.runs}
          workspaceAgents={snapshot.agents}
          conversations={snapshot.conversations}
          scanning={scanning}
          error={scanError}
          tab={settingsTab}
          onTab={setSettingsTab}
          onClose={() => setSettingsOpen(false)}
          onUpdateProfile={async (input) => { await window.douchat.updateProfile(input) }}
          onDetect={() => void scanAgents()}
          onLocalAgentsChange={setLocalAgents}
          onRemoveCustom={async (id) => setLocalAgents(await window.douchat.removeCustomLocalAgent(id))}
          onDeleteRoutine={(id) => window.douchat.deleteRoutine(id)}
          onSetRoutineEnabled={(id, enabled) => window.douchat.setRoutineEnabled(id, enabled)}
          onRunRoutineNow={(id) => window.douchat.runRoutineNow(id)}
        />
      )}
      {showWelcome && !dialog && !settingsOpen && <WelcomeDialog
        localAgents={localAgents}
        scanning={scanning}
        onDismiss={() => { setWelcomeDismissed(true); void window.douchat.completeOnboarding().catch(() => undefined) }}
        onCreateAgent={(localAgentId) => { setWelcomeDismissed(true); setDialog({ kind: 'bot', localAgentId }) }}
      />}
      </DialogErrorBoundary>
      {toast && <ToastNotice message={toast} />}
    </div>
  )
}

function ToastNotice({ message }: { message: string }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || typeof element.showPopover !== 'function') return
    try {
      if (!element.matches(':popover-open')) element.showPopover()
    } catch {
      element.removeAttribute('popover')
    }
  }, [message])
  return <div ref={ref} className="toast" popover="manual" role="status">{message}</div>
}
