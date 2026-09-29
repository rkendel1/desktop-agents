import { t, tr } from '../preferences'
import { Settings, UsersRound, MessageCircle, FolderGit2, X, Minus, Maximize2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { UpdateStatus } from '../../../shared/types'
import { UserAvatar } from './common'

export type AppView = 'chats' | 'contacts' | 'projects'

export function AppRail({
  view,
  unread,
  friendRequests = 0,
  codingAttention = 0,
  userName,
  userAvatar,
  settingsOpen,
  onSelect,
  onOpenSettings
}: {
  view: AppView
  unread: number
  friendRequests?: number
  /** Coding sessions waiting for the owner's approval. */
  codingAttention?: number
  userName: string
  userAvatar: string
  settingsOpen: boolean
  onSelect: (view: AppView) => void
  onOpenSettings: (profile?: boolean) => void
}): ReactElement {
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle')
  useEffect(() => {
    let active = true
    void window.douchat.getUpdateState().then((state) => { if (active) setUpdateStatus(state.status) }).catch(() => {})
    const unsubscribe = window.douchat.onUpdateState((state) => { if (active) setUpdateStatus(state.status) })
    return () => { active = false; unsubscribe() }
  }, [])
  const updateReady = ['available', 'downloading', 'downloaded'].includes(updateStatus)
  return (
    <nav className="app-rail window-drag" aria-label={t('Sections')}>
      {window.douchat.platform === 'darwin' && <div className="window-controls no-drag" role="group" aria-label={t('Window controls')}>
        <button className="window-control close" title={t('Close window')} aria-label={t('Close window')} onClick={() => window.douchat.windowAction('close')}><X size={8} strokeWidth={2} /></button>
        <button className="window-control minimize" title={t('Minimize window')} aria-label={t('Minimize window')} onClick={() => window.douchat.windowAction('minimize')}><Minus size={8} strokeWidth={2} /></button>
        <button className="window-control fullscreen" title={t('Toggle full screen')} aria-label={t('Toggle full screen')} onClick={() => window.douchat.windowAction('fullscreen')}><Maximize2 size={7} strokeWidth={2} /></button>
      </div>}
      <button className="rail-profile no-drag" onClick={() => onOpenSettings(true)} title={userName} aria-label={tr('{name} — open your profile', { name: userName })}>
        <UserAvatar src={userAvatar} name={userName} size={34} />
      </button>
      <button
        className={`rail-button no-drag ${view === 'chats' ? 'active' : ''}`}
        onClick={() => onSelect('chats')}
        aria-label={t('Chats')}
        aria-current={view === 'chats'}
        title={t('Chats')}
      >
        <MessageCircle size={23} strokeWidth={1.8} />
        {unread > 0 && <span className="rail-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      <button
        className={`rail-button no-drag ${view === 'contacts' ? 'active' : ''}`}
        onClick={() => onSelect('contacts')}
        aria-label={t('Contacts')}
        aria-current={view === 'contacts'}
        title={t('Contacts')}
      >
        <UsersRound size={23} strokeWidth={1.8} />
        {friendRequests > 0 && <span className="rail-badge" aria-label={tr('{count} pending friend requests', { count: friendRequests })}>{friendRequests > 99 ? '99+' : friendRequests}</span>}
      </button>
      <button
        className={`rail-button no-drag ${view === 'projects' ? 'active' : ''}`}
        onClick={() => onSelect('projects')}
        aria-label={t('Projects')}
        aria-current={view === 'projects'}
        title={t('Projects')}
      >
        <FolderGit2 size={23} strokeWidth={1.8} />
        {codingAttention > 0 && <span className="rail-badge" aria-label={tr('{count} coding sessions need attention', { count: codingAttention })}>{codingAttention}</span>}
      </button>
      <div className="rail-spacer" />
      <button className={`rail-button no-drag ${settingsOpen ? 'active' : ''}`} onClick={() => onOpenSettings()} aria-label={t('Settings')} title={updateReady ? t('Update available') : t('Settings')} aria-current={settingsOpen}><Settings size={23} strokeWidth={1.8} />{updateReady && <span className="rail-update-dot" />}</button>
    </nav>
  )
}
