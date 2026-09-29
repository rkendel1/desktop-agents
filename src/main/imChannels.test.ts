import type { IMReplyPart } from './imMedia'
import { createCipheriv, createDecipheriv } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialVault } from './credentialVault'
import { FeltIMChannelStorage } from './imChannelStorage'
import { createTestDesktop } from './testSupport'
import { afterEach, describe, expect, it, vi } from 'vitest'
const sdk = vi.hoisted(() => ({ callbacks: {} as any, handler: undefined as any, send: vi.fn(), addReaction: vi.fn(), deleteReaction: vi.fn(), close: vi.fn() }))
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { im = { message: { create: sdk.send }, messageReaction: { create: sdk.addReaction, delete: sdk.deleteReaction } } },
  WSClient: class { constructor(options: any) { sdk.callbacks = options } start({ eventDispatcher }: any) { sdk.handler = eventDispatcher['im.message.receive_v1']; return Promise.resolve() } close = sdk.close },
  EventDispatcher: class { register(handlers: any) { return handlers } }
}))
import { IMChannelManager, splitIMText, wechatBaseURL } from './imChannels'
const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.clearAllMocks() })
async function setup() {
  const desktop = await createTestDesktop()
  const directory = mkdtempSync(join(tmpdir(), 'douchat-im-'))
  const updates: any[] = []; const wechatUpdates: any[] = []; const sent: any[] = []
  const reply = vi.fn(async (_agent: string, _thread: string, text: string): Promise<IMReplyPart[]> => ['Reply: ' + text])
  const fetcher = vi.fn(async (url: any, options: any) => {
    const body = options.body ? JSON.parse(options.body) : undefined
    let data: any
    if (url.endsWith('/getMe')) data = { ok: true, result: { id: 123, username: options.body === '{}' ? 'test_bot' : 'other_bot' } }
    else if (url.endsWith('/getWebhookInfo')) data = { ok: true, result: { url: '' } }
    else if (url.endsWith('/sendChatAction')) data = { ok: true, result: true }
    else if (url.endsWith('/getconfig')) data = { ret: 0, typing_ticket: 'typing-ticket' }
    else if (url.endsWith('/sendtyping')) data = { ret: 0 }
    else if (url.endsWith('/getUpdates')) data = { ok: true, result: updates.splice(0) }
    else if (url.endsWith('/sendMessage')) { sent.push(body); data = { ok: true, result: {} } }
    else if (url.includes('get_bot_qrcode')) data = { qrcode: 'qr-id', qrcode_img_content: 'https://wechat.example/scan' }
    else if (url.includes('get_qrcode_status')) data = { status: 'confirmed', bot_token: 'private-wechat-token', ilink_bot_id: 'bot@im.bot', baseurl: 'https://ilinkai.weixin.qq.com' }
    else if (url.endsWith('/getupdates')) data = { ret: 0, msgs: wechatUpdates.splice(0), get_updates_buf: 'cursor-1' }
    else if (url.endsWith('/sendmessage')) { sent.push(body); data = { ret: 0 } }
    else if (url.includes('tenant_access_token')) data = { code: 0, tenant_access_token: 'tenant' }
    else throw new Error('Unexpected request')
    return { ok: true, json: async () => data } as Response
  }) as unknown as typeof fetch
  const codec = { encrypt: (value: string) => Buffer.from(value).toString('base64'), decrypt: (value: string) => Buffer.from(value, 'base64').toString() }
  const received = vi.fn((_agent: string, _thread: string, _text: string, _provider: string, id: string) => `receipt:${id}`)
  const vault = new CredentialVault(directory, { available: () => true, ...codec })
  const storage = new FeltIMChannelStorage(desktop.repository, vault)
  const manager = new IMChannelManager(storage, () => 'local', id => ['agent-a', 'agent-b'].includes(id), reply, fetcher, received)
  await manager.activate()
  cleanup.push(async () => { manager.stop(); await desktop.dispose(); rmSync(directory, { recursive: true, force: true }) })
  return { manager, reply, received, fetcher, sent, updates, wechatUpdates, directory, desktop, vault }
}
const tg = (id: number, text: string, peer = 12) => ({ update_id: id, message: { text, from: { is_bot: false }, chat: { id: peer, type: 'private' } } })
const wx = (id: number, text: string) => ({ message_id: id, from_user_id: 'wx-owner', message_type: 1, message_state: 2, context_token: 'reply-context', item_list: [{ type: 1, text_item: { text } }] })

describe('IM channels', () => {
  it.each(['telegram', 'wechat', 'feishu'] as const)('receives images and documents through %s only after pairing', async provider => {
    const { manager, updates, wechatUpdates, reply, fetcher, sent } = await setup()
    sdk.send.mockResolvedValue({ code: 0 })
    sdk.addReaction.mockResolvedValue({ code: 0 })
    const original = vi.mocked(fetcher).getMockImplementation()!
    const bytes = Buffer.from('89504e470d0a1a0a', 'hex')
    const key = Buffer.alloc(16, 7)
    const cipher = createCipheriv('aes-128-ecb', key, null)
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()])
    const downloads: string[] = []
    vi.mocked(fetcher).mockImplementation(async (url, init) => {
      const address = String(url)
      if (address.endsWith('/getFile')) return Response.json({ ok: true, result: { file_path: 'documents/test.png' } })
      if (address.includes('/file/bot') || address.includes('/resources/') || address.includes('/c2c/download')) {
        downloads.push(address)
        return new Response(provider === 'wechat' ? encrypted : bytes)
      }
      return original(url, init)
    })
    if (provider === 'wechat') {
      const login = await manager.login('agent-a'); await manager.loginStatus('agent-a', login.sessionId)
    } else await manager.connect('agent-a', provider === 'telegram' ? { provider, token: '123:secret' }
      : { provider, appId: 'cli_0123456789abcdef', appSecret: 'secret' })
    const deliver = async (id: number, kind: 'image' | 'file' | 'text', text = '') => {
      if (provider === 'telegram') {
        const message: any = tg(id, text)
        if (kind === 'image') { delete message.message.text; message.message.caption = text; message.message.photo = [{ file_id: 'small' }, { file_id: 'large' }] }
        if (kind === 'file') message.message.document = { file_id: 'file', file_name: 'report.txt' }
        updates.push(message)
      } else if (provider === 'wechat') {
        const message: any = wx(id, text)
        const media = { encrypt_query_param: 'query', aes_key: key.toString('base64') }
        if (kind !== 'text') message.item_list.push(kind === 'image' ? { type: 2, image_item: { media } } : { type: 4, file_item: { media, file_name: 'report.txt' } })
        wechatUpdates.push(message)
      } else await sdk.handler({ sender: { sender_type: 'user' }, message: { message_id: String(id), chat_id: 'private', chat_type: 'p2p', message_type: kind,
        content: JSON.stringify(kind === 'text' ? { text } : kind === 'image' ? { image_key: 'image' } : { file_key: 'file', file_name: 'report.txt' }) } })
    }
    const sentCount = () => provider === 'feishu' ? sdk.send.mock.calls.length : sent.length
    await deliver(1, 'image')
    await vi.waitFor(() => expect(sentCount()).toBe(1))
    expect(downloads).toEqual([])
    await deliver(2, 'text', `/pair ${(await manager.list('agent-a'))[0].pairingCode}`)
    await vi.waitFor(() => expect(sentCount()).toBe(2))
    await deliver(3, 'image', 'describe')
    await deliver(4, 'file')
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(2))
    const calls = reply.mock.calls as unknown as any[][]
    expect(calls[0][5][0]).toMatchObject({ image: true, data: bytes })
    expect(calls[1][5][0]).toMatchObject({ image: false, name: 'report.txt', data: bytes })
    if (provider !== 'feishu') expect(calls[0][2]).toBe('describe')
  })

  it('does not run the model after disconnecting during attachment download', async () => {
    const { manager, updates, reply, fetcher, sent } = await setup()
    const original = vi.mocked(fetcher).getMockImplementation()!
    let started = false
    let downloadSignal: AbortSignal | undefined
    let finish!: (response: Response) => void
    vi.mocked(fetcher).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/getFile')) return Response.json({ ok: true, result: { file_path: 'photo.jpg' } })
      if (String(url).includes('/file/bot')) { started = true; downloadSignal = init?.signal as AbortSignal; return new Promise(resolve => { finish = resolve }) }
      return original(url, init)
    })
    await manager.connect('agent-a', { provider: 'telegram', token: '123:secret' })
    updates.push(tg(1, `/pair ${(await manager.list('agent-a'))[0].pairingCode}`), { ...tg(2, ''), message: { ...tg(2, '').message, photo: [{ file_id: 'photo' }] } })
    await vi.waitFor(() => expect(started).toBe(true))
    await manager.disconnect('agent-a', 'telegram')
    expect(downloadSignal?.aborted).toBe(true)
    finish(new Response('image bytes'))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(reply).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
  })

  it.each(['telegram', 'wechat', 'feishu'] as const)('uploads and delivers generated images through %s', async provider => {
    const { manager, updates, wechatUpdates, reply, fetcher, sent } = await setup()
    sdk.send.mockResolvedValue({ code: 0 }); sdk.addReaction.mockResolvedValue({ code: 0 })
    const original = vi.mocked(fetcher).getMockImplementation()!
    const bytes = Buffer.from('89504e470d0a1a0a', 'hex')
    const uploaded: any[] = []; const delivered: any[] = []
    let aeskey = ''
    vi.mocked(fetcher).mockImplementation(async (url, init) => {
      const address = String(url)
      if (address.endsWith('/sendPhoto') || address.endsWith('/images')) {
        const form = init!.body as FormData
        const blob = form.get(provider === 'telegram' ? 'photo' : 'image') as Blob
        uploaded.push(Buffer.from(await blob.arrayBuffer()))
        if (provider === 'telegram') expect(form.get('chat_id')).toBe('12')
        return Response.json(provider === 'telegram' ? { ok: true } : { code: 0, data: { image_key: 'generated-image' } })
      }
      if (address.includes('/im/v1/messages?')) { delivered.push(JSON.parse(init!.body as string)); return Response.json({ code: 0 }) }
      if (address.endsWith('/getuploadurl')) {
        const body = JSON.parse(init!.body as string); aeskey = body.aeskey
        expect(body).toMatchObject({ media_type: 1, rawsize: bytes.length, to_user_id: 'wx-owner' })
        return Response.json({ ret: 0, upload_param: 'upload-param' })
      }
      if (address.includes('/c2c/upload?')) {
        const decipher = createDecipheriv('aes-128-ecb', Buffer.from(aeskey, 'hex'), null)
        uploaded.push(Buffer.concat([decipher.update(Buffer.from(init!.body as Uint8Array)), decipher.final()]))
        return new Response('', { headers: { 'x-encrypted-param': 'download-param' } })
      }
      return original(url, init)
    })
    reply.mockResolvedValue(['Drawn.', { image: { name: 'wolf.png', mimeType: 'image/png', data: bytes } }])
    if (provider === 'wechat') { const login = await manager.login('agent-a'); await manager.loginStatus('agent-a', login.sessionId) }
    else await manager.connect('agent-a', provider === 'telegram' ? { provider, token: '123:secret' } : { provider, appId: 'cli_0123456789abcdef', appSecret: 'secret' })
    const pair = `/pair ${(await manager.list('agent-a'))[0].pairingCode}`
    if (provider === 'telegram') updates.push(tg(1, pair), tg(2, 'draw'))
    else if (provider === 'wechat') wechatUpdates.push(wx(1, pair), wx(2, 'draw'))
    else for (const [id, text] of [['1', pair], ['2', 'draw']]) await sdk.handler({ sender: { sender_type: 'user' }, message: { message_id: id, chat_id: 'private', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }) } })
    await vi.waitFor(() => expect(uploaded).toHaveLength(1))
    expect(uploaded[0]).toEqual(bytes)
    if (provider === 'wechat') {
      await vi.waitFor(() => expect(sent).toHaveLength(3))
      expect(sent[2].msg).toMatchObject({ context_token: 'reply-context', to_user_id: 'wx-owner', item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'download-param' } } }] })
    } else if (provider === 'feishu') {
      await vi.waitFor(() => expect(delivered).toHaveLength(1))
      expect(delivered[0]).toEqual({ receive_id: 'private', msg_type: 'image', content: JSON.stringify({ image_key: 'generated-image' }) })
    }
  })

  it.each(['failure', 'disconnect'] as const)('handles image upload %s without rerunning generation', async outcome => {
    const { manager, updates, reply, fetcher, sent } = await setup()
    const original = vi.mocked(fetcher).getMockImplementation()!
    let finish!: (response: Response) => void
    let started = false
    vi.mocked(fetcher).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/sendPhoto')) { started = true; return new Promise(resolve => { finish = resolve }) }
      return original(url, init)
    })
    reply.mockResolvedValue([{ image: { name: 'wolf.png', mimeType: 'image/png', data: Buffer.from('89504e470d0a1a0a', 'hex') } }])
    await manager.connect('agent-a', { provider: 'telegram', token: '123:secret' })
    updates.push(tg(1, `/pair ${(await manager.list('agent-a'))[0].pairingCode}`), tg(2, 'draw'))
    await vi.waitFor(() => expect(started).toBe(true))
    if (outcome === 'disconnect') await manager.disconnect('agent-a', 'telegram')
    finish(new Response('', { status: 500 }))
    if (outcome === 'failure') {
      await vi.waitFor(() => expect(sent).toHaveLength(2))
      expect(sent[1].text).toContain('图片已生成，但发送失败')
      expect((await manager.list('agent-a'))[0].status).toBe('error')
    } else { await new Promise(resolve => setTimeout(resolve, 30)); expect(sent).toHaveLength(1) }
    expect(reply).toHaveBeenCalledTimes(1)
  })

  it('pairs Telegram privately, routes only the paired sender, deduplicates and splits replies', async () => {
    const { manager, updates, sent, reply } = await setup()
    await manager.connect('agent-a', { provider: 'telegram', token: '123:secret' })
    const channel = (await manager.list('agent-a'))[0]
    expect(JSON.stringify(channel)).not.toContain('123:secret')
    updates.push(tg(1, 'unpaired'), tg(1, 'unpaired'), tg(2, '/pair wrong'), tg(3, `/pair ${channel.pairingCode}`))
    await vi.waitFor(() => expect(sent).toHaveLength(3))
    expect(sent[0]).toMatchObject({ chat_id: 12, text: expect.stringContaining('还未配对') })
    expect(sent[1].text).toContain('配对指令无效')
    expect(sent[0].text).toContain('消息渠道')
    expect(sent.slice(0, 2).map(item => item.text).join('')).not.toContain(channel.pairingCode)
    expect(reply).not.toHaveBeenCalled()
    expect((await manager.list('agent-a'))[0]).toMatchObject({ paired: true })
    expect((await manager.list('agent-a'))[0].pairingCode).toBeUndefined()
    updates.push(tg(4, 'Hello'), tg(4, 'Hello'), tg(5, 'stranger', 99))
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(sent).toHaveLength(4))
    expect(reply.mock.calls[0][0]).toBe('agent-a')
    expect(sent[3]).toMatchObject({ chat_id: 12, text: 'Reply: Hello' })
    reply.mockResolvedValue(['😀'.repeat(4000), 'Next bubble'])
    updates.push(tg(6, 'long answer'))
    await vi.waitFor(() => expect(sent).toHaveLength(8))
    expect(Array.from(sent[4].text)).toHaveLength(1750)
    expect(Array.from(sent[5].text)).toHaveLength(1750)
    expect(Array.from(sent[6].text)).toHaveLength(500)
    expect(sent[7].text).toBe('Next bubble')
  })
  it('keeps Telegram replies working when typing updates fail', async () => {
    const { manager, updates, sent, reply, fetcher } = await setup()
    const request = vi.mocked(fetcher).getMockImplementation()!
    vi.mocked(fetcher).mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('/sendChatAction')) throw new Error('typing unavailable')
      return request(...args)
    })
    await manager.connect('agent-a', { provider: 'telegram', token: '123:secret' })
    updates.push(tg(1, `/pair ${(await manager.list('agent-a'))[0].pairingCode}`), tg(2, 'hello'))
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    const actions = vi.mocked(fetcher).mock.calls.filter(([url]) => String(url).endsWith('/sendChatAction'))
    expect(actions).toHaveLength(1)
    expect(JSON.parse(actions[0][1]!.body as string)).toEqual({ chat_id: '12', action: 'typing' })
    expect(reply).toHaveBeenCalledTimes(1)
    expect(sent[1].text).toBe('Reply: hello')
    expect((await manager.list('agent-a'))[0].status).toBe('connected')
  })
  it.each(['failure', 'disconnect'] as const)('clears WeChat typing on %s', async outcome => {
    const { manager, wechatUpdates, reply, fetcher, sent } = await setup()
    let reject!: (error: Error) => void
    reply.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
    const login = await manager.login('agent-a')
    await manager.loginStatus('agent-a', login.sessionId)
    wechatUpdates.push(wx(1, `/pair ${(await manager.list('agent-a'))[0].pairingCode}`), wx(2, 'work'))
    const statuses = () => vi.mocked(fetcher).mock.calls.filter(([url]) => String(url).endsWith('/sendtyping')).map(([, options]) => JSON.parse(options!.body as string).status)
    await vi.waitFor(() => expect(statuses()).toEqual([1]))
    if (outcome === 'disconnect') await manager.disconnect('agent-a', 'wechat')
    reject(new Error('cancelled or failed'))
    await vi.waitFor(() => expect(statuses()).toEqual([1, 2]))
    if (outcome === 'failure') await vi.waitFor(() => expect(sent).toHaveLength(2))
    else expect(sent).toHaveLength(1)
  })
  it.each(['telegram', 'wechat', 'feishu'] as const)('sends desktop bubbles separately and in order through %s', async provider => {
    const { manager, updates, wechatUpdates, sent, reply } = await setup()
    sdk.send.mockResolvedValue({ code: 0 })
    sdk.addReaction.mockResolvedValue({ code: 0, data: { reaction_id: 'reaction' } })
    sdk.deleteReaction.mockResolvedValue({ code: 0 })
    const bubbles = ['First bubble\n\nwith two paragraphs', 'Second bubble', 'Third bubble']
    reply.mockResolvedValue(bubbles)
    if (provider === 'wechat') {
      const login = await manager.login('agent-a')
      await manager.loginStatus('agent-a', login.sessionId)
    } else await manager.connect('agent-a', provider === 'telegram'
      ? { provider, token: '123:secret' }
      : { provider, appId: 'cli_0123456789abcdef', appSecret: 'secret' })
    const pair = `/pair ${(await manager.list('agent-a'))[0].pairingCode}`
    if (provider === 'telegram') updates.push(tg(1, pair), tg(2, 'hello'))
    else if (provider === 'wechat') wechatUpdates.push(wx(1, pair), wx(2, 'hello'))
    else {
      for (const [id, text] of [['1', pair], ['2', 'hello']]) await sdk.handler({ sender: { sender_type: 'user' }, message: {
        message_id: id, chat_id: 'private', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text })
      } })
    }
    const texts = () => provider === 'feishu' ? sdk.send.mock.calls.map(([request]) => JSON.parse(request.data.content).text)
      : sent.map(message => provider === 'wechat' ? message.msg.item_list[0].text_item.text : message.text)
    await vi.waitFor(() => expect(texts()).toHaveLength(4))
    expect(texts().slice(1)).toEqual(bubbles)
    expect(reply).toHaveBeenCalledTimes(1)
  })
  it.each(['telegram', 'wechat', 'feishu'] as const)('formats outgoing content for %s while preserving the stored reply', async provider => {
    const { manager, updates, wechatUpdates, sent, reply } = await setup()
    sdk.send.mockResolvedValue({ code: 0 })
    const source = '**Files**\n\n- [clip.mp4](<douchat-file:///Users/me/Downloads/clip.mp4>)'
    reply.mockResolvedValue([source])
    if (provider === 'wechat') {
      const login = await manager.login('agent-a'); await manager.loginStatus('agent-a', login.sessionId)
    } else await manager.connect('agent-a', provider === 'telegram' ? { provider, token: '123:secret' }
      : { provider, appId: 'cli_0123456789abcdef', appSecret: 'secret' })
    const pair = `/pair ${(await manager.list('agent-a'))[0].pairingCode}`
    if (provider === 'telegram') updates.push(tg(1, pair), tg(2, 'files'))
    else if (provider === 'wechat') wechatUpdates.push(wx(1, pair), wx(2, 'files'))
    else for (const [id, text] of [['1', pair], ['2', 'files']]) await sdk.handler({ sender: { sender_type: 'user' }, message: {
      message_id: id, chat_id: 'private', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text })
    } })
    if (provider === 'feishu') {
      await vi.waitFor(() => expect(sdk.send).toHaveBeenCalledTimes(2))
      const payload = sdk.send.mock.calls[1][0].data
      expect(payload.msg_type).toBe('post')
      expect(payload.content).toContain('bold')
      expect(payload.content).toContain('clip.mp4')
      expect(payload.content).not.toContain('douchat-file')
    } else {
      await vi.waitFor(() => expect(sent).toHaveLength(2))
      const text = provider === 'wechat' ? sent[1].msg.item_list[0].text_item.text : sent[1].text
      expect(text).toBe('Files\n\n• 📄 clip.mp4')
      if (provider === 'telegram') expect(sent[1].entities).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'bold', offset: 0, length: 5 }), expect.objectContaining({ type: 'code' })]))
    }
    expect(await reply.mock.results[0].value).toEqual([source])
  })
  it('keeps the token in the credential vault, not FeltDB, and persists pairing, cursor and deduplication across restart', async () => {
    const { manager, updates, directory, desktop, reply } = await setup()
    await manager.connect('agent-a', { provider: 'telegram', token: '123:secret' })
    updates.push(tg(1, `/pair ${(await manager.list('agent-a'))[0].pairingCode}`), tg(2, 'first'))
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1))
    const feltFiles = readdirSync(join(desktop.root, 'felt'), { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name).map(name => readFileSync(join(desktop.root, 'felt', name), 'utf8')).join('')
    expect(feltFiles).not.toContain('123:secret')
    expect(readFileSync(join(directory, 'vault.json'), 'utf8')).not.toContain('123:secret')
    await manager.activate()
    expect((await manager.list('agent-a'))[0].paired).toBe(true)
    updates.push(tg(2, 'first'), tg(3, 'second'))
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(2))
    expect(reply.mock.calls[1][2]).toBe('second')
    expect(reply.mock.calls[0][1]).toBe(reply.mock.calls[1][1])
  })
  it('does not attach the same bot to two contacts or replace active webhooks', async () => {
    const { manager, fetcher } = await setup()
    await manager.connect('agent-a', { provider: 'telegram', token: '123:secret' })
    await expect(manager.connect('agent-b', { provider: 'telegram', token: '123:secret' })).rejects.toThrow('已经绑定')
    await manager.disconnect('agent-a', 'telegram')
    vi.mocked(fetcher).mockImplementationOnce(async () => ({ ok: true, json: async () => ({ ok: true, result: { id: 123, username: 'test_bot' } }) }) as Response)
    vi.mocked(fetcher).mockImplementationOnce(async () => ({ ok: true, json: async () => ({ ok: true, result: { url: 'https://existing.example' } }) }) as Response)
    await expect(manager.connect('agent-a', { provider: 'telegram', token: '123:secret' })).rejects.toThrow('Webhook')
    expect((await manager.list('agent-a'))).toEqual([])
  })
  it('completes WeChat QR login and sends replies with the inbound context token', async () => {
    const { manager, wechatUpdates, sent, reply, fetcher } = await setup()
    const login = await manager.login('agent-a')
    expect(login.qr).toContain('https://')
    expect(await manager.loginStatus('agent-b', login.sessionId)).toEqual({ status: 'expired' })
    expect(await manager.loginStatus('agent-a', login.sessionId)).toEqual({ status: 'confirmed' })
    wechatUpdates.push(wx(0, '你好'))
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].msg).toMatchObject({ to_user_id: 'wx-owner', context_token: 'reply-context', item_list: [{ type: 1, text_item: { text: expect.stringContaining('还未配对') } }] })
    expect(reply).not.toHaveBeenCalled()
    sent.length = 0
    wechatUpdates.push(wx(1, `/pair ${(await manager.list('agent-a'))[0].pairingCode}`), wx(2, '微信你好'))
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(reply).toHaveBeenCalledTimes(1)
    expect(sent[1].msg).toMatchObject({ to_user_id: 'wx-owner', context_token: 'reply-context', item_list: [{ type: 1, text_item: { text: 'Reply: 微信你好' } }] })
    const typingCalls = vi.mocked(fetcher).mock.calls.filter(([url]) => String(url).endsWith('/sendtyping'))
    expect(typingCalls.map(([, options]) => JSON.parse(options!.body as string).status)).toEqual([1, 2])
    const configCall = vi.mocked(fetcher).mock.calls.find(([url]) => String(url).endsWith('/getconfig'))!
    expect(JSON.parse(configCall[1]!.body as string)).toMatchObject({ ilink_user_id: 'wx-owner', context_token: 'reply-context' })
    await manager.disconnect('agent-a', 'wechat')
    expect((await manager.list('agent-a'))).toEqual([])
  })
  it('waits for Feishu handshake and handles only private user messages', async () => {
    const { manager, reply } = await setup()
    sdk.send.mockResolvedValue({ code: 0 })
    sdk.addReaction.mockResolvedValue({ code: 0, data: { reaction_id: 'typing-reaction' } })
    sdk.deleteReaction.mockResolvedValue({ code: 0 })
    await manager.connect('agent-a', { provider: 'feishu', appId: 'cli_0123456789abcdef', appSecret: 'secret' })
    expect((await manager.list('agent-a'))[0].status).toBe('connecting')
    sdk.callbacks.onReady()
    expect((await manager.list('agent-a'))[0].status).toBe('connected')
    const event = (id: string, text: string, chatType = 'p2p') => ({ sender: { sender_type: 'user' }, message: { message_id: id, chat_id: 'oc_private', chat_type: chatType, message_type: 'text', content: JSON.stringify({ text }) } })
    await sdk.handler(event('1', `/pair ${(await manager.list('agent-a'))[0].pairingCode}`, 'group'))
    expect((await manager.list('agent-a'))[0].paired).toBe(false)
    expect(sdk.send).not.toHaveBeenCalled()
    await sdk.handler(event('unpaired', '你好'))
    await vi.waitFor(() => expect(sdk.send).toHaveBeenCalledTimes(1))
    expect(JSON.parse(sdk.send.mock.calls[0][0].data.content).text).toContain('还未配对')
    expect(reply).not.toHaveBeenCalled()
    sdk.send.mockClear()
    await sdk.handler(event('2', `/pair ${(await manager.list('agent-a'))[0].pairingCode}`))
    await vi.waitFor(() => expect(sdk.send).toHaveBeenCalledTimes(1))
    await sdk.handler(event('3', '飞书你好'))
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(sdk.send).toHaveBeenCalledTimes(2))
    expect(sdk.send.mock.calls[1][0].data).toMatchObject({ receive_id: 'oc_private', content: JSON.stringify({ text: 'Reply: 飞书你好' }) })
    expect(sdk.addReaction).toHaveBeenCalledTimes(1)
    expect(sdk.addReaction).toHaveBeenCalledWith({ path: { message_id: '3' }, data: { reaction_type: { emoji_type: 'Typing' } } })
    await vi.waitFor(() => expect(sdk.deleteReaction).toHaveBeenCalledWith({ path: { message_id: '3', reaction_id: 'typing-reaction' } }))
    sdk.callbacks.onReconnecting()
    expect((await manager.list('agent-a'))[0].status).toBe('connecting')
    sdk.callbacks.onReconnected()
    expect((await manager.list('agent-a'))[0].status).toBe('connected')
    await manager.disconnect('agent-a', 'feishu')
    expect(sdk.close).toHaveBeenCalledWith({ force: true })
  })
  it('aborts an in-flight model response on disconnect without sending it', async () => {
    const { manager, updates, reply, sent } = await setup()
    let finish!: (value: string[]) => void
    reply.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await manager.connect('agent-a', { provider: 'telegram', token: '123:secret' })
    updates.push(tg(1, `/pair ${(await manager.list('agent-a'))[0].pairingCode}`), tg(2, 'slow'))
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1))
    await manager.disconnect('agent-a', 'telegram')
    finish(['late response'])
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(sent).toHaveLength(1)
  })
  it('cancels an in-flight QR login without installing its credentials', async () => {
    const { manager, fetcher } = await setup()
    const login = await manager.login('agent-a')
    let complete!: (value: Response) => void
    vi.mocked(fetcher).mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const pending = manager.loginStatus('agent-a', login.sessionId)
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    manager.cancelLogin('agent-a', login.sessionId)
    complete({ ok: true, json: async () => ({ status: 'confirmed', bot_token: 'secret', ilink_bot_id: 'bot@im.bot' }) } as Response)
    expect(await pending).toEqual({ status: 'expired' })
    expect((await manager.list('agent-a'))).toEqual([])
  })
  it('reports invalid credentials without saving a connection', async () => {
    const { manager, fetcher } = await setup()
    vi.mocked(fetcher).mockResolvedValueOnce({ ok: false, status: 401 } as Response)
    await expect(manager.connect('agent-a', { provider: 'telegram', token: '123:bad' })).rejects.toThrow('HTTP 401')
    expect((await manager.list('agent-a'))).toEqual([])
    await expect(manager.connect('agent-a', { provider: 'feishu', appId: 'invalid', appSecret: 'secret' })).rejects.toThrow('App ID')
  })
  it('sends a useful model failure notice without retrying the task', async () => {
    const { manager, updates, reply, sent } = await setup()
    reply.mockRejectedValue(new Error('private-provider-error'))
    await manager.connect('agent-a', { provider: 'telegram', token: '123:secret' })
    updates.push(tg(1, `/pair ${(await manager.list('agent-a'))[0].pairingCode}`), tg(2, 'task'), tg(2, 'task'))
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1].text).toContain('模型配置')
    expect(sent[1].text).not.toContain('private-provider-error')
    expect(reply).toHaveBeenCalledTimes(1)
  })

  it.each(['telegram', 'wechat', 'feishu'] as const)('receives, indicates typing and starts a second %s request while the first is still running', async provider => {
    const { manager, reply, received, fetcher, updates, wechatUpdates, sent } = await setup()
    sdk.send.mockResolvedValue({ code: 0 }); sdk.addReaction.mockResolvedValue({ code: 0 })
    if (provider === 'wechat') { const login = await manager.login('agent-a'); await manager.loginStatus('agent-a', login.sessionId) }
    else await manager.connect('agent-a', provider === 'telegram' ? { provider, token: '123:secret' } : { provider, appId: 'cli_0123456789abcdef', appSecret: 'secret' })
    const deliver = async (id: number, text: string) => {
      if (provider === 'telegram') updates.push(tg(id, text))
      else if (provider === 'wechat') wechatUpdates.push(wx(id, text))
      else await sdk.handler({ sender: { sender_type: 'user' }, message: { message_id: String(id), chat_id: 'private', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }) } })
    }
    await deliver(1, `/pair ${(await manager.list('agent-a'))[0].pairingCode}`)
    await vi.waitFor(async () => expect((await manager.list('agent-a'))[0].paired).toBe(true))
    const releases = new Map<string, (value: string[]) => void>()
    reply.mockImplementation((_agent, _thread, text) => new Promise(resolve => releases.set(text, resolve)))
    await deliver(2, 'slow')
    await vi.waitFor(() => expect(releases.has('slow')).toBe(true))
    await deliver(3, 'fast')
    await vi.waitFor(() => expect(releases.has('fast')).toBe(true))
    expect(received).toHaveBeenCalledTimes(2)
    if (provider === 'feishu') expect(sdk.addReaction).toHaveBeenCalledTimes(2)
    else expect(vi.mocked(fetcher).mock.calls.some(([url]) => String(url).endsWith(provider === 'telegram' ? '/sendChatAction' : '/sendtyping'))).toBe(true)
    releases.get('fast')!(['FAST ANSWER'])
    const texts = () => provider === 'feishu' ? sdk.send.mock.calls.map(([request]) => request.data.content) : sent.map(message => JSON.stringify(message))
    await vi.waitFor(() => expect(texts().some(text => text.includes('FAST ANSWER'))).toBe(true))
    expect(texts().some(text => text.includes('SLOW ANSWER'))).toBe(false)
    if (provider === 'wechat') expect(vi.mocked(fetcher).mock.calls.filter(([url]) => String(url).endsWith('/sendtyping')).map(([, init]) => JSON.parse(init!.body as string).status)).not.toContain(2)
    await deliver(2, 'slow')
    releases.get('slow')!(['SLOW ANSWER'])
    await vi.waitFor(() => expect(texts().some(text => text.includes('SLOW ANSWER'))).toBe(true))
    expect(reply).toHaveBeenCalledTimes(2)
  })

  it('persists pending receipts and advances polling before execution finishes, then restores queued work without repeating started work', async () => {
    const { manager, reply, received, updates, desktop, sent } = await setup()
    await manager.connect('agent-a', { provider: 'telegram', token: '123:secret' })
    updates.push(tg(1, `/pair ${(await manager.list('agent-a'))[0].pairingCode}`))
    await vi.waitFor(async () => expect((await manager.list('agent-a'))[0].paired).toBe(true))
    reply.mockImplementation(() => new Promise(() => {}))
    updates.push(...Array.from({ length: 6 }, (_, index) => tg(index + 2, `task-${index}`)))
    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(6))
    expect(reply).toHaveBeenCalledTimes(4)
    const records = (await desktop.repository.setting<any[]>('imChannels'))!
    expect(records[0].cursor).toBe('8')
    expect(records[0].inbox.filter((entry: any) => entry.state === 'queued')).toHaveLength(2)
    expect(records[0].inbox.every((entry: any) => entry.receiptId)).toBe(true)
    reply.mockResolvedValue(['RESTORED'])
    await manager.activate()
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(6))
    expect(reply.mock.calls.slice(4).map(call => call[2])).toEqual(['task-4', 'task-5'])
    await vi.waitFor(() => expect(sent.filter(message => message.text.includes('未完成回传'))).toHaveLength(4))
  })

  it('does not wait for attachment download or model completion to persist receipts or fetch the next update', async () => {
    const { manager, reply, received, updates, fetcher } = await setup()
    const request = vi.mocked(fetcher).getMockImplementation()!
    let finish!: (value: Response) => void
    vi.mocked(fetcher).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/getFile')) return Response.json({ ok: true, result: { file_path: 'photo.jpg' } })
      if (String(url).includes('/file/bot')) return new Promise(resolve => { finish = resolve })
      return request(url, init)
    })
    await manager.connect('agent-a', { provider: 'telegram', token: '123:secret' })
    updates.push(tg(1, `/pair ${(await manager.list('agent-a'))[0].pairingCode}`), { ...tg(2, 'photo'), message: { ...tg(2, 'photo').message, photo: [{ file_id: 'photo' }] } })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(received).toHaveBeenCalledTimes(1)
    expect(reply).not.toHaveBeenCalled()
    updates.push(tg(3, 'text'))
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1))
    expect(reply.mock.calls[0][2]).toBe('text')
    finish(new Response('bytes'))
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(2))
  })

  it('rejects untrusted WeChat credential destinations and preserves Unicode on split', () => {
    expect(() => wechatBaseURL('https://attacker.example')).toThrow()
    expect(() => wechatBaseURL('http://ilinkai.weixin.qq.com')).toThrow()
    expect(() => wechatBaseURL('https://ilinkai.weixin.qq.com@evil.example')).toThrow()
    expect(splitIMText('a😀b', 2)).toEqual(['a😀', 'b'])
  })
})
