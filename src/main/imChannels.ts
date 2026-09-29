import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import * as lark from '@larksuiteoapi/node-sdk'
import { downloadMedia, decryptWechatMedia, IMMediaError, MAX_IM_FILE_BYTES, type IMMedia, type IMReplyPart } from './imMedia'
import { startIMTyping } from './imTyping'
import { formatIMMessages, type IMFormattedMessage } from './imFormatting'
import type { IMChannel, IMConnectInput, IMLogin, IMLoginStatus, IMProvider } from '../shared/imChannels'

export interface RecordData {
  id: string; owner: string; agentId: string; provider: IMProvider; label: string
  token: string; remoteId?: string; appId?: string; baseURL?: string; peer?: string; pairingCode: string
  cursor?: string; seen: string[]
  inbox?: { id: string; raw: any; state: 'queued' | 'running'; receiptId?: string; receivedAt?: number }[]
}
/** Where channel bindings persist. The bot token belongs in the credential vault, the rest in FeltDB. */
export interface IMChannelStorage { load(): Promise<RecordData[]>; save(records: RecordData[]): Promise<void> }
interface Worker { arriving: Set<string>; abort: AbortController; close?: () => void; status: IMChannel['status']; error?: string; active: number; pending: (() => Promise<void>)[]; accepted: Set<string>; delivery: Promise<void>; typingCount: number; typingStop?: ReturnType<typeof startIMTyping>; typingBarrier?: Promise<void> }
interface Inbound { id: string; peer: string; text: string; context?: string; media?: () => Promise<IMMedia[]> }
const WECHAT = 'https://ilinkai.weixin.qq.com'
const quietLogger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} }
export function splitIMText(text: string, limit = 3500): string[] {
  const chars = Array.from(text)
  const parts: string[] = []
  for (let i = 0; i < chars.length; i += limit) parts.push(chars.slice(i, i + limit).join(''))
  return parts
}
export function wechatBaseURL(value?: string): string {
  const url = new URL(value || WECHAT)
  if (url.protocol !== 'https:' || !(url.hostname === 'ilinkai.weixin.qq.com' || url.hostname.endsWith('.ilinkai.weixin.qq.com')) || url.port || url.username || url.password) throw new Error('微信返回了无效的服务地址')
  return url.origin
}

/** Credentials never cross IPC. One cancellable transport per owner/contact/provider. */
export class IMChannelManager {
  private records: RecordData[] = []
  private workers = new Map<string, Worker>()
  private logins = new Map<string, { owner: string; agent: string; qr: string; expires: number }>()
  private owner = ''
  private storageError = false
  private generation = 0
  private connecting = new Set<string>()
  constructor(private storage: IMChannelStorage,
    private currentOwner: () => string, private hasAgent: (id: string) => boolean | Promise<boolean>,
    private reply: (agentId: string, thread: string, text: string, signal: AbortSignal, provider?: IMProvider, media?: IMMedia[], receiptId?: string) => Promise<IMReplyPart[]>,
    private request: typeof fetch = fetch,
    private received?: (agentId: string, thread: string, text: string, provider: IMProvider, messageId: string) => string | Promise<string>,
    private diagnostic?: (event: string, detail: string) => void) {}
  /** Durable before it resolves; callers await it so a receipt is never acknowledged ahead of its record. */
  private save(): Promise<void> {
    return this.storage.save(this.records)
  }
  async activate(): Promise<void> {
    this.stop()
    this.owner = this.currentOwner()
    this.records = []
    this.storageError = false
    if (!this.owner) return
    try {
      this.records = await this.storage.load()
    } catch (error) { this.storageError = true; throw error }
    for (const record of [...this.records]) if (await this.hasAgent(record.agentId)) this.start(record)
  }
  stop(): void {
    this.generation++
    for (const worker of this.workers.values()) { worker.abort.abort(); worker.close?.() }
    this.workers.clear(); this.logins.clear()
  }
  private async assert(agent: string): Promise<void> {
    if (this.storageError) throw new Error('无法读取渠道凭证，请检查系统钥匙串后重新登录')
    if (!this.owner || this.owner !== this.currentOwner() || !(await this.hasAgent(agent))) throw new Error('联系人不存在或账号已切换')
  }
  async list(agent: string): Promise<IMChannel[]> {
    await this.assert(agent)
    return this.records.filter(r => r.agentId === agent).map(r => {
      const worker = this.workers.get(r.id)
      return { agentId: agent, provider: r.provider, label: r.label, status: worker?.status ?? 'error', error: worker?.error,
        paired: Boolean(r.peer), ...(!r.peer ? { pairingCode: r.pairingCode } : {}) }
    })
  }
  async disconnect(agent: string, provider: IMProvider): Promise<void> {
    await this.assert(agent)
    const record = this.records.find(r => r.agentId === agent && r.provider === provider)
    if (!record) return
    const previous = this.records
    this.records = this.records.filter(r => r !== record)
    try { await this.save() } catch (error) { this.records = previous; throw error }
    const worker = this.workers.get(record.id)
    worker?.abort.abort(); worker?.close?.(); this.workers.delete(record.id)
    for (const [id, login] of this.logins) if (login.agent === agent) this.logins.delete(id)
  }
  private async commit(record: RecordData): Promise<void> {
    await this.assert(record.agentId)
    if (this.records.some(r => r.provider === record.provider && (r.appId || r.remoteId || r.label) === (record.appId || record.remoteId || record.label))) throw new Error('这个机器人已经绑定了联系人，请先断开原连接')
    if (this.records.some(r => r.agentId === record.agentId && r.provider === record.provider)) throw new Error('请先断开已有渠道')
    this.records.push(record)
    try { await this.save() } catch (error) { this.records.pop(); throw error }
    this.start(record)
  }
  async connect(agent: string, input: IMConnectInput): Promise<void> {
    await this.assert(agent)
    if (!input || !['telegram', 'feishu'].includes(input.provider)) throw new Error('请选择支持的渠道')
    const lock = `${this.owner}:${agent}:${input.provider}`
    if (this.connecting.has(lock)) throw new Error('正在连接，请稍候')
    this.connecting.add(lock)
    const generation = this.generation
    try {
      const secret = input.provider === 'telegram' ? input.token : input.appSecret
      const token = typeof secret === 'string' ? secret.trim() : ''
      if (!token || token.length > 500) throw new Error('请输入有效的机器人凭证')
      const record: RecordData = { id: randomUUID(), owner: this.owner, agentId: agent, provider: input.provider, token,
        appId: typeof input.appId === 'string' ? input.appId.trim() : undefined, label: '', pairingCode: randomBytes(8).toString('hex'), seen: [] }
      if (record.provider === 'telegram') {
        if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Bot Token 格式不正确')
        const me = await this.telegram(record, 'getMe', {})
        if (!me?.id || !me.username) throw new Error('Telegram 未返回有效机器人信息')
        record.remoteId = String(me.id)
        record.label = '@' + me.username
        const hook = await this.telegram(record, 'getWebhookInfo', {})
        if (hook.url) throw new Error('该机器人已配置 Webhook，请先在原服务中解除后再连接')
      } else {
        if (!record.appId || !/^cli_[0-9a-fA-F]{16}$/.test(record.appId)) throw new Error('请输入有效的 App ID')
        await this.json('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { app_id: record.appId, app_secret: token })
        record.label = record.appId
      }
      if (generation !== this.generation) throw new Error('账号已切换，请重新连接')
      await this.commit(record)
    } finally { this.connecting.delete(lock) }
  }
  async login(agent: string): Promise<IMLogin> {
    await this.assert(agent)
    const generation = this.generation
    const data = await this.json(WECHAT + '/ilink/bot/get_bot_qrcode?bot_type=3')
    await this.assert(agent)
    if (generation !== this.generation) throw new Error('账号已切换')
    if (!data.qrcode || !data.qrcode_img_content) throw new Error('获取微信二维码失败')
    for (const [id, login] of this.logins) if (login.agent === agent || login.expires < Date.now()) this.logins.delete(id)
    const sessionId = randomUUID()
    this.logins.set(sessionId, { owner: this.owner, agent, qr: data.qrcode, expires: Date.now() + 240_000 })
    return { sessionId, qr: data.qrcode_img_content }
  }
  cancelLogin(agent: string, sessionId: string): void {
    const login = this.logins.get(sessionId)
    if (login?.owner === this.currentOwner() && login.agent === agent) this.logins.delete(sessionId)
  }
  async loginStatus(agent: string, sessionId: string): Promise<IMLoginStatus> {
    await this.assert(agent)
    const login = this.logins.get(sessionId)
    if (!login || login.owner !== this.owner || login.agent !== agent || login.expires < Date.now()) return { status: 'expired' }
    const data = await this.json(WECHAT + '/ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(login.qr))
    await this.assert(agent)
    if (this.logins.get(sessionId) !== login) return { status: 'expired' }
    if (data.status === 'confirmed') {
      if (!data.bot_token || !data.ilink_bot_id) throw new Error('微信未返回有效凭证，请重新扫码')
      await this.commit({ id: randomUUID(), owner: this.owner, agentId: agent, provider: 'wechat', label: data.ilink_bot_id,
        token: data.bot_token, baseURL: wechatBaseURL(data.baseurl), pairingCode: randomBytes(8).toString('hex'), seen: [] })
      this.logins.delete(sessionId)
    } else if (data.status === 'expired') this.logins.delete(sessionId)
    return { status: ['confirmed', 'expired', 'scaned'].includes(data.status) ? data.status : 'wait' }
  }
  private async json(url: string, body?: unknown, headers?: Record<string, string>, signal?: AbortSignal): Promise<any> {
    const response = await this.request(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(45000), ...(signal ? [signal] : [])]) })
    if (!response.ok) throw new Error(`渠道请求失败（HTTP ${response.status}），请检查凭证和网络`)
    const data = await response.json() as any
    if (data.ok === false || (data.code && data.code !== 0) || (data.ret && data.ret !== 0 && data.errcode !== -14) || (data.errcode && data.errcode !== -14)) throw new Error('渠道拒绝请求，请检查凭证、机器人权限和订阅配置')
    return data
  }
  private async telegram(r: RecordData, method: string, body: unknown, signal?: AbortSignal): Promise<any> {
    return (await this.json(`https://api.telegram.org/bot${r.token}/${method}`, body, undefined, signal)).result
  }
  private wechat(r: RecordData, path: string, body: object, signal?: AbortSignal): Promise<any> {
    return this.json(wechatBaseURL(r.baseURL) + '/ilink/bot/' + path, { ...body, base_info: { channel_version: '1.0.0' } },
      { AuthorizationType: 'ilink_bot_token', Authorization: `Bearer ${r.token}`, 'X-WECHAT-UIN': Buffer.from('123456789').toString('base64') }, signal)
  }
  private live(r: RecordData, worker: Worker): boolean {
    return !worker.abort.signal.aborted && this.owner === r.owner && this.currentOwner() === r.owner && this.workers.get(r.id) === worker
  }
  private start(r: RecordData): void {
    const worker: Worker = { arriving: new Set(), abort: new AbortController(), status: 'connecting', active: 0, pending: [], accepted: new Set(), delivery: Promise.resolve(), typingCount: 0 }
    this.workers.set(r.id, worker)
    if (r.provider === 'feishu') {
      const client = new lark.Client({ appId: r.appId!, appSecret: r.token, logger: quietLogger })
      const connected = () => { if (this.live(r, worker)) { worker.status = 'connected'; worker.error = undefined } }
      const ws = new lark.WSClient({ appId: r.appId!, appSecret: r.token, logger: quietLogger,
        onReady: connected, onReconnected: connected,
        onReconnecting: () => { if (this.live(r, worker)) { worker.status = 'connecting'; worker.error = '飞书连接中断，正在重连' } },
        onError: () => { if (this.live(r, worker)) { worker.status = 'error'; worker.error = '飞书连接失败，请检查凭证和长连接订阅配置' } }
      })
      worker.close = () => ws.close({ force: true })
      for (const entry of r.inbox ?? []) this.background(r, worker, this.acceptFeishu(r, worker, client, entry.raw))
      void ws.start({ eventDispatcher: new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async data => {
          await this.acceptFeishu(r, worker, client, data)
        }
      }) }).then(() => { if (!this.live(r, worker)) ws.close({ force: true }) }).catch(() => { worker.status = 'error'; worker.error = '飞书连接失败，请检查网络和长连接订阅配置' })
    } else {
      for (const entry of r.inbox ?? []) {
        this.background(r, worker, r.provider === 'telegram' ? this.acceptTelegram(r, worker, entry.raw) : this.acceptWechat(r, worker, entry.raw))
      }
      void this.poll(r, worker)
    }
  }
  private async acceptFeishu(r: RecordData, worker: Worker, client: lark.Client, data: any): Promise<void> {
    const m = data.message
    if (m.chat_type !== 'p2p' || data.sender.sender_type !== 'user') return
    let content: { text?: string; image_key?: string; file_key?: string; file_name?: string } = {}
    try { content = JSON.parse(m.content) } catch { return }
    let reactionId: string | undefined
    await this.enqueue(r, worker, { id: m.message_id, peer: m.chat_id, text: m.message_type === 'text' ? content.text ?? '' : '',
      ...(['image', 'file'].includes(m.message_type) ? { media: async () => {
        // Fetch through our bounded, cancellable downloader rather than an unbounded SDK buffer.
        const signal = AbortSignal.any([worker.abort.signal, AbortSignal.timeout(45000)])
        const auth = await this.json('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { app_id: r.appId, app_secret: r.token }, undefined, signal)
        const key = m.message_type === 'image' ? content.image_key : content.file_key
        if (!key) throw new IMMediaError('附件信息不完整，请重新发送。')
        const url = `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(m.message_id)}/resources/${encodeURIComponent(key)}?type=${m.message_type}`
        const data = await downloadMedia(this.request, url, signal, { Authorization: `Bearer ${auth.tenant_access_token}` })
        return [{ name: content.file_name || 'image', data, image: m.message_type === 'image' }]
      } } : {}) }, async (text, formatted) => {
      const rich = Boolean(formatted?.entities.length)
      const result = await client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: m.chat_id, msg_type: rich ? 'post' : 'text', content: JSON.stringify(rich ? formatted!.post : { text }) } })
      if (result.code) throw new Error('飞书发送失败，请检查 im:message:send_as_bot 权限')
    }, () => startIMTyping(worker.abort.signal, async () => {
      const result = await client.im.messageReaction.create({ path: { message_id: m.message_id }, data: { reaction_type: { emoji_type: 'Typing' } } })
      if (!result.code) reactionId = result.data?.reaction_id
    }, async () => {
      if (reactionId) await client.im.messageReaction.delete({ path: { message_id: m.message_id, reaction_id: reactionId } })
    }, 0), data)
  }
  private async acceptTelegram(r: RecordData, worker: Worker, update: any): Promise<void> {
    const signal = worker.abort.signal
    const m = update.message
    if (m && m.chat?.type === 'private' && !m.from?.is_bot) await this.enqueue(r, worker,
      { id: String(update.update_id), peer: String(m.chat.id), text: m.text ?? m.caption ?? '',
        ...(m.photo?.length || m.document ? { media: async () => {
          const file = m.document ?? m.photo[m.photo.length - 1]
          if (file.file_size > MAX_IM_FILE_BYTES) throw new IMMediaError('附件超过 20 MB，请压缩或拆分后重发。')
          const timed = AbortSignal.any([signal, AbortSignal.timeout(45000)])
          const result = await this.telegram(r, 'getFile', { file_id: file.file_id }, timed)
          if (typeof result.file_path !== 'string' || !/^[\w/.-]+$/.test(result.file_path) || result.file_path.split('/').includes('..')) throw new IMMediaError('附件地址无效，请重新发送。')
          const data = await downloadMedia(this.request, `https://api.telegram.org/file/bot${r.token}/${result.file_path}`, timed)
          return [{ name: file.file_name || 'image.jpg', data, image: !m.document }]
        } } : {}) },
      (text, formatted) => this.telegram(r, 'sendMessage', { chat_id: m.chat.id, text, ...(formatted?.entities.length ? { entities: formatted.entities } : {}) }, signal), undefined, update)
  }
  private async acceptWechat(r: RecordData, worker: Worker, m: any): Promise<void> {
    const signal = worker.abort.signal
    if (m.message_type !== 1 || m.message_state !== 2) return
    const text = (m.item_list ?? []).map((item: any) => item.type === 1 ? item.text_item?.text : item.type === 3 ? item.voice_item?.text : '').filter(Boolean).join('\n')
    await this.enqueue(r, worker, { id: String(m.message_id ?? m.seq ?? ''), peer: m.from_user_id, text, context: m.context_token,
      ...((m.item_list ?? []).some((i: any) => i.type === 2 || i.type === 4) ? { media: async () => {
        const items = m.item_list.filter((i: any) => i.type === 2 || i.type === 4)
        if (items.length > 4) throw new IMMediaError('一次最多发送 4 个附件，请分批发送。')
        const files: IMMedia[] = []
        for (const item of items) {
          const file = item.type === 2 ? item.image_item : item.file_item
          const media = file?.media
          if (!media?.encrypt_query_param && !media?.full_url) throw new IMMediaError('附件信息不完整，请重新发送。')
          const url = new URL(media.full_url || `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`)
          if (url.protocol !== 'https:' || url.hostname !== 'novac2c.cdn.weixin.qq.com' || url.port || url.username || url.password) throw new IMMediaError('微信附件地址无效，请重新发送。')
          const data = await downloadMedia(this.request, url.href, AbortSignal.any([signal, AbortSignal.timeout(45000)]))
          files.push({ name: file.file_name || 'image', image: item.type === 2, data: item.type === 2 && !media.aes_key && !file.aeskey ? data : decryptWechatMedia(data, media.aes_key, file.aeskey) })
        }
        return files
      } } : {}) },
      text => this.wechat(r, 'sendmessage', { msg: { from_user_id: r.label, to_user_id: m.from_user_id, client_id: randomUUID(), message_type: 2, message_state: 2,
        context_token: m.context_token, item_list: [{ type: 1, text_item: { text } }] } }, signal), undefined, m)
  }
  /** Work started outside a request (replaying saved messages) has no caller to report to. */
  private background(r: RecordData, worker: Worker, work: Promise<void>): void {
    work.catch(() => {
      if (this.live(r, worker)) { worker.status = 'error'; worker.error = '消息处理失败，请检查本机存储后重新连接渠道' }
    })
  }
  private drain(r: RecordData, worker: Worker): void {
    while (this.live(r, worker) && worker.active < 4 && worker.pending.length) {
      const task = worker.pending.shift()!
      worker.active++
      void task().catch(() => {
        if (this.live(r, worker)) { worker.status = 'error'; worker.error = '消息处理或发送失败，请检查网络后重试；已执行的任务不会自动重复执行' }
      }).finally(() => { worker.active--; this.drain(r, worker) })
    }
  }
  private acquireTyping(r: RecordData, worker: Worker, message: Inbound): () => Promise<void> {
    worker.typingCount++
    // One indicator per chat: finishing one concurrent task must not clear another's status.
    const start = () => {
      if (worker.typingCount && !worker.typingStop && this.live(r, worker)) worker.typingStop = this.typing(r, worker, message)
    }
    if (worker.typingBarrier) void worker.typingBarrier.then(start)
    else start()
    let released = false
    return () => {
      if (released) return worker.typingBarrier ?? Promise.resolve()
      released = true
      if (--worker.typingCount === 0 && worker.typingStop) {
        const barrier = worker.typingStop()
        worker.typingBarrier = barrier
        void barrier.finally(() => { if (worker.typingBarrier === barrier) worker.typingBarrier = undefined })
        worker.typingStop = undefined
      }
      return worker.typingBarrier ?? Promise.resolve()
    }
  }
  private async enqueue(r: RecordData, worker: Worker, message: Inbound, send: (text: string, formatted?: IMFormattedMessage) => Promise<void>, typing: (() => () => Promise<void>) | undefined, raw: any): Promise<void> {
    if (!this.live(r, worker) || !message.id || !message.peer || worker.accepted.has(message.id) || worker.arriving.has(message.id)) return
    // The same message can arrive twice while its receipt is still being written.
    worker.arriving.add(message.id)
    try { await this.receive(r, worker, message, send, typing, raw) } finally { worker.arriving.delete(message.id) }
  }
  private async receive(r: RecordData, worker: Worker, message: Inbound, send: (text: string, formatted?: IMFormattedMessage) => Promise<void>, typing: (() => () => Promise<void>) | undefined, raw: any): Promise<void> {
    const saved = r.inbox?.find(entry => entry.id === message.id)
    if (!saved && r.seen.includes(message.id)) return
    // Persist receipt before advancing the polling cursor or running any tools.
    if (!saved) {
      r.seen = [...r.seen.slice(-499), message.id]
      if (!r.peer) {
        const paired = message.text.trim() === `/pair ${r.pairingCode}`
        if (paired) { r.peer = message.peer; r.pairingCode = '' }
        await this.save()
        void send(paired ? '配对成功，可以开始给这个联系人发消息了。' :
          (/^\/pair(?:\s|$)/.test(message.text.trim()) ? '配对指令无效。' : '还未配对，暂时无法聊天。') + '请在 Douchat 中打开对应联系人的「消息渠道」，复制配对指令并发送到当前私信，完成绑定后即可聊天。').catch(() => {})
        return
      }
      if (message.peer !== r.peer) { await this.save(); return }
    }
    if (message.peer !== r.peer) return
    const entry = saved ?? { id: message.id, raw, state: 'queued' as const, receiptId: undefined as string | undefined, receivedAt: Date.now() }
    if (!saved) { (r.inbox ??= []).push(entry); await this.save() }
    // Receipt IDs are deterministic, so recovery between these writes cannot duplicate the desktop message.
    entry.receiptId ??= await this.received?.(r.agentId, r.id, message.text, r.provider, message.id)
    await this.save()
    worker.accepted.add(message.id)
    this.diagnostic?.('im.received', JSON.stringify({ provider: r.provider, channel: r.id, message: message.id, pending: worker.pending.length, active: worker.active }))
    const stopTyping = (message.text.trim() || message.media) ? (typing ? typing() : this.acquireTyping(r, worker, message)) : undefined
    const interrupted = entry.state === 'running'
    worker.pending.push(async () => {
      if (!this.live(r, worker)) return
      try {
        if (interrupted) {
          await send('上一条任务的回复未完成回传，操作可能已执行。请在 Douchat 检查结果后再决定是否重发。')
          return
        }

        let bubbles: IMReplyPart[] = ['支持文字、图片和文件，请使用这些消息类型发送。']
        if (message.text.trim() || message.media) {
          try {
            let media: IMMedia[] | undefined
            try { media = message.media ? await message.media() : undefined }
            catch (error) {
              if (error instanceof IMMediaError) throw error
              throw new IMMediaError('附件下载失败，请检查渠道权限或网络后重新发送。')
            }
            if (!this.live(r, worker)) return
            entry.state = 'running'; await this.save()
            this.diagnostic?.('im.processing', JSON.stringify({ provider: r.provider, channel: r.id, message: message.id, waitMs: Date.now() - (entry.receivedAt ?? Date.now()) }))
            bubbles = await this.reply(r.agentId, r.id, message.text, worker.abort.signal, r.provider, media, entry.receiptId)
          }
          catch (error) { bubbles = error instanceof IMMediaError ? [error.message] : ['联系人暂时无法回复，请在 Douchat 检查模型配置、运行状态或权限请求后重试。'] }
        }
        // Stop refreshing before delivery, so Telegram cannot re-show typing after a reply.
        void stopTyping?.()
        // Deliver each completed answer as a group of bubbles; model work and polling stay concurrent.
        const delivery = worker.delivery.catch(() => {}).then(async () => {
          const nonempty = bubbles.filter(part => typeof part !== 'string' || part.trim())
          for (const bubble of nonempty.length ? nonempty : ['任务已完成。']) {
            if (!this.live(r, worker)) return
            if (typeof bubble !== 'string') {
              try { await this.sendImage(r, worker, message, bubble.image) }
              catch {
                if (!this.live(r, worker)) return
                await send('图片已生成，但发送失败。请在 Douchat 查看图片，并检查渠道权限或网络。')
                worker.error = '图片发送失败，已保留桌面会话中的图片'; worker.status = 'error'
                return
              }
            } else for (const part of formatIMMessages(bubble, 3500, r.provider === 'wechat')) {
              if (!this.live(r, worker)) return
              await send(part.text, part)
            }
          }
        })
        worker.delivery = delivery.catch(() => {})
        await delivery
        // Sending a reply can clear the platform indicator even when other work remains.
        if (worker.typingCount) worker.typingStop?.refresh()
      } finally {
        // Feishu reactions belong to this message; late cleanup cannot affect the next one.
        void stopTyping?.()
        if (this.live(r, worker)) {
          this.diagnostic?.('im.finished', JSON.stringify({ provider: r.provider, channel: r.id, message: message.id, elapsedMs: Date.now() - (entry.receivedAt ?? Date.now()) }))
          worker.accepted.delete(message.id)
          r.inbox = (r.inbox ?? []).filter(item => item !== entry)
          await this.save()
        }
      }
    })
    this.drain(r, worker)
  }
  private async sendImage(r: RecordData, worker: Worker, message: Inbound, image: { name: string; mimeType: string; data: Uint8Array }): Promise<void> {
    const signal = AbortSignal.any([worker.abort.signal, AbortSignal.timeout(60000)])
    const assertLive = () => { signal.throwIfAborted(); if (!this.live(r, worker)) throw new Error('Channel disconnected') }
    const multipart = async (url: string, form: FormData, token?: string): Promise<any> => {
      assertLive()
      const response = await this.request(url, { method: 'POST', body: form, redirect: 'error', signal,
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) })
      if (!response.ok) throw new Error('Image upload failed')
      const result = await response.json() as any
      if (result.ok === false || result.code) throw new Error('Image upload rejected')
      assertLive()
      return result
    }
    assertLive()
    if (r.provider === 'telegram') {
      const form = new FormData()
      form.set('chat_id', message.peer)
      // Telegram does not accept WebP/GIF as sendPhoto input; retain the original as a document.
      const photo = image.mimeType === 'image/png' || image.mimeType === 'image/jpeg'
      form.set(photo ? 'photo' : 'document', new Blob([new Uint8Array(image.data)], { type: image.mimeType }), image.name || 'image.png')
      await multipart(`https://api.telegram.org/bot${r.token}/${photo ? 'sendPhoto' : 'sendDocument'}`, form)
    } else if (r.provider === 'feishu') {
      const auth = await this.json('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { app_id: r.appId, app_secret: r.token }, undefined, signal)
      const form = new FormData(); form.set('image_type', 'message')
      form.set('image', new Blob([new Uint8Array(image.data)], { type: image.mimeType }), image.name || 'image.png')
      const uploaded = await multipart('https://open.feishu.cn/open-apis/im/v1/images', form, auth.tenant_access_token)
      if (!uploaded.data?.image_key) throw new Error('Missing image key')
      assertLive()
      await this.json('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
        receive_id: message.peer, msg_type: 'image', content: JSON.stringify({ image_key: uploaded.data.image_key })
      }, { Authorization: `Bearer ${auth.tenant_access_token}` }, signal)
    } else {
      const data = Buffer.from(image.data), key = randomBytes(16), filekey = randomBytes(16).toString('hex')
      const cipher = createCipheriv('aes-128-ecb', key, null)
      const encrypted = Buffer.concat([cipher.update(data), cipher.final()])
      const upload = await this.wechat(r, 'getuploadurl', { filekey, media_type: 1, to_user_id: message.peer,
        rawsize: data.length, rawfilemd5: createHash('md5').update(data).digest('hex'), filesize: encrypted.length,
        no_need_thumb: true, aeskey: key.toString('hex') }, signal)
      if (!upload.upload_full_url && !upload.upload_param) throw new Error('Missing upload URL')
      const url = new URL(upload.upload_full_url || `https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${filekey}`)
      if (url.protocol !== 'https:' || url.hostname !== 'novac2c.cdn.weixin.qq.com' || url.port || url.username || url.password) throw new Error('Invalid upload URL')
      assertLive()
      const response = await this.request(url.href, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: encrypted, redirect: 'error', signal })
      const param = response.headers.get('x-encrypted-param')
      if (!response.ok || !param) throw new Error('Image upload failed')
      assertLive()
      await this.wechat(r, 'sendmessage', { msg: { from_user_id: r.label, to_user_id: message.peer, client_id: randomUUID(), message_type: 2, message_state: 2,
        context_token: message.context, item_list: [{ type: 2, image_item: { media: { encrypt_query_param: param,
          aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 }, mid_size: encrypted.length } }] } }, signal)
    }
  }
  private typing(r: RecordData, worker: Worker, message: Inbound): ReturnType<typeof startIMTyping> {
    let ticket: string | undefined
    const signal = () => AbortSignal.any([worker.abort.signal, AbortSignal.timeout(3000)])
    return startIMTyping(worker.abort.signal, async () => {
      if (!this.live(r, worker)) return
      if (r.provider === 'telegram') {
        await this.telegram(r, 'sendChatAction', { chat_id: message.peer, action: 'typing' }, signal())
      } else {
        if (!ticket) {
          const config = await this.wechat(r, 'getconfig', { ilink_user_id: message.peer, context_token: message.context }, signal())
          ticket = config.typing_ticket
        }
        if (ticket && this.live(r, worker)) await this.wechat(r, 'sendtyping', { ilink_user_id: message.peer, typing_ticket: ticket, status: 1 }, signal())
      }
    }, async () => {
      // Cancellation needs its own timeout: the worker may already be aborted.
      if (ticket) await this.wechat(r, 'sendtyping', { ilink_user_id: message.peer, typing_ticket: ticket, status: 2 }, AbortSignal.timeout(3000))
    })
  }
  private async poll(r: RecordData, worker: Worker): Promise<void> {
    let failures = 0; let expired = 0
    const signal = worker.abort.signal
    while (this.live(r, worker)) {
      try {
        let received = false
        if (r.provider === 'telegram') {
          const updates = await this.telegram(r, 'getUpdates', { offset: Number(r.cursor || 0), timeout: 30, allowed_updates: ['message'] }, signal)
          if (!this.live(r, worker)) return
          received = updates.length > 0
          for (const update of updates) {
            await this.acceptTelegram(r, worker, update)
            if (!this.live(r, worker)) return
            r.cursor = String(update.update_id + 1); await this.save()
          }
        } else {
          const data = await this.wechat(r, 'getupdates', { get_updates_buf: r.cursor || '' }, signal)
          if (!this.live(r, worker)) return
          if (data.errcode === -14) {
            if (r.cursor) { r.cursor = ''; expired = 0; await this.save() } else expired++
            if (expired >= 20) { worker.status = 'error'; worker.error = '微信登录已失效，请断开后重新扫码'; return }
            throw new Error('微信会话正在恢复')
          }
          expired = 0
          received = Boolean(data.msgs?.length)
          for (const m of data.msgs ?? []) {
            await this.acceptWechat(r, worker, m)
          }
          if (!this.live(r, worker)) return
          if (data.get_updates_buf) { r.cursor = data.get_updates_buf; await this.save() }
        }
        failures = 0; worker.status = worker.error ? 'error' : 'connected'
        if (!received) await delay(200, undefined, { signal })
      } catch {
        if (!this.live(r, worker)) return
        worker.status = 'error'; worker.error = '连接暂时中断，正在自动重试；请检查网络和凭证'
        try { await delay(Math.min(60000, 3000 * 2 ** Math.min(failures++, 5)), undefined, { signal }) } catch { return }
        worker.error = undefined
      }
    }
  }
}
