import { FolderOpen, ExternalLink } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { canAssignConversationWorkspace } from '../../../shared/conversationWorkspace'
import type { Conversation } from '../../../shared/types'
import { t } from '../preferences'

/** Shown only for chats with just the owner's agents, or when a saved
 * folder needs to be cleared after the members changed. */
export function ConversationWorkspaceSetting({ conversation }: {
  conversation: Conversation
}): ReactElement | null {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const eligible = canAssignConversationWorkspace(conversation)
  if (!eligible && !conversation.workspacePath && !conversation.allowedFolders?.length) return null
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setError('')
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : t('Could not save changes')) }
    finally { setBusy(false) }
  }
  const folderName = conversation.workspacePath?.split(/[\\/]/).filter(Boolean).at(-1) ?? conversation.workspacePath
  return <section className="conversation-workspace-setting" aria-label={t('Workspace')}>
    <h2>{t('Workspace')}</h2>
    <p className="conversation-workspace-path" title={conversation.workspacePath}>
      <FolderOpen size={15} />
      <span>{folderName ?? t('Default')}</span>
      <button className="conversation-workspace-open" type="button" title={t('Open folder')} aria-label={t('Open folder')} disabled={busy} onClick={() => void run(() => window.douchat.openConversationWorkspace(conversation.id))}><ExternalLink size={14} /></button>
    </p>
    {!eligible && <p className="conversation-workspace-note">{t('Not in effect: this chat now includes members other than your own agents.')}</p>}
    {eligible && conversation.type === 'group' && conversation.workspacePath && <p className="conversation-workspace-note">{t('Agents in this group share this folder.')}</p>}
    <div className="conversation-workspace-actions">
      {eligible && <button type="button" disabled={busy} onClick={() => void run(() => window.douchat.chooseConversationWorkspace(conversation.id))}>{t(conversation.workspacePath ? 'Change folder' : 'Choose folder')}</button>}
      {conversation.workspacePath && <button type="button" disabled={busy} onClick={() => void run(() => window.douchat.clearConversationWorkspace(conversation.id))}>{t('Use default')}</button>}
    </div>
    {error && <p className="conversation-workspace-error" role="alert">{t(error)}</p>}
  </section>
}
