import type { IMMedia, IMReplyPart } from './imMedia'
import type { DouchatRuntime } from './runtime'
import type { DesktopRepository } from './desktopRepository'

/** All transports share the contact's direct conversation and model context. */
export async function replyToIM(store: DesktopRepository, runtime: DouchatRuntime, agent: string, thread: string, text: string, signal: AbortSignal, provider?: string, media?: IMMedia[], receiptId?: string): Promise<IMReplyPart[]> {
  if (signal.aborted) throw new Error('Channel disconnected')
  const conversation = await store.ensureIMConversation(agent)
  return runtime.sendIMMessage(conversation.id, agent, text, signal, provider === 'wechat' || provider === 'feishu' || provider === 'telegram' ? provider : undefined, media, receiptId)
}
