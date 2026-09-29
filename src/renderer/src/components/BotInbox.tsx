import { ContactKindBadge } from './ContactKindBadge'
import { t, tr } from '../preferences'
import {
  BellOff,
  Bot,
  Check,
  CheckCheck,
  ChevronRight,
  ListFilter,
  LoaderCircle,
  Mail,
  UserRound,
  Users,
  UserPlus,
  MessageSquare,
  Pin,
  CirclePlus,
  Search,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { AppSnapshot, ChatMessage, Conversation } from '../../../shared/types'
import { latestAssistantPreview } from '../../../shared/bot/preview'
import { compareConversationActivity, compareConversationOrganization } from '../../../shared/bot/order'
import { UserAvatar, ConversationAvatar, SidebarResizer, conversationDisplayName, formatTime, relativeTime } from './common'

interface ContextMenuState {
  id: string
  x: number
  y: number
}

const chatFilters = [
  { id: 'all', label: 'All chats', icon: MessageSquare, empty: 'No chats yet' },
  { id: 'unread', label: 'Unread', icon: Mail, empty: 'No unread chats' },
  { id: 'direct', label: 'Direct chats', icon: UserRound, empty: 'No direct chats' },
  { id: 'group', label: 'Group chats', icon: Users, empty: 'No group chats' }
] as const
type ChatFilter = typeof chatFilters[number]['id']

export function BotInbox({
  snapshot,
  activeId,
  workingIds,
  onSelect,
  onCreateBot,
  onCreateGroup,
  onEdit,
  onTogglePin,
  onDelete,
  onUpdate,
  onMarkAllRead,
  onOpenWindow
}: {
  snapshot: AppSnapshot
  activeId: string
  workingIds: Set<string>
  onSelect: (conversationId: string) => void
  onCreateBot: () => void
  onCreateGroup: () => void
  onEdit: (conversation: Conversation) => void
  onTogglePin: (conversation: Conversation) => void
  onDelete: (conversation: Conversation) => void
  onUpdate: (conversation: Conversation, input: import('../../../shared/types').UpdateConversationInput) => void
  onMarkAllRead: () => Promise<void>
  onOpenWindow: (conversation: Conversation) => void
}): ReactElement {
  const [query, setQuery] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [filter, setFilter] = useState<ChatFilter>('all')
  const [filterOpen, setFilterOpen] = useState(false)
  const [markingRead, setMarkingRead] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [now, setNow] = useState(Date.now)
  const contextRef = useRef<HTMLDivElement>(null)
  const createRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLDivElement>(null)
  const filterButtonRef = useRef<HTMLButtonElement>(null)
  const createButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (filterOpen) filterRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
  }, [filterOpen])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!createOpen && !contextMenu && !filterOpen) return
    const close = (event: MouseEvent): void => {
      const target = event.target as Node
      if (createOpen && !createRef.current?.contains(target)) setCreateOpen(false)
      if (filterOpen && !filterRef.current?.contains(target)) setFilterOpen(false)
      if (!contextRef.current?.contains(target)) setContextMenu(null)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setFilterOpen(false)
      if (filterOpen) {
        filterButtonRef.current?.focus()
      } else {
        setCreateOpen(false)
        setContextMenu(null)
        if (createOpen) createButtonRef.current?.focus()
      }
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', escape)
    }
  }, [createOpen, contextMenu, filterOpen])

  const messagesByConversation = useMemo(() => {
    const map = new Map<string, ChatMessage[]>()
    for (const message of snapshot.messages) {
      const list = map.get(message.conversationId)
      if (list) list.push(message)
      else map.set(message.conversationId, [message])
    }
    return map
  }, [snapshot.messages])

  const lastMessageAt = (conversation: { id?: string; createdAt: number }): number => {
    const messages = conversation.id ? messagesByConversation.get(conversation.id) : undefined
    return messages?.length ? messages[messages.length - 1].createdAt : conversation.createdAt
  }

  const ordered = useMemo(
    () =>
      [...snapshot.conversations].sort(
        (left, right) =>
          compareConversationActivity(
            left,
            right,
            workingIds.has(left.id),
            workingIds.has(right.id),
            (conversation) => lastMessageAt(conversation as Conversation)
          ) || compareConversationOrganization(left, right)
      ),
    [snapshot.conversations, workingIds, messagesByConversation]
  )

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return ordered.filter((conversation) => {
      if (conversation.hidden && !needle) return false
      if (filter === 'unread' && !conversation.manuallyUnread && conversation.unread <= 0) return false
      if ((filter === 'direct' || filter === 'group') && conversation.type !== filter) return false
      const displayName = conversationDisplayName(conversation, snapshot.agents)
      return !needle || `${conversation.name} ${displayName}`.toLowerCase().includes(needle)
    })
  }, [ordered, query, filter, snapshot.agents, document.documentElement.lang])

  const selectedFilter = chatFilters.find((item) => item.id === filter)!
  const hasUnread = snapshot.conversations.some((conversation) => conversation.manuallyUnread || conversation.unread > 0)
  const closeFilter = (): void => {
    setFilterOpen(false)
    setCreateOpen(false)
    createButtonRef.current?.focus()
  }

  const pinned = filtered.filter((conversation) => conversation.pinned)
  const rest = filtered.filter((conversation) => !conversation.pinned)
  const menuTarget = snapshot.conversations.find((conversation) => conversation.id === contextMenu?.id)

  const row = (conversation: Conversation): ReactElement => {
    const displayName = conversationDisplayName(conversation, snapshot.agents)
    const messages = messagesByConversation.get(conversation.id) ?? []
    const working = workingIds.has(conversation.id)
    const preview = latestAssistantPreview(
      messages.map((message) => ({
        authorId: message.authorId,
        authorName: message.authorName,
        text: message.kind === 'handoff' ? `${t('Handoff')} · ${message.text}` : message.text,
        createdAt: message.createdAt,
        error: message.error
      }))
    )
    const last = messages[messages.length - 1]
    const previewText = last?.attachments?.length && !last.text ? t('Image') : last?.authorId === 'user'
        ? tr('You: {message}', { message: last.text })
        : preview
          ? conversation.type === 'group'
            ? `${preview.authorName}: ${preview.text}`
            : preview.text
          : t('Start a conversation')

    return (
      <button
        key={conversation.id}
        className={`conversation-item ${conversation.id === activeId ? 'active' : ''} ${working ? 'working' : ''}`}
        onClick={() => onSelect(conversation.id)}
        onContextMenu={(event) => {
          event.preventDefault()
          setFilterOpen(false)
          setCreateOpen(false)
          setContextMenu({
            id: conversation.id,
            x: Math.min(event.clientX, window.innerWidth - 180),
            y: Math.min(event.clientY, window.innerHeight - 310)
          })
        }}
      >
        <span className="conversation-avatar">
          <ConversationAvatar conversation={conversation} agents={snapshot.agents} userName={snapshot.userName} userAvatar={snapshot.userAvatar} size={36} />
          {!working && conversation.unread > 0 && <span className={`unread-badge ${conversation.muted ? 'muted' : ''}`}>{conversation.unread > 99 ? '99+' : conversation.unread}</span>}
          {working && <span className="conversation-loading" role="status" aria-label={t('Working…')}><LoaderCircle size={13} /></span>}
        </span>
        <span className="conversation-copy">
          <span className="conversation-line">
            <strong>
              {displayName || 'New chat'}
              <ContactKindBadge local={conversation.type === 'direct' && Boolean(snapshot.agents.find((agent) => agent.id === conversation.agentIds[0])?.localAgentId)} />
              {conversation.pinned && <Pin size={11} className="pin-mark" />}
            </strong>
            <time>{new Date(lastMessageAt(conversation)).toDateString() === new Date(now).toDateString() ? formatTime(lastMessageAt(conversation)) : relativeTime(lastMessageAt(conversation), now)}</time>
          </span>
          <span className="conversation-preview">{previewText}{conversation.muted && <BellOff size={13} className="mute-mark" />}</span>
        </span>
      </button>
    )
  }

  return (
    <aside className="sidebar messenger-inbox">
      <SidebarResizer />
      <div className="sidebar-titlebar window-drag">
        <div className="search-box no-drag">
          <Search size={15} />
          <input data-app-search aria-keyshortcuts="Meta+F Control+F" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('Search')} aria-label={t('Search')} />
          {query && (
            <button onClick={() => setQuery('')} aria-label={t('Clear search')}>
              <X size={13} />
            </button>
          )}
        </div>
        <div className="sidebar-titlebar-actions no-drag">
          <div className="menu-anchor" ref={createRef}>
            <button ref={createButtonRef} className="sidebar-add" onClick={() => { setCreateOpen((open) => !open); setFilterOpen(false); setContextMenu(null) }} aria-label={t('New chat')} aria-haspopup="menu" aria-expanded={createOpen}>
              <CirclePlus size={21} strokeWidth={1.7} />
            </button>
            {createOpen && (
              <div className="dropdown-menu inbox-create-menu" role="menu" onKeyDown={(event) => {
                if ((event.target as HTMLElement).closest('.inbox-filter-menu')) return
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > button, :scope > .inbox-filter-anchor > button')]
                const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
                  : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
                buttons[next]?.focus()
              }}>
                <button role="menuitem" onClick={() => { setCreateOpen(false); onCreateGroup() }}>
                  <MessageSquare size={14} /><span>{t('Start chat')}</span>
                </button>
                <button role="menuitem" onClick={() => { setCreateOpen(false); onCreateBot() }}>
                  <Bot size={14} /><span>{t('Create agent')}</span>
                </button>
                <div className="dropdown-separator" role="separator" />
                <div className="inbox-filter-anchor" ref={filterRef}
                  onMouseEnter={() => setFilterOpen(true)} onMouseLeave={() => setFilterOpen(false)} onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFilterOpen(false)
                }}>
                  <button ref={filterButtonRef} role="menuitem" className={`inbox-filter-trigger ${filter !== 'all' ? 'active' : ''}`}
                    aria-label={tr('Filter chats: {filter}', { filter: t(selectedFilter.label) })}
                    title={t(selectedFilter.label)} aria-haspopup="menu" aria-expanded={filterOpen}
                    onClick={() => setFilterOpen(true)}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowRight') return
                      event.preventDefault()
                      setFilterOpen(true)
                    }}>
                    <ListFilter size={14} /><span>{t('Filter chats')}</span><ChevronRight size={14} className="submenu-arrow" />
                  </button>
                  {filterOpen && (
                    <div className="dropdown-menu inbox-filter-menu" role="menu" aria-label={t('Filter chats')}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowLeft') {
                          event.preventDefault()
                          event.stopPropagation()
                          setFilterOpen(false)
                          filterButtonRef.current?.focus()
                          return
                        }
                        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
                        event.preventDefault()
                        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
                        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
                        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
                          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
                        buttons[next]?.focus()
                      }}>
                      {chatFilters.map(({ id, label, icon: Icon }) => (
                        <button key={id} role="menuitemradio" aria-checked={filter === id}
                          onClick={() => { setFilter(id); closeFilter() }}>
                          <Icon size={17} /><span>{t(label)}</span>
                          {filter === id && <Check size={16} className="menu-check" />}
                        </button>
                      ))}
                      <div className="dropdown-separator" role="separator" />
                      <button role="menuitem" disabled={!hasUnread || markingRead} onClick={async () => {
                        setMarkingRead(true)
                        closeFilter()
                        try { await onMarkAllRead() } finally { setMarkingRead(false) }
                      }}>
                        <CheckCheck size={17} /><span>{t('Mark all as read')}</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>


      <nav className="conversation-list" aria-label={t('Chats')}>
        {pinned.map(row)}
        {rest.map(row)}
        {!filtered.length && (
          <p className="empty-search">
            {query.trim() ? tr('No chats match “{query}”.', { query: query.trim() }) : t(selectedFilter.empty)}
          </p>
        )}
      </nav>


      {contextMenu && menuTarget && (
        <div ref={contextRef} className="context-menu" style={{ left: Math.max(4, contextMenu.x), top: Math.max(4, contextMenu.y) }} role="menu">
          <button role="menuitem" onClick={() => { setContextMenu(null); onTogglePin(menuTarget) }}>{menuTarget.pinned ? t('Unpin') : t('Pin to top')}</button>
          <button role="menuitem" onClick={() => { setContextMenu(null); onUpdate(menuTarget, { manuallyUnread: !menuTarget.unread }) }}>{menuTarget.unread ? t('Mark as read') : t('Mark as unread')}</button>
          <button role="menuitem" onClick={() => { setContextMenu(null); onUpdate(menuTarget, { muted: !menuTarget.muted }) }}>{menuTarget.muted ? t('Unmute notifications') : t('Mute notifications')}</button>
          <div className="dropdown-separator" />
          <button role="menuitem" onClick={() => { setContextMenu(null); onOpenWindow(menuTarget) }}>{t('Open in separate window')}</button>
          <button role="menuitem" onClick={() => { setContextMenu(null); onUpdate(menuTarget, { hidden: true }) }}>{t('Hide chat')}</button>
          <button role="menuitem" onClick={() => { setContextMenu(null); onEdit(menuTarget) }}>{t('Edit')}</button>
          <div className="dropdown-separator" />
          <button role="menuitem" className="danger" onClick={() => { setContextMenu(null); onDelete(menuTarget) }}>{t('Delete')}</button>
        </div>
      )}
    </aside>
  )
}
