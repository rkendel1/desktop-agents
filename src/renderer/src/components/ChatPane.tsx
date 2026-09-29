import type { SelectedMention } from '../../../shared/bot/mentions'
import { createPortal } from 'react-dom'
import { legacyGroupNotice } from '../../../shared/groupText'
import { messageSendError, type QueuedMessage } from '../messageQueue'
import { mentionableAgents } from './common'
import foundryLogo from '../../../../resources/icons/foundry.png'
import { t, tr } from '../preferences'
import { AtSign, FolderOpen, FileText, Check, ChevronDown, Copy, CornerDownRight, LoaderCircle, Lock, Mic, MoreHorizontal, Smile, SquareTerminal, TriangleAlert, Sparkles, Square, Trash2, ListEnd, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ClipboardEvent, KeyboardEvent, ReactElement } from 'react'
import type {
  AgentConfig,
  ChatMessage,
  Conversation,
  ConversationActivityState,
  MessageAttachment,
  MessageAction,
  MessageDelivery,
  MessageImageInput,
  MessageFileInput,
  MessageSource,
  Topic
} from '../../../shared/types'
import { MessageMarkdown, QuoteMarkdown, FileConversationContext } from './MessageMarkdown'
import type { ProfileAnchor } from './MemberProfilePopover'
import { summarizeRuntimeError, type RuntimeErrorSummary } from '../../../shared/bot/errors'
import { insertMention, mentionQuery, updateSelectedMentions, type MentionQuery } from '../../../shared/bot/mentions'
import { AgentAvatar, EmptyAvatar, UserAvatar, agentDisplayName, conversationDisplayName, dayLabel, formatTime, isDifferentDay } from './common'
import {
  speechRecognitionConstructor,
  speechRecognitionErrorMessage,
  speechRecognitionLanguage,
  type SpeechRecognitionLike
} from '../speechRecognition'

const MAX_PASTED_IMAGES = 4
const MAX_PASTED_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_PASTED_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024
const PASTED_IMAGE_TYPES = new Set<MessageAttachment['mimeType']>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
// Keep action receipts persisted for diagnostics, but do not surface them in
// completed chat messages until the product has a quieter presentation for them.
const SHOW_MESSAGE_ACTION_RECEIPTS = false
// Voice transcription remains implemented so it can be restored without a
// migration, but its entry point is intentionally hidden for this release.
const SHOW_VOICE_INPUT = false

interface PendingImage {
  isFile?: boolean
  id: string
  name: string
  mimeType: MessageAttachment['mimeType']
  size: number
  data: Uint8Array
  previewUrl: string
}

type VoiceInputState = 'idle' | 'starting' | 'listening' | 'processing'

async function readPastedImage(file: File): Promise<PendingImage> {
  const buffer = await file.arrayBuffer()
  const previewUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Invalid image data'))
    reader.onerror = () => reject(reader.error ?? new Error('Invalid image data'))
    reader.readAsDataURL(new Blob([buffer], { type: file.type }))
  })
  return {
    id: crypto.randomUUID(),
    name: file.name || 'pasted-image',
    mimeType: file.type as MessageAttachment['mimeType'],
    size: file.size,
    data: new Uint8Array(buffer),
    previewUrl
  }
}

async function copyMessage(message: ChatMessage): Promise<void> {
  if (message.text || !message.attachments?.length) {
    await window.douchat.copyText(message.text || message.error || '')
    return
  }
  await window.douchat.copyAttachment(message.attachments[0].id)
}

function ImagePreview({ source, attachment, onClose }: { source: string; attachment: MessageAttachment; onClose: () => void }): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  useLayoutEffect(() => {
    const element = dialog.current!
    if (element.showModal) element.showModal()
    else element.setAttribute('open', '')
    return () => { element.close?.() }
  }, [])
  return createPortal(<dialog ref={dialog} className="chat-image-preview" aria-label={t('Image preview')}
    onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="chat-image-preview-panel">
      <div className="chat-image-preview-toolbar"><span>{attachment.name || t('Image')}</span>
        <button type="button" onClick={() => { void window.douchat.copyAttachment(attachment.id).then(() => { setCopied(true); setError('') }).catch(() => setError(t('Image could not be copied'))) }}><Copy size={16} />{t(copied ? 'Copied' : 'Copy image')}</button>
        <button type="button" aria-label={t('Close')} onClick={onClose}><X size={20} /></button>
      </div>
      <img src={source} alt={attachment.name || t('Image')} />
      {error && <div role="alert">{error}</div>}
    </div>
  </dialog>, document.body)
}

function MessageImage({ attachment }: { attachment: MessageAttachment }): ReactElement {
  const [preview, setPreview] = useState(false)
  const [source, setSource] = useState('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    setSource('')
    setFailed(false)
    void window.douchat.getAttachmentData(attachment.id).then((dataUrl) => {
      if (active) setSource(dataUrl)
    }).catch(() => {
      if (active) setFailed(true)
    })
    return () => { active = false }
  }, [attachment.id])

  if (failed) return <div className="message-image-state">{t('Image could not be loaded')}</div>
  if (!source) return <div className="message-image-state is-loading" aria-label={t('Loading image')} />
  return <><button type="button" className="message-image-button" aria-label={t('View image')} onClick={() => setPreview(true)}>
    <img className="message-image" src={source} alt={attachment.name || t('Agent generated image')} />
  </button>{preview && <ImagePreview source={source} attachment={attachment} onClose={() => setPreview(false)} />}</>
}

function MessageAttachments({ attachments }: { attachments?: MessageAttachment[] }): ReactElement | null {
  if (!attachments?.length) return null
  return (
    <div className={`message-attachments count-${Math.min(attachments.length, 4)}`}>
      {attachments.map((attachment) => <MessageImage key={attachment.id} attachment={attachment} />)}
    </div>
  )
}

export function messageActionLabel(action: MessageAction): string {
  if (action.tool === 'update_user_memory') return t({ running: 'Updating user memory', succeeded: 'Updated user memory', failed: 'Could not update user memory' }[action.status])
  const target = action.target || t('the selected item')
  if (action.tool === 'read_skill_file') return tr({ running: 'Reading skill file {name}', succeeded: 'Read skill file {name}', failed: 'Could not read skill file {name}' }[action.status], { name: target })
  if (action.tool === 'list_skill_files') return t({ running: 'Listing skill files', succeeded: 'Listed skill files', failed: 'Could not list skill files' }[action.status])
  const labels: Record<MessageAction['status'], string> = action.tool === 'computer_open_file'
    ? {
        running: tr('Opening {name} with the system default app', { name: target }),
        succeeded: tr('Opened {name} with the system default app', { name: target }),
        failed: tr('Could not open {name} with the system default app', { name: target })
      }
    : action.tool === 'computer_list_files'
      ? {
          running: tr('Checking files in {name}', { name: target }),
          succeeded: tr('Checked files in {name}', { name: target }),
          failed: tr('Could not check files in {name}', { name: target })
        }
      : action.tool === 'computer_make_directory'
        ? {
            running: tr('Creating folder {name}', { name: target }),
            succeeded: tr('Created folder {name}', { name: target }),
            failed: tr('Could not create folder {name}', { name: target })
          }
        : action.tool === 'computer_move_file'
          ? {
              running: tr('Moving {name}', { name: target }),
              succeeded: tr('Moved {name}', { name: target }),
              failed: tr('Could not move {name}', { name: target })
            }
          : action.tool === 'computer_open'
            ? {
                running: tr('Opening {name}', { name: target }),
                succeeded: tr('Opened {name}', { name: target }),
                failed: tr('Could not open {name}', { name: target })
              }
            : action.tool === 'message_agent'
              ? {
                  running: tr('Contacting {name}', { name: target }),
                  succeeded: tr('Contacted {name}', { name: target }),
                  failed: tr('Could not contact {name}', { name: target })
                }
              : action.tool === 'create_agent'
                ? {
                    running: tr('Creating agent {name}', { name: target }),
                    succeeded: tr('Created agent {name}', { name: target }),
                    failed: tr('Could not create agent {name}', { name: target })
                  }
                : action.tool === 'update_agent'
                  ? {
                      running: tr('Updating agent {name}', { name: target }),
                      succeeded: tr('Updated agent {name}', { name: target }),
                      failed: tr('Could not update agent {name}', { name: target })
                    }
                  : action.tool === 'create_routine'
                    ? {
                        running: tr('Creating routine {name}', { name: target }),
                        succeeded: tr('Created routine {name}', { name: target }),
                        failed: tr('Could not create routine {name}', { name: target })
                      }
              : ['computer_snapshot', 'computer_click', 'computer_type', 'computer_scroll'].includes(action.tool)
                ? {
                    running: t('Working in the browser'),
                    succeeded: t('Completed a browser action'),
                    failed: t('Browser action failed')
                  }
                : action.tool.startsWith('email_')
                  ? {
                      running: t('Checking connected email'),
                      succeeded: t('Checked connected email'),
                      failed: t('Could not check connected email')
                    }
                  : {
                      running: t('Using a connected tool'),
                      succeeded: t('Completed a tool action'),
                      failed: t('Tool action failed')
                    }
  return labels[action.status]
}

export function MessageActions({ actions }: { actions?: MessageAction[] }): ReactElement | null {
  const [open, setOpen] = useState(false)
  if (!actions?.length) return null
  const successful = actions.filter((action) => action.status === 'succeeded')
  const primary = successful.at(-1) ?? actions.at(-1)!
  const collapsible = actions.length > 1
  const summary = successful.length
    ? messageActionLabel(primary)
    : tr('{count} actions could not be completed', { count: actions.length })
  const icon = primary.status === 'running'
    ? <LoaderCircle size={13} />
    : primary.status === 'failed'
      ? <TriangleAlert size={13} />
      : <Check size={13} />

  if (!collapsible) {
    return (
      <div className="message-actions" aria-label={t('Actions performed')}>
        <div className={`message-action is-${primary.status}`} role="status">
          <span className="message-action-icon" aria-hidden="true">{icon}</span>
          <span>{summary}</span>
        </div>
      </div>
    )
  }

  return (
    <div className={`message-actions ${open ? 'is-open' : ''}`} aria-label={t('Actions performed')}>
      <button
        type="button"
        className={`message-actions-toggle is-${primary.status}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="message-action-icon" aria-hidden="true">{icon}</span>
        <span className="message-actions-summary">{summary}</span>
        <span className="message-actions-count">{tr('{count} actions', { count: actions.length })}</span>
        <ChevronDown className="message-actions-chevron" size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div className="message-actions-details">
          {actions.map((action) => (
            <div className={`message-action is-${action.status}`} key={action.id} role="status">
              <span className="message-action-icon" aria-hidden="true">
                {action.status === 'running'
                  ? <LoaderCircle size={13} />
                  : action.status === 'failed'
                    ? <TriangleAlert size={13} />
                    : <Check size={13} />}
              </span>
              <span>{messageActionLabel(action)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function activityDetailLabel(activity: ConversationActivityState): string {
  if (activity.localProgress) {
    const progress = activity.localProgress
    if (progress.phase === 'connecting') return t('Connecting to local agent')
    if (progress.phase === 'approval') return t('Waiting for your approval; review the permission dialog')
    if (progress.phase === 'ready') return t('Task received; getting started')
    const elapsed = `${Math.floor(progress.elapsedSeconds / 60)}:${String(progress.elapsedSeconds % 60).padStart(2, '0')}`
    const state = progress.silentSeconds >= 60 ? t('Waiting for new progress from local agent') : t('Local agent is running')
    const detail = progress.detail ? t(progress.detail).trim() : ''
    return `${state} · ${elapsed}${detail && detail !== state ? `\n${detail}` : ''}`
  }
  if (activity.action?.status === 'running') return messageActionLabel(activity.action)
  if (activity.action?.status === 'failed') return t('Trying another approach')
  if (activity.action?.status === 'succeeded') return t('Preparing the result')
  if (activity.phase === 'planning') {
    if (activity.planningStage === 'health') return t('Checking group member availability')
    if (activity.planningStage === 'decision') return t('Choosing a leader and reply order')
    if (activity.planningStage === 'plan') return t('Preparing the task plan')
    if (activity.planningStage === 'recovery') return t('Arranging the next step after a member failure')
    return t('Coordinating the group')
  }
  if (activity.phase === 'greeting') return t('Preparing a greeting')
  if (activity.phase === 'delivering') return t('Delivering a message')
  return t('Thinking about the next step')
}

export function ChatActivity({
  activity,
  agents
}: {
  activity: ConversationActivityState
  agents: AgentConfig[]
}): ReactElement {
  const activeAgents = activity.agentIds
    .map((id) => agents.find((agent) => agent.id === id))
    .filter((agent): agent is AgentConfig => Boolean(agent))
  const detail = activityDetailLabel(activity)

  if (!activeAgents.length && activity.phase === 'planning') return (
    <div className="system-message" role="status" aria-live="polite">
      {activity.serviceName && <>{activity.serviceName} · </>}
      <span className="activity-status-line">
        <span className="typing-activity-text" key={detail}>{detail}</span>
        <span className="reply-status-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>
      </span>
    </div>
  )

  return <>{(activeAgents.length ? activeAgents : [undefined]).map(agent => (
    <div className="typing-row" key={agent?.id ?? 'service'}>
      {agent && <AgentAvatar agent={agent} size={36} />}
      <div className="typing-content" role="status" aria-live="polite">
        <span className="typing-label">{agent ? agentDisplayName(agent) : activity.serviceName || t(activity.label)}</span>
        <span className={`typing-bubble typing-activity${activity.localProgress ? ' is-local-progress' : ''}`}>
          <span className="activity-status-line">
            <span className="typing-activity-text" key={detail}>{detail}</span>
            <span className="reply-status-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>
          </span>
        </span>
      </div>
    </div>
  ))}</>
}

function deliveryRecipientName(delivery: MessageDelivery): string {
  return delivery.recipientName === 'Dr. Dou' ? t('Dr. Dou') : delivery.recipientName
}

function sourceContentFromMessages(
  source: MessageSource,
  receiverId: string,
  receivedAt: number,
  messages: ChatMessage[]
): string {
  return messages
    .filter((message) => message.authorId === source.id && message.createdAt <= receivedAt)
    .sort((left, right) => right.createdAt - left.createdAt)
    .flatMap((message) => message.deliveries ?? [])
    .find((delivery) => delivery.recipientId === receiverId)?.content ?? ''
}

function repliesForDelivery(
  delivery: MessageDelivery,
  senderId: string,
  sentAt: number,
  messages: ChatMessage[]
): NonNullable<MessageDelivery['replies']> {
  const messagesById = new Map(messages.map((message) => [message.id, message]))
  const replies = (delivery.replies ?? []).map((reply) => {
    const replyGroupId = reply.replyGroupId ?? messagesById.get(reply.id)?.replyGroupId
    return replyGroupId && !reply.replyGroupId ? { ...reply, replyGroupId } : reply
  })
  const known = new Set(replies.map((reply) => reply.id))
  const nextDeliveryAt = messages
    .filter((message) => message.authorId === senderId && message.createdAt > sentAt)
    .filter((message) => message.deliveries?.some((candidate) => candidate.recipientId === delivery.recipientId))
    .reduce((earliest, message) => Math.min(earliest, message.createdAt), Number.POSITIVE_INFINITY)
  for (const message of messages) {
    if (
      known.has(message.id) ||
      message.authorId !== delivery.recipientId ||
      message.source?.kind !== 'bot' ||
      message.source.id !== senderId ||
      message.createdAt < sentAt ||
      message.createdAt >= nextDeliveryAt
    ) continue
    replies.push({
      id: message.id,
      senderId: message.authorId,
      senderName: message.authorName,
      content: message.text,
      createdAt: message.createdAt,
      replyGroupId: message.replyGroupId,
      attachments: message.attachments,
      error: message.error
    })
    known.add(message.id)
  }
  return replies.sort((left, right) => left.createdAt - right.createdAt)
}

type DeliveryReply = NonNullable<MessageDelivery['replies']>[number]

export function groupDeliveryReplies(replies: DeliveryReply[]): DeliveryReply[][] {
  const groups: DeliveryReply[][] = []
  for (const reply of replies) {
    const previousGroup = groups.at(-1)
    const previous = previousGroup?.at(-1)
    const sameReplyTurn = Boolean(
      previous &&
      previous.senderId === reply.senderId &&
      (
        (reply.replyGroupId && previous.replyGroupId === reply.replyGroupId) ||
        (!reply.replyGroupId && !previous.replyGroupId && previous.createdAt === reply.createdAt)
      )
    )
    if (sameReplyTurn) previousGroup!.push(reply)
    else groups.push([reply])
  }
  return groups
}

export function MessageDeliveries({
  deliveries,
  agents = [],
  userName = '',
  userAvatar = '',
  senderId = '',
  sentAt = 0,
  relatedMessages = []
}: {
  deliveries: MessageDelivery[]
  agents?: AgentConfig[]
  userName?: string
  userAvatar?: string
  senderId?: string
  sentAt?: number
  relatedMessages?: ChatMessage[]
}): ReactElement {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const recipientNames = deliveries.map(deliveryRecipientName).join(', ')
  const isGroupInvitation = deliveries.every((delivery) => delivery.kind === 'group-invitation')
  const summary = tr(isGroupInvitation ? 'Invited {names} to participate' : 'Sent private message to {names}', { names: recipientNames })
  const DeliveryIcon = isGroupInvitation ? CornerDownRight : Lock

  // Group receipts expose delivery status only. Secret bodies live in the
  // recipient's private context (or the human's direct inbox).
  if (deliveries.every((delivery) => !delivery.content && !delivery.replies?.length)) {
    return <div className="bubble-deliveries"><DeliveryIcon size={10} /><span>{summary}</span></div>
  }

  return (
    <div className={`bubble-delivery-disclosure ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="bubble-deliveries"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={detailsId}
        title={t(isGroupInvitation ? open ? 'Hide invitation details' : 'Show invitation details' : open ? 'Hide private messages' : 'Show private messages')}
      >
        <DeliveryIcon size={10} />
        <span>{summary}</span>
        <ChevronDown className="bubble-delivery-chevron" size={12} aria-hidden="true" />
      </button>
      {open && (
        <div className="bubble-delivery-details" id={detailsId}>
          {deliveries.map((delivery) => {
            const recipient = agents.find((agent) => agent.id === delivery.recipientId)
            const recipientName = deliveryRecipientName(delivery)
            const replies = repliesForDelivery(delivery, senderId, sentAt, relatedMessages)
            const replyGroups = groupDeliveryReplies(replies)
            return (
              <section className="bubble-delivery-note" key={delivery.id}>
                <div
                  className="bubble-delivery-recipient"
                  aria-label={tr('To {name}', { name: recipientName })}
                >
                  <span>{t('To')}</span>
                  <span className="bubble-delivery-inline-avatar" aria-hidden="true">
                    {recipient
                      ? <AgentAvatar agent={recipient} size={18} />
                      : delivery.recipientId === 'human'
                        ? <UserAvatar src={userAvatar} name={userName || recipientName} size={18} />
                        : <EmptyAvatar size={18} />}
                  </span>
                  <span>{recipientName}</span>
                </div>
                <div className="bubble-delivery-copy">
                  <div className="bubble-delivery-content">
                    <MessageMarkdown text={delivery.content} />
                  </div>
                  {replies.length ? (
                    <div className="bubble-delivery-replies">
                      {replyGroups.map((replyGroup) => {
                        const firstReply = replyGroup[0]
                        return (
                          <div className="bubble-delivery-reply" key={firstReply.id}>
                            <div className="bubble-delivery-reply-author">
                              <CornerDownRight size={11} aria-hidden="true" />
                              {tr('{name} replied', { name: firstReply.senderName })}
                            </div>
                            {replyGroup.map((reply) => (
                              <div className="bubble-delivery-reply-segment" key={reply.id}>
                                {reply.content ? (
                                  <div className="bubble-delivery-reply-content">
                                    <MessageMarkdown text={reply.error && reply.content.trim() === reply.error.trim() ? t(reply.error) : reply.content} />
                                  </div>
                                ) : null}
                                <MessageAttachments attachments={reply.attachments} />
                                {reply.error && reply.content.trim() !== reply.error.trim() ? <span className="bubble-error">{t(reply.error)}</span> : null}
                              </div>
                            ))}
                          </div>
                        )
                      })}
                    </div>
                  ) : null}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function MessageSourceCard({
  source,
  agents = [],
  fallbackContent = '',
  receiverId = '',
  receivedAt = 0,
  relatedMessages = []
}: {
  source: MessageSource
  agents?: AgentConfig[]
  fallbackContent?: string
  receiverId?: string
  receivedAt?: number
  relatedMessages?: ChatMessage[]
}): ReactElement {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const sender = agents.find((agent) => agent.id === source.id)
  const senderName = source.name === 'Dr. Dou' ? t('Dr. Dou') : source.name
  const content = source.content?.trim() ||
    sourceContentFromMessages(source, receiverId, receivedAt, relatedMessages).trim() ||
    fallbackContent.trim()
  return (
    <div className={`bubble-private-source-disclosure ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="bubble-deliveries"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={detailsId}
        title={t(open ? 'Hide private messages' : 'Show private messages')}
      >
        <Lock size={10} />
        <span>{tr('Received privately from {name}', { name: senderName })}</span>
        <ChevronDown className="bubble-delivery-chevron" size={12} aria-hidden="true" />
      </button>
      {open && (
        <div className="bubble-delivery-details bubble-private-source" id={detailsId}>
          <section className="bubble-delivery-note">
            <div
              className="bubble-delivery-recipient"
              aria-label={tr('From {name}', { name: senderName })}
            >
              <span>{t('From')}</span>
              <span className="bubble-delivery-inline-avatar" aria-hidden="true">
                {sender
                  ? <AgentAvatar agent={sender} size={18} />
                  : <EmptyAvatar size={18} group={source.kind === 'group'} />}
              </span>
              <span>{senderName}</span>
            </div>
            <div className="bubble-delivery-copy">
              <div className="bubble-delivery-content">
                <MessageMarkdown text={content || t('Private message details are unavailable.')} />
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

export function MessageGroupRow({
  messages,
  agent,
  agents,
  relatedMessages,
  userName,
  userAvatar,
  showAuthor,
  onOpenAgentProfile
}: {
  messages: ChatMessage[]
  agent?: AgentConfig
  agents: AgentConfig[]
  relatedMessages: ChatMessage[]
  userName: string
  userAvatar: string
  showAuthor: boolean
  onOpenAgentProfile?: (agentId: string, anchor: ProfileAnchor) => void
}): ReactElement {
  const first = messages[0]
  const mergePrivateReply = Boolean(
    first.replyGroupId &&
    first.source?.kind === 'bot' &&
    messages.length > 1 &&
    messages.every((message) =>
      message.replyGroupId === first.replyGroupId &&
      message.source?.kind === first.source?.kind &&
      message.source?.id === first.source?.id
    )
  )
  if (!mergePrivateReply && messages.length > 1) {
    return <>{messages.map((message) => (
      <MessageGroupRow
        key={message.id}
        messages={[message]}
        agent={agent}
        agents={agents}
        relatedMessages={relatedMessages}
        userName={userName}
        userAvatar={userAvatar}
        showAuthor={showAuthor}
        onOpenAgentProfile={onOpenAgentProfile}
      />
    ))}</>
  }
  const bubbleGroups = mergePrivateReply ? [messages] : messages.map((message) => [message])
  return (
    <div className="message-row agent-message-row">
      <div className="message-avatar-slot">
        {agent && onOpenAgentProfile ? (
          <button
            type="button"
            className="message-avatar-button"
            aria-label={tr('{name} — view profile', { name: agentDisplayName(agent) })}
            title={agentDisplayName(agent)}
            onClick={(event) => onOpenAgentProfile(
              agent.id,
              (event.currentTarget.querySelector('.agent-avatar') ?? event.currentTarget).getBoundingClientRect()
            )}
          >
            <AgentAvatar agent={agent} size={36} />
          </button>
        ) : agent ? <AgentAvatar agent={agent} size={36} /> : <EmptyAvatar size={36} />}
      </div>
      <div className="message-body">
        {(showAuthor || first.source) && (
          <div className="message-author">
            {agent ? agentDisplayName(agent) : first.authorName}
          </div>
        )}
        {bubbleGroups.map((bubbleMessages) => {
          const bubble = bubbleMessages[0]
          const hasError = bubbleMessages.some((message) => Boolean(message.error))
          const hasAttachments = bubbleMessages.some((message) => Boolean(message.attachments?.length))
          const hasText = bubbleMessages.some((message) => Boolean(message.text))
          const actions = bubbleMessages.flatMap((message) => message.actions ?? [])
          return (
            <div key={bubble.id} data-message-id={bubble.id} className={`message-bubble agent-bubble ${hasError ? 'has-error' : ''} ${hasAttachments ? 'has-attachments' : ''} ${!hasText && hasAttachments ? 'image-only' : ''}`}>
              {bubble.source ? (
                <MessageSourceCard
                  source={bubble.source}
                  agents={agents}
                  receiverId={bubble.authorId}
                  receivedAt={bubble.createdAt}
                  relatedMessages={relatedMessages}
                  fallbackContent={bubble.source.kind === 'group' ? bubble.text : ''}
                />
              ) : null}
              {bubbleMessages.map((message) => message.source?.kind !== 'group' ? (
                <div className="bubble-reply-segment" key={message.id} data-message-id={message.id}>
                  {message.deliveries?.length ? (
                    <MessageDeliveries
                      deliveries={message.deliveries}
                      agents={agents}
                      userName={userName}
                      userAvatar={userAvatar}
                      senderId={message.authorId}
                      sentAt={message.createdAt}
                      relatedMessages={relatedMessages}
                    />
                  ) : null}
                  {message.text ? (
                    <div className="bubble-primary-content">
                      <MessageMarkdown text={message.error && message.text.trim() === message.error.trim() ? t(message.error) : message.text} />
                    </div>
                  ) : null}
                  <MessageAttachments attachments={message.attachments} />
                  {message.error && message.text.trim() !== message.error.trim() ? <span className="bubble-error">{t(message.error)}</span> : null}

                </div>
              ) : null)}
              {SHOW_MESSAGE_ACTION_RECEIPTS ? <MessageActions actions={actions} /> : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** A failure leads with the specific problem and next step; only the raw
 *  developer diagnostic stays behind a disclosure. */
export function SystemMessage({ message }: { message: ChatMessage }): ReactElement {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])

  // Messages written before failures were summarised, and any path that still
  // hands over a raw dump, get folded here rather than filling the thread.
  const shortSummary = summarizeRuntimeError(message.text)
  const summary: RuntimeErrorSummary | null = message.detail
    ? (() => {
        const diagnostic = summarizeRuntimeError(message.detail)
        return {
          title: diagnostic.guidance ? diagnostic.title : shortSummary.title,
          guidance: diagnostic.guidance ?? shortSummary.guidance,
          action: diagnostic.action ?? shortSummary.action,
          detail: message.detail
        }
      })()
    : message.text.length > 200 || shortSummary.guidance
      ? shortSummary
      : null
  const localization = message.localization ?? legacyGroupNotice(message)
  if (localization) return <div className="system-message">{tr(localization.key, localization.values)}</div>
  if (!summary) return <div className="system-message">{t(message.text)}</div>

  return (
    <div className={`system-message is-error ${open ? 'is-open' : ''}`}>
      <div className="system-line">
        <TriangleAlert size={13} />
        <div className="system-summary">
          <strong>{t(summary.title)}</strong>
          {(summary.guidance || summary.action?.kind === 'update-local-agent') && (
            <div className="system-guidance">
              {summary.guidance ? <span>{t(summary.guidance)}</span> : null}
              {summary.action?.kind === 'update-local-agent' && (
                <button className="system-inline-action" type="button" disabled={launching} onClick={() => {
                  setLaunching(true)
                  setActionError('')
                  void window.douchat.maintainLocalAgent('grok')
                    .catch(() => setActionError(t('Could not open the updater. Try Settings → Local agents.')))
                    .finally(() => setLaunching(false))
                }}>{t(launching ? 'Opening…' : 'Update Grok')}</button>
              )}
              {summary.action?.kind === 'update-local-agent' && actionError && <span role="alert">{t(actionError)}</span>}
            </div>
          )}
        </div>
        <button
          className="system-toggle"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {t(open ? 'Hide' : 'Details')}
          <ChevronDown size={11} className={open ? 'open' : ''} />
        </button>
      </div>
      {open && (
        <div className="system-detail">
          <pre>{summary.detail}</pre>
          <div className="system-detail-actions">
            <button
              className="system-copy"
              onClick={() => {
                void window.douchat.copyText(summary.detail).then(() => setCopied(true))
              }}
            >
              {copied ? <Check size={11} /> : <Copy size={11} />}
              {t(copied ? 'Copied' : 'Copy')}
            </button>
            {summary.action?.kind === 'open-local-agent-terminal' && (
              <button
                className="system-copy system-recovery-action"
                disabled={launching}
                onClick={() => {
                  setLaunching(true)
                  setActionError('')
                  let timedOut = false
                  const timeout = window.setTimeout(() => {
                    timedOut = true
                    setLaunching(false)
                    setActionError(t('Opening Claude Code timed out. Try again or run claude in a terminal manually.'))
                  }, 6_000)
                  void window.douchat.openLocalAgentTerminal('claude')
                    .then(() => {
                      if (timedOut) setActionError('')
                    })
                    .catch(() => setActionError(t('Could not open Claude Code. Open a terminal and run claude manually.')))
                    .finally(() => {
                      window.clearTimeout(timeout)
                      setLaunching(false)
                    })
                }}
              >
                {launching ? <LoaderCircle size={11} className="spin" /> : <SquareTerminal size={11} />}
                {t(launching ? 'Opening…' : summary.action.label)}
              </button>
            )}
          </div>
          {actionError ? <p className="system-action-error">{t(actionError)}</p> : null}
        </div>
      )}
    </div>
  )
}

function MessageQuote({ author, text, attachments, onCancel }: { author: string; text: string; attachments?: MessageAttachment[]; onCancel?: () => void }): ReactElement {
  return <div className={`message-quote${onCancel ? ' composer-quote' : ''}`}>
    <div className="message-quote-text" title={`${author}: ${text}`}><span>{author}: </span><QuoteMarkdown text={text} /></div>
    <MessageAttachments attachments={attachments} />
    {onCancel && <button type="button" aria-label={t('Cancel quote')} onClick={onCancel}><X size={11} strokeWidth={2.5} /></button>}
  </div>
}

function UserMessageText({ text, attachments }: { text: string; attachments?: MessageAttachment[] }): ReactElement {
  // Existing replies store their quote as an author line followed by quoted lines.
  const quote = /^> ([^\r\n]+):\r?\n((?:>[^\r\n]*(?:\r?\n|$))+)\r?\n?/.exec(text)
  if (!quote) return text.startsWith('> ') || /\]\(<douchat-file:/.test(text) ? <MessageMarkdown text={text} /> : <span>{text}</span>
  return <><MessageQuote author={quote[1]} text={quote[2].replace(/^> ?/gm, '').trim()} attachments={attachments} />{/\]\(<douchat-file:/.test(text.slice(quote[0].length)) ? <MessageMarkdown text={text.slice(quote[0].length)} /> : <span>{text.slice(quote[0].length)}</span>}</>
}

export function MessageRow({
  messages,
  agent,
  agents,
  relatedMessages,
  userName,
  userAvatar,
  showAuthor,
  onOpenAgentProfile,
  onOpenUserProfile
}: {
  messages: ChatMessage[]
  agent?: AgentConfig
  agents: AgentConfig[]
  relatedMessages: ChatMessage[]
  userName: string
  userAvatar: string
  showAuthor: boolean
  onOpenAgentProfile?: (agentId: string, anchor: ProfileAnchor) => void
  onOpenUserProfile?: (anchor: ProfileAnchor) => void
}): ReactElement {
  const message = messages[0]
  if (message.kind === 'handoff') {
    return (
      <div className="handoff-row">
        <span className="handoff-line" />
        <span className="handoff-chip">
          <Sparkles size={12} />
          {message.text}
        </span>
        <span className="handoff-line" />
      </div>
    )
  }
  if (message.kind === 'system') return <SystemMessage message={message} />
  if (message.authorId === 'user') {
    const hasAttachments = Boolean(message.attachments?.length)
    const hasQuote = /^> [^\r\n]+:\r?\n>/.test(message.text)
    const legacyQuote = hasQuote && message.attachments?.every(image => image.quoted === undefined)
    const quoteImages = hasQuote ? message.attachments?.filter(image => legacyQuote || image.quoted) : undefined
    const ownImages = message.attachments?.filter(image => !quoteImages?.includes(image))
    const channel = message.sourceChannel && {
      wechat: { name: t('WeChat'), icon: 'wechat.svg' },
      feishu: { name: t('Feishu'), icon: 'feishu.png' },
      telegram: { name: 'Telegram', icon: 'telegram.svg' }
    }[message.sourceChannel]
    return (
      <div className="message-row user-message-row">
        {channel && <span className="message-channel-badge" role="img" aria-label={tr('Sent via {channel}', { channel: channel.name })} title={tr('Sent via {channel}', { channel: channel.name })}>
          <img src={`./channels/${channel.icon}`} alt="" />
        </span>}
        <div className={`message-bubble user-bubble ${hasAttachments ? 'has-attachments' : ''} ${!message.text && hasAttachments ? 'image-only' : ''}`}>
          {message.text && <UserMessageText text={message.text} attachments={quoteImages} />}
          {message.deliveryState && <small className="message-delivery-state" role="status">{message.deliveryState === 'sending' ? '发送中…' : message.deliveryState === 'confirming' ? '已发送，正在同步接单状态…' : '发送未确认，请在队列中重试'}</small>}
          <MessageAttachments attachments={ownImages} />
        </div>
        {onOpenUserProfile ? (
          <button
            type="button"
            className="message-avatar-button user-profile-avatar-button"
            onClick={(event) => onOpenUserProfile(event.currentTarget.getBoundingClientRect())}
            aria-label={tr('{name} — open your profile', { name: userName })}
            title={userName}
          >
            <UserAvatar
              src={userAvatar}
              name={userName}
              size={36}
              className="user-chat-avatar"
            />
          </button>
        ) : (
          <UserAvatar
            src={userAvatar}
            name={userName}
            size={36}
            className="user-chat-avatar"
          />
        )}
      </div>
    )
  }
  return (
    <MessageGroupRow
      messages={messages}
      agent={agent}
      agents={agents}
      relatedMessages={relatedMessages}
      userName={userName}
      userAvatar={userAvatar}
      showAuthor={showAuthor}
      onOpenAgentProfile={onOpenAgentProfile}
    />
  )
}

export function visibleConversationMessages(
  conversation: Conversation | undefined,
  messages: ChatMessage[]
): ChatMessage[] {
  if (!conversation || conversation.type !== 'direct') return messages
  const participantIds = new Set(conversation.agentIds)
  const visible = messages.filter((message) =>
    message.kind !== 'handoff' &&
    (message.authorId === 'user' || message.authorId === 'system' || participantIds.has(message.authorId))
  )
  // Fold only adjacent delivery-only receipts into the next answer by the same
  // agent. Keep stored messages intact and preserve standalone receipts while
  // waiting, on failure, or when a user/another speaker starts a new turn.
  const folded: ChatMessage[] = []
  for (const message of visible) {
    const previous = folded.at(-1)
    const receiptOnly = previous?.kind === 'message' && !previous.text.trim()
      && previous.deliveries?.length && !previous.source && !previous.error
      && !previous.attachments?.length && !previous.actions?.length
    if (receiptOnly && message.kind === 'message' && !message.source
      && message.authorId === previous.authorId && message.topicId === previous.topicId
      && message.conversationId === previous.conversationId) {
      folded[folded.length - 1] = { ...message, deliveries: [...previous.deliveries!, ...(message.deliveries ?? [])] }
    } else folded.push(message)
  }
  return folded
}

export function groupConversationMessages(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = []
  for (const message of messages) {
    const previousGroup = groups.at(-1)
    const previous = previousGroup?.at(-1)
    if (
      message.kind === 'message' &&
      message.replyGroupId &&
      message.source?.kind === 'bot' &&
      previous?.kind === 'message' &&
      previous.replyGroupId === message.replyGroupId &&
      previous.authorId === message.authorId &&
      previous.source?.kind === 'bot' &&
      previous.source.id === message.source.id
    ) {
      previousGroup!.push(message)
    } else {
      groups.push([message])
    }
  }
  return groups
}

export function ChatPane({
  loadMessagePage,
  initialHasMore,
  userName,
  userAvatar,
  conversation,
  topic,
  messages: recentMessages,
  allMessages,
  agents,
  members,
  activity,
  offline,
  onConnect,
  inspectorOpen,
  onToggleInspector,
  onOpenAgentProfile,
  onOpenUserProfile,
  queuedMessages = [],
  onPromoteQueued,
  onRemoveQueued,
  onSend,
  onStop
}: {
  loadMessagePage?: (before?: string) => Promise<{ messages: ChatMessage[]; hasMore: boolean }>
  initialHasMore?: boolean
  userName: string
  userAvatar: string
  conversation?: Conversation
  topic?: Topic
  messages: ChatMessage[]
  allMessages: ChatMessage[]
  agents: AgentConfig[]
  members: AgentConfig[]
  activity?: ConversationActivityState
  offline: boolean
  onConnect: () => void
  inspectorOpen: boolean
  onToggleInspector: () => void
  onOpenAgentProfile: (agentId: string, anchor: ProfileAnchor) => void
  onOpenUserProfile: (anchor: ProfileAnchor) => void
  queuedMessages?: QueuedMessage[]
  onPromoteQueued?: (id: number) => void
  onRemoveQueued?: (id: number) => void
  onSend: (text: string, images?: MessageImageInput[], files?: MessageFileInput[], mentions?: SelectedMention[]) => Promise<void>
  onStop: () => void
}): ReactElement {
  const [history, setHistory] = useState(() => ({ source: recentMessages, messages: loadMessagePage ? recentMessages : recentMessages.slice(-50) }))
  const [hasMore, setHasMore] = useState(Boolean(initialHasMore) || recentMessages.length > 50)
  useEffect(() => { if (initialHasMore !== undefined) setHasMore(initialHasMore) }, [initialHasMore])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [historyError, setHistoryError] = useState(false)
  const loadingRef = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  let messages = history.messages
  if (history.source !== recentMessages) {
    const updates = new Map(recentMessages.map((message) => [message.id, message]))
    const known = new Set(history.messages.map((message) => message.id))
    const lastKnownIndex = recentMessages.reduce((last, message, index) => known.has(message.id) ? index : last, -1)
    messages = recentMessages.length ? [
      ...history.messages.map((message) => updates.get(message.id) ?? message),
      ...recentMessages.slice(lastKnownIndex + 1)
    ] : []
    if (!history.messages.length) messages = loadMessagePage ? recentMessages : recentMessages.slice(-50)
    setHistory({ source: recentMessages, messages })
    if (!recentMessages.length) setHasMore(false)
  }
  const [messageMenu, setMessageMenu] = useState<{ message: ChatMessage; x: number; y: number } | null>(null)
  const [quotedMessage, setQuotedMessage] = useState<ChatMessage | null>(null)
  const [deletedIds, setDeletedIds] = useState<Set<string>>(() => new Set())
  const menuRef = useRef<HTMLDivElement>(null)
  const [messageActionError, setMessageActionError] = useState('')
  const messageText = (message: ChatMessage): string => message.text || message.attachments?.map((image) => `[${image.name || t('Image')}]`).join('\n') || t(message.error || 'Message')
  useEffect(() => {
    if (!messageMenu) return
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const close = (event: Event): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMessageMenu(null)
    }
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setMessageMenu(null)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('scroll', close, true)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('scroll', close, true)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('resize', close)
    }
  }, [messageMenu])
  const [draft, setDraftValue] = useState('')
  const selectedMentions = useRef<SelectedMention[]>([])
  const draftValue = useRef('')
  const setDraft = (update: string | ((value: string) => string)): void => {
    const value = typeof update === 'function' ? update(draftValue.current) : update
    selectedMentions.current = updateSelectedMentions(draftValue.current, value, selectedMentions.current)
    draftValue.current = value
    setDraftValue(value)
  }
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  const [attachmentError, setAttachmentError] = useState('')
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [mention, setMention] = useState<MentionQuery | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [sending, setSending] = useState(false)
  const [voiceState, setVoiceState] = useState<VoiceInputState>('idle')
  const [voiceError, setVoiceError] = useState('')
  const [voiceNeedsSettings, setVoiceNeedsSettings] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [readingFiles, setReadingFiles] = useState(false)
  const selectedConversationRef = useRef(conversation?.id)
  selectedConversationRef.current = conversation?.id
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const voiceAttemptRef = useRef(0)
  const voiceEndTimerRef = useRef<number | null>(null)
  const voiceBaseRef = useRef('')
  const voiceTranscriptRef = useRef('')
  const working = Boolean(activity)
  const fullConversationName = conversation ? conversationDisplayName(conversation, agents) : ''
  const conversationName = conversation ? conversationDisplayName(conversation, agents, true) : ''
  const timelineMessages = visibleConversationMessages(conversation, messages)
  const timelineGroups = groupConversationMessages(timelineMessages.filter((message) => !deletedIds.has(message.id)))

  useEffect(() => {
    voiceAttemptRef.current += 1
    if (voiceEndTimerRef.current !== null) window.clearTimeout(voiceEndTimerRef.current)
    voiceEndTimerRef.current = null
    recognitionRef.current?.abort()
    recognitionRef.current = null
    voiceTranscriptRef.current = ''
    setVoiceState('idle')
    setVoiceError('')
    setVoiceNeedsSettings(false)
    setDraft('')
    setMessageMenu(null)
    setQuotedMessage(null)
    setMessageActionError('')
    setMention(null)
    setEmojiOpen(false)
  }, [conversation?.id, topic?.id])

  useEffect(() => () => {
    voiceAttemptRef.current += 1
    if (voiceEndTimerRef.current !== null) window.clearTimeout(voiceEndTimerRef.current)
    recognitionRef.current?.abort()
    recognitionRef.current = null
  }, [])

  const nearBottom = useRef(true)
  const initialScroll = useRef(true)
  const prependPosition = useRef<{ height: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const node = scrollRef.current
    if (!node) return
    if (prependPosition.current) {
      node.scrollTop = prependPosition.current.top + node.scrollHeight - prependPosition.current.height
      prependPosition.current = null
    } else if (initialScroll.current || nearBottom.current) {
      node.scrollTop = node.scrollHeight
      initialScroll.current = false
    }
  }, [messages, activity?.phase, activity?.label, queuedMessages, pendingImages, quotedMessage])

  // Both viewport changes and deferred message layout can move the bottom.
  // ResizeObserver runs before paint, so correct the position in the same frame.
  useLayoutEffect(() => {
    const node = scrollRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (nearBottom.current && !prependPosition.current) node.scrollTop = node.scrollHeight
    })
    observer.observe(node)
    if (canvasRef.current) observer.observe(canvasRef.current)
    return () => observer.disconnect()
  }, [conversation?.id, topic?.id])

  async function loadOlder(): Promise<void> {
    const node = scrollRef.current
    if (!node || !conversation || !topic || !hasMore || loadingRef.current) return
    loadingRef.current = true
    setLoadingHistory(true)
    setHistoryError(false)
    try {
      const page = await (loadMessagePage ? loadMessagePage(messages[0]?.id) : window.douchat.getMessagePage(conversation.id, topic.id, messages[0]?.id))
      if (!alive.current) return
      prependPosition.current = { height: node.scrollHeight, top: node.scrollTop }
      setHistory((current) => {
        const ids = new Set(current.messages.map((message) => message.id))
        return { ...current, messages: [...page.messages.filter((message) => !ids.has(message.id)), ...current.messages] }
      })
      setHasMore(page.hasMore)
    } catch {
      if (alive.current) setHistoryError(true)
    } finally {
      loadingRef.current = false
      if (alive.current) setLoadingHistory(false)
    }
  }

  const addressableMembers = useMemo(() => mentionableAgents(conversation, members), [conversation, members])
  const mentionOptions = useMemo(() => {
    if (!mention || conversation?.type !== 'group') return []
    const needle = mention.query.normalize('NFKC').toLocaleLowerCase()
    return [
      { id: 'all', name: 'all', label: t('Everyone'), agent: undefined as AgentConfig | undefined },
      ...addressableMembers.map((member) => ({ id: member.id, name: member.name, label: agentDisplayName(member), agent: member }))
    ].filter((option) => `${option.label} ${option.name}`.normalize('NFKC').toLocaleLowerCase().includes(needle))
  }, [mention, addressableMembers, conversation])

  useEffect(() => setMentionIndex(0), [mention?.query])

  const applyMention = (option: { id: string; name: string }): void => {
    const { name, id } = option
    if (!mention) return
    const next = insertMention(draft, mention, name)
    setDraft(next.value)
    if (id !== 'all') selectedMentions.current.push({ id, name, start: mention.start, end: mention.start + name.length + 1 })
    setMention(null)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(next.cursor, next.cursor)
    })
  }

  const trackMention = (value: string, cursor: number | null): void => {
    if (conversation?.type !== 'group' || cursor === null) {
      setMention(null)
      return
    }
    setMention(mentionQuery(value, cursor, addressableMembers.map((member) => ({ id: member.id, name: member.name }))))
  }

  const stopVoiceInput = (): void => {
    voiceAttemptRef.current += 1
    const recognition = recognitionRef.current
    if (!recognition) {
      setVoiceState('idle')
      return
    }
    setVoiceState('processing')
    recognition.stop()
    if (voiceEndTimerRef.current !== null) window.clearTimeout(voiceEndTimerRef.current)
    voiceEndTimerRef.current = window.setTimeout(() => {
      if (recognitionRef.current !== recognition) return
      recognition.abort()
      recognitionRef.current = null
      setVoiceState('idle')
    }, 1800)
  }

  const startVoiceInput = async (): Promise<void> => {
    const Recognition = speechRecognitionConstructor()
    if (!Recognition) {
      setVoiceError(t('Voice input is unavailable in this version of Foundry.'))
      setVoiceNeedsSettings(false)
      return
    }

    const attempt = voiceAttemptRef.current + 1
    voiceAttemptRef.current = attempt
    setEmojiOpen(false)
    setMention(null)
    setVoiceError('')
    setVoiceNeedsSettings(false)
    setVoiceState('starting')

    try {
      const access = await window.douchat.requestMicrophoneAccess()
      if (voiceAttemptRef.current !== attempt) return
      if (!navigator.mediaDevices?.getUserMedia) {
        setVoiceError(t('Voice input is unavailable in this version of Foundry.'))
        setVoiceNeedsSettings(false)
        setVoiceState('idle')
        return
      }
      try {
        // The OS status can be stale after the user changes System Settings.
        // A real capture is authoritative and also separates microphone access
        // from the independent browser speech-recognition service.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        stream.getTracks().forEach((track) => track.stop())
      } catch {
        if (voiceAttemptRef.current !== attempt) return
        if (access === 'granted') {
          setVoiceError(t('Microphone permission changed. Restart Foundry and try again.'))
          setVoiceNeedsSettings(false)
        } else {
          setVoiceError(tr('Microphone access is off. Allow {name} in System Settings, then restart the app.', {
            name: window.douchat.microphonePermissionOwner
          }))
          setVoiceNeedsSettings(true)
        }
        setVoiceState('idle')
        return
      }
      if (voiceAttemptRef.current !== attempt) return

      const recognition = new Recognition()
      recognitionRef.current = recognition
      voiceBaseRef.current = draft
      voiceTranscriptRef.current = ''
      recognition.lang = speechRecognitionLanguage(document.documentElement.lang)
      recognition.continuous = true
      recognition.interimResults = true
      recognition.maxAlternatives = 1
      recognition.onstart = () => {
        if (recognitionRef.current === recognition) setVoiceState('listening')
      }
      recognition.onresult = (event) => {
        let transcript = ''
        for (let index = 0; index < event.results.length; index += 1) {
          transcript += event.results[index]?.[0]?.transcript ?? ''
        }
        voiceTranscriptRef.current = transcript.trimStart()
        const separator = voiceBaseRef.current && !/\s$/.test(voiceBaseRef.current) && voiceTranscriptRef.current ? ' ' : ''
        setDraft(`${voiceBaseRef.current}${separator}${voiceTranscriptRef.current}`)
      }
      recognition.onerror = (event) => {
        if (event.error !== 'aborted') {
          // getUserMedia succeeded immediately before recognition started, so
          // these errors come from the recognition service, not microphone TCC.
          setVoiceError(t(speechRecognitionErrorMessage(event.error, true)))
          setVoiceNeedsSettings(false)
        }
      }
      recognition.onend = () => {
        if (voiceEndTimerRef.current !== null) window.clearTimeout(voiceEndTimerRef.current)
        voiceEndTimerRef.current = null
        if (recognitionRef.current !== recognition) return
        recognitionRef.current = null
        setVoiceState('idle')
        textareaRef.current?.focus()
      }
      recognition.start()
    } catch {
      if (voiceAttemptRef.current !== attempt) return
      recognitionRef.current = null
      setVoiceState('idle')
      setVoiceError(t('Voice input could not start. Try again.'))
      setVoiceNeedsSettings(false)
    }
  }

  const toggleVoiceInput = (): void => {
    if (voiceState === 'idle') void startVoiceInput()
    else stopVoiceInput()
  }

  const send = async (): Promise<void> => {
    const content = draft.trim()
    if ((!content && !pendingImages.length && !quotedMessage) || !conversation || sending || readingFiles || voiceState !== 'idle') return
    const quote = quotedMessage
    const outgoing = quote ? `> ${quote.authorId === 'user' ? userName : quote.authorName}:\n${messageText(quote).split(/\r?\n/).map((line) => `> ${line}`).join('\n')}\n\n${content}` : content
    const originalDraft = draft
    const originalMentions = [...selectedMentions.current]
    const offset = outgoing.length - content.length - (draft.length - draft.trimStart().length)
    const sendingMentions = originalMentions.map(mention => ({ ...mention, start: mention.start + offset, end: mention.end + offset }))
    const sendingImages = pendingImages
    const sendingImageIds = new Set(sendingImages.map((image) => image.id))
    setSending(true)
    try {
      const quotedImages = [...new Map((quote?.attachments ?? []).map(image => [image.id, image])).values()]
      if (quotedImages.length + sendingImages.length > MAX_PASTED_IMAGES) throw new Error(t('You can paste up to 4 images at a time.'))
      const references: MessageImageInput[] = await Promise.all(quotedImages.map(async attachment => {
        const url = await window.douchat.getAttachmentData(attachment.id)
        const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(url)
        if (!match) throw new Error(t('Image could not be loaded'))
        const data = Uint8Array.from(atob(match[2]), character => character.charCodeAt(0))
        return { name: attachment.name || 'quoted-image', mimeType: match[1] as MessageAttachment['mimeType'], data, quoted: true }
      }))
      const images: MessageImageInput[] = [...references, ...sendingImages.filter(image => !image.isFile).map(({ name, mimeType, data }) => ({ name, mimeType, data, quoted: false }))]
      if (images.some(image => image.data.length > MAX_PASTED_IMAGE_BYTES)) throw new Error(t('Each image must be 8 MB or smaller.'))
      if (images.reduce((sum, image) => sum + image.data.length, 0) + sendingImages.filter(image => image.isFile).reduce((sum, file) => sum + file.size, 0) > MAX_PASTED_IMAGE_TOTAL_BYTES) throw new Error(t('Images must total 20 MB or less.'))
      setDraft('')
      setPendingImages((current) => current.filter((image) => !sendingImageIds.has(image.id)))
      setMention(null)
      setAttachmentError('')
      setQuotedMessage(null)
      const files = sendingImages.filter(image => image.isFile).map(({ name, data }) => ({ name, data }))
      if (sendingMentions.length) await onSend(outgoing, images, files, sendingMentions)
      else if (files.length) await onSend(outgoing, images, files)
      else await onSend(outgoing, images)
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : t('Image could not be loaded'))
      setDraft(originalDraft)
      selectedMentions.current = originalMentions
      setQuotedMessage(quote)
      setPendingImages((current) => [
        ...sendingImages.filter((image) => !current.some((candidate) => candidate.id === image.id)),
        ...current
      ])
    } finally {
      setSending(false)
    }
  }

  const selectFiles = async (files: File[]): Promise<void> => {
    if (!files.length || readingFiles) return
    setReadingFiles(true)
    setAttachmentError('')
    const targetConversation = conversation?.id
    try {
      if (pendingImages.length + files.length > 4) throw new Error('一次最多发送 4 个附件。')
      if (pendingImages.reduce((sum, file) => sum + file.size, 0) + files.reduce((sum, file) => sum + file.size, 0) > MAX_PASTED_IMAGE_TOTAL_BYTES) throw new Error('附件总大小不能超过 20 MB。')
      const added = await Promise.all(files.map(async file => {
        if (!file.size) throw new Error('文件不能为空。')
        if (PASTED_IMAGE_TYPES.has(file.type as MessageAttachment['mimeType'])) {
          if (file.size > MAX_PASTED_IMAGE_BYTES) throw new Error(t('Each image must be 8 MB or smaller.'))
          return readPastedImage(file)
        }
        return { id: crypto.randomUUID(), name: file.name, size: file.size, data: new Uint8Array(await file.arrayBuffer()), mimeType: 'image/png' as const, previewUrl: '', isFile: true }
      }))
      if (selectedConversationRef.current === targetConversation) setPendingImages(current => [...current, ...added])
    } catch (error) {
      if (selectedConversationRef.current === targetConversation) setAttachmentError(error instanceof Error ? error.message : '文件读取失败。')
    } finally { setReadingFiles(false) }
  }

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const imageFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .flatMap((item) => item.getAsFile() ?? [])
    if (!imageFiles.length) return
    event.preventDefault()
    setAttachmentError('')
    if (imageFiles.some((file) => !PASTED_IMAGE_TYPES.has(file.type as MessageAttachment['mimeType']))) {
      setAttachmentError(t('Only PNG, JPEG, WebP, and GIF images are supported.'))
      return
    }
    if (imageFiles.some((file) => !file.size || file.size > MAX_PASTED_IMAGE_BYTES)) {
      setAttachmentError(t('Each image must be 8 MB or smaller.'))
      return
    }
    if (pendingImages.length + imageFiles.length > MAX_PASTED_IMAGES) {
      setAttachmentError(t('You can paste up to 4 images at a time.'))
      return
    }
    const total = pendingImages.reduce((sum, image) => sum + image.size, 0) + imageFiles.reduce((sum, file) => sum + file.size, 0)
    if (total > MAX_PASTED_IMAGE_TOTAL_BYTES) {
      setAttachmentError(t('Images must total 20 MB or less.'))
      return
    }
    void Promise.all(imageFiles.map(readPastedImage)).then((images) => {
      setPendingImages((current) => [...current, ...images])
    }).catch(() => setAttachmentError(t('Pasted image could not be read.')))
  }

  const removePendingImage = (id: string): void => {
    setPendingImages((current) => current.filter((image) => {
      if (image.id !== id) return true
      return false
    }))
    setAttachmentError('')
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Backspace' && !event.currentTarget.value && quotedMessage && !event.currentTarget.readOnly) {
      event.preventDefault()
      setQuotedMessage(null)
      setAttachmentError('')
      return
    }
    if (mention && mentionOptions.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setMentionIndex((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + mentionOptions.length) % mentionOptions.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        applyMention(mentionOptions[Math.min(mentionIndex, mentionOptions.length - 1)])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMention(null)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  if (!conversation) return (
    <main className="workspace empty-conversation" aria-label={t('No conversation selected')}>
      <img className="empty-conversation-mark" src={foundryLogo} alt="Foundry" draggable={false} />
    </main>
  )

  return (
    <FileConversationContext.Provider value={conversation.id}><main className="workspace">
      <header className="workspace-header window-drag">
        <div className="workspace-identity">
          <div>
            <button type="button" className="workspace-title no-drag" onClick={onToggleInspector}
              aria-label={`${t('Chat details')}: ${fullConversationName}`} title={fullConversationName} aria-expanded={inspectorOpen}>
              <strong>
                {conversationName || 'Foundry'}
                {conversation?.type === 'group' && conversationName === fullConversationName ? ` (${members.length + 1})` : ''}
              </strong>
            </button>
          </div>
        </div>
        <div className="workspace-header-actions no-drag">
          <button onClick={onToggleInspector} aria-label={t('Chat details')} title={t('Chat details')} aria-expanded={inspectorOpen}>
            <MoreHorizontal size={20} />
          </button>
        </div>
      </header>

      <div className="message-scroll" ref={scrollRef} onScroll={(event) => {
        const node = event.currentTarget
        nearBottom.current = node.scrollHeight - node.clientHeight - node.scrollTop < 64
        if (node.scrollTop < 80 && !initialScroll.current && !historyError) void loadOlder()
      }}>
        <div className="message-canvas" ref={canvasRef}>
          {hasMore && <button className="history-load" disabled={loadingHistory} onClick={() => void loadOlder()}>{t(loadingHistory ? 'Loading…' : historyError ? 'Retry loading earlier messages' : 'Load earlier messages')}</button>}
          {timelineGroups.map((messageGroup, index) => {
            const message = messageGroup[0]
            const previous = timelineGroups[index - 1]?.at(-1)
            const agent = agents.find((item) => item.id === message.authorId)
            const breaks = !previous || isDifferentDay(message, previous) || message.createdAt - previous.createdAt >= 300_000
            return (
              <div key={message.id} data-message-id={message.id} onContextMenu={(event) => {
                event.preventDefault()
                const id = (event.target as HTMLElement).closest('[data-message-id]')?.getAttribute('data-message-id')
                const target = messageGroup.find((item) => item.id === id) ?? message
                setMessageActionError('')
                setMessageMenu({ message: target, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 188)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 148)) })
              }}>
                {breaks && (
                  <div className="date-separator">
                    <span>{isDifferentDay(message, previous) ? `${dayLabel(message.createdAt)} ` : ''}{formatTime(message.createdAt)}</span>
                  </div>
                )}
                <MessageRow
                  messages={messageGroup}
                  agent={agent}
                  agents={agents}
                  relatedMessages={allMessages}
                  userName={userName}
                  userAvatar={userAvatar}
                  showAuthor={conversation?.type === 'group'}
                  onOpenAgentProfile={onOpenAgentProfile}
                  onOpenUserProfile={onOpenUserProfile}
                />
              </div>
            )
          })}
          {activity ? <ChatActivity activity={activity} agents={agents} /> : null}
          {activity?.takeover && (
            <div className="system-message">
              {tr('{name} is unavailable — {replacement} is standing in.', {
                name: activity.takeover.unavailableName,
                replacement: activity.takeover.replacementName
              })}
            </div>
          )}
        </div>
      </div>

      {messageMenu && <div ref={menuRef} className="context-menu" role="menu" aria-label={t('Message actions')} style={{ left: messageMenu.x, top: messageMenu.y }} onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const buttons = Array.from(event.currentTarget.querySelectorAll('button'))
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
          buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
        }
      }}>
        <button role="menuitem" onClick={() => {
          void copyMessage(messageMenu.message).catch(() => setMessageActionError(t('Could not copy message')))
          setMessageMenu(null)
        }}>{t('Copy')}</button>
        <button role="menuitem" onClick={() => {
          setQuotedMessage(messageMenu.message)
          setMessageMenu(null)
          textareaRef.current?.focus()
        }}>{t('Quote')}</button>
        <div className="dropdown-separator" role="separator" />
        <button role="menuitem" className="danger" onClick={() => {
          const target = messageMenu.message
          setMessageMenu(null)
          void window.douchat.deleteMessage(target.conversationId, target.id).then((deleted) => {
            if (!deleted) return
            setDeletedIds((current) => new Set([...current, target.id]))
            setHistory((current) => ({ ...current, messages: current.messages.filter((item) => item.id !== target.id) }))
            setQuotedMessage((current) => current?.id === target.id ? null : current)
          }).catch(() => setMessageActionError(t('Could not delete message')))
        }}>{t('Delete')}</button>
      </div>}
      <div className="composer-wrap">
        {messageActionError && <div className="composer-attachment-error" role="alert">{messageActionError}</div>}
        {offline && (
          <div className="offline-banner">
            <span>{t('Choose a local agent or connect a model endpoint to start chatting.')}</span>
            <button onClick={onConnect}>{t('Choose agent')}</button>
          </div>
        )}
        {mention && mentionOptions.length > 0 && (
          <div className="mention-menu" role="listbox" aria-label={t('Mention a member')}>
            <div className="mention-title">{t('Mention a member')}</div>
            {mentionOptions.map((option, index) => (
              <button
                key={option.id}
                role="option"
                aria-selected={index === mentionIndex}
                className={index === mentionIndex ? 'selected' : ''}
                onMouseEnter={() => setMentionIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => applyMention(option)}
              >
                {option.agent ? <AgentAvatar agent={option.agent} size={22} /> : <span className="mention-all"><AtSign size={13} /></span>}
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        )}
        {queuedMessages.length > 0 && <ol className="composer-queue" aria-label="待发送消息">
          {queuedMessages.map((item) => <li className={`composer-queue-item${item.error ? ' is-failed' : ''}`} key={item.id}>
            <ListEnd className="composer-queue-marker" size={15} aria-hidden="true" />
            <span className="composer-queue-copy"><span className="composer-queue-text" title={item.text}>{item.text}</span>{item.error && <small role="alert"><TriangleAlert size={13} /><span>{t(messageSendError(item.error))}</span></small>}</span>
            <button type="button" className="composer-queue-promote" title={item.error ? '重试发送' : '移到队首，当前回复结束后优先发送'} onClick={() => onPromoteQueued?.(item.id)}><CornerDownRight size={14} aria-hidden="true" /><span>{item.error ? '重试' : '优先发送'}</span></button>
            <button type="button" aria-label="移除排队消息" title="移除排队消息" onClick={() => onRemoveQueued?.(item.id)}><Trash2 size={15} /></button>
          </li>)}
        </ol>}
        <div className={`composer ${draft.trim() || pendingImages.length ? 'has-content' : ''}`}>
          {quotedMessage && <MessageQuote
            author={quotedMessage.authorId === 'user' ? userName : quotedMessage.authorName}
            text={messageText(quotedMessage)}
            attachments={quotedMessage.attachments}
            onCancel={() => setQuotedMessage(null)}
          />}
          {pendingImages.length > 0 && (
            <div className="composer-images" aria-label={t('Images ready to send')}>
              {pendingImages.map((image) => (
                <div className={image.isFile ? 'composer-file' : 'composer-image'} key={image.id}>
                  {image.isFile ? <><FileText size={28} aria-hidden="true" /><span className="composer-file-info"><strong title={image.name}>{image.name}</strong><small>{image.size < 1024 ? `${image.size} B` : image.size < 1024 * 1024 ? `${(image.size / 1024).toFixed(1)} KB` : `${(image.size / 1024 / 1024).toFixed(1)} MB`}</small></span></> : <img src={image.previewUrl} alt={image.name || t('Pasted image')} />}
                  <button type="button" onClick={() => removePendingImage(image.id)} aria-label={image.isFile ? '移除文件' : t('Remove image')} title={image.isFile ? '移除文件' : t('Remove image')}>
                    <X size={13} strokeWidth={2.2} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              trackMention(event.target.value, event.target.selectionStart)
            }}
            onKeyUp={(event) => trackMention(event.currentTarget.value, event.currentTarget.selectionStart)}
            onClick={(event) => trackMention(event.currentTarget.value, event.currentTarget.selectionStart)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={
              conversation
                ? tr(conversation.type === 'group' ? 'Message {name} · @ to mention' : 'Message {name}', { name: conversationName })
                : t('Create an agent to start chatting')
            }
            rows={2}
            disabled={!conversation}
            readOnly={voiceState !== 'idle'}
          />
          {attachmentError && <div className="composer-attachment-error" role="alert">{attachmentError}</div>}
          {SHOW_VOICE_INPUT && voiceError && (
            <div className="composer-voice-error" role="alert">
              <span>{voiceError}</span>
              {voiceNeedsSettings && (
                <button type="button" onClick={() => void window.douchat.openMicrophoneSettings()}>
                  {t('Open System Settings')}
                </button>
              )}
            </div>
          )}
          <div className="composer-bottom">
            <div className="composer-tools">
              <input ref={fileInputRef} type="file" multiple hidden onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void selectFiles(files) }} />
              <button type="button" className="emoji-toggle" disabled={voiceState !== 'idle'} onClick={() => setEmojiOpen((open) => !open)} aria-label={t('Emoji')} aria-expanded={emojiOpen}><Smile size={18} strokeWidth={2.1} /></button>
              <button type="button" className="emoji-toggle" title="发送文件" aria-label="发送文件" disabled={!conversation || readingFiles || sending || voiceState !== 'idle'} onClick={() => fileInputRef.current?.click()}>{readingFiles ? <LoaderCircle size={18} /> : <FolderOpen size={18} strokeWidth={2.1} />}</button>
              {SHOW_VOICE_INPUT && <button
                  type="button"
                  className={`voice-toggle is-${voiceState}`}
                  onClick={toggleVoiceInput}
                  aria-label={t(voiceState === 'idle' ? 'Start voice input' : 'Stop voice input')}
                  aria-pressed={voiceState !== 'idle'}
                  title={t(voiceState === 'idle' ? 'Voice input' : 'Stop voice input')}
                >
                  {voiceState === 'starting' || voiceState === 'processing'
                    ? <LoaderCircle className="voice-spinner" size={17} />
                    : <Mic size={18} strokeWidth={2.1} />}
                </button>}
              {SHOW_VOICE_INPUT && voiceState !== 'idle' && (
                <span className="voice-status" role="status">
                  {t(voiceState === 'listening' ? 'Listening…' : voiceState === 'starting' ? 'Starting microphone…' : 'Finishing voice input…')}
                </span>
              )}
              {conversation?.type === 'group' && <button className="emoji-toggle" aria-label={t('Mention a member')} onClick={() => {
                const next = `${draft}${draft && !draft.endsWith(' ') ? ' ' : ''}@`
                setDraft(next); trackMention(next, next.length); textareaRef.current?.focus()
              }} disabled={voiceState !== 'idle'}><AtSign size={18} strokeWidth={2.1} /></button>}
            </div>
            {emojiOpen && <div className="emoji-picker" aria-label={t('Choose an emoji')}>{['😀', '😂', '🥰', '👍', '🎉', '❤️', '🙏', '🤔'].map((emoji) => <button key={emoji} onClick={() => { setDraft((text) => text + emoji); setEmojiOpen(false); textareaRef.current?.focus() }}>{emoji}</button>)}</div>}
          <div className="composer-send-actions">
          {working && (
            <button className="stop-button" onClick={onStop} aria-label={t('Stop the current reply')} title={t('Stop')}>
              <Square size={13} fill="currentColor" />
            </button>
          )}
            {!working && <button
              className="send-button"
              onClick={() => void send()}
              disabled={sending || readingFiles || voiceState !== 'idle' || (!draft.trim() && !pendingImages.length && !quotedMessage)}
              aria-label={t('Send message')}
            >
              {t('Send')}
            </button>}
          </div>
          </div>
        </div>
      </div>
    </main></FileConversationContext.Provider>
  )
}
