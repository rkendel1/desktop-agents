import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Plus, Radio, Trash2, X, ArrowLeft, Copy, RefreshCw } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import type { AgentConfig } from '../../../shared/types'
import type { IMChannel, IMLogin, IMProvider } from '../../../shared/imChannels'
import { AgentDialogSurface as NativeDialog } from './AgentDialogSurface'
import { resolveInterfaceLanguage, usePreferences } from '../preferences'

const providers: { id: IMProvider; name: string; icon: string; description: [string, string] }[] = [
  { id: 'wechat', name: 'WeChat', icon: 'wechat.svg', description: ['Scan with WeChat to connect this contact.', '微信扫码，将私信转发给这个联系人。'] },
  { id: 'feishu', name: 'Feishu', icon: 'feishu.png', description: ['Connect a Feishu app using a persistent connection.', '通过长连接接入飞书自建应用机器人。'] },
  { id: 'telegram', name: 'Telegram', icon: 'telegram.svg', description: ['Connect a Telegram bot to chat with this contact.', '连接 Telegram 机器人，与这个联系人聊天。'] }
]
export function IMChannelsDialog({ agent, onClose }: { agent: AgentConfig; onClose: () => void }) {
  const preferences = usePreferences()
  const tr = (en: string, zh: string) => resolveInterfaceLanguage(preferences.language) === 'zh-CN' ? zh : en
  const [channels, setChannels] = useState<IMChannel[]>([])
  const [selected, setSelected] = useState<IMProvider>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [token, setToken] = useState('')
  const [appId, setAppId] = useState('')
  const [secret, setSecret] = useState('')
  const [login, setLogin] = useState<IMLogin>()
  const [qrStatus, setQrStatus] = useState('wait')
  const [remove, setRemove] = useState<IMProvider>()
  const alive = useRef(true)
  const version = useRef(0)
  useEffect(() => {
    alive.current = true
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try { const data = await window.douchat.listIMChannels(agent.id); if (alive.current) setChannels(data) }
      catch (e) { if (alive.current) setError(String(e instanceof Error ? e.message : e)) }
      finally { if (alive.current) { setLoading(false); timer = setTimeout(refresh, 2500) } }
    }
    void refresh()
    return () => { alive.current = false; version.current++; clearTimeout(timer) }
  }, [agent.id])
  useEffect(() => {
    if (!login || selected !== 'wechat') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await window.douchat.pollIMLogin(agent.id, login.sessionId)
        if (cancelled) return
        setQrStatus(result.status)
        if (result.status === 'confirmed') { setSelected(undefined); setLogin(undefined); setChannels(await window.douchat.listIMChannels(agent.id)); return }
        if (result.status !== 'expired') timer = setTimeout(poll, 1500)
      } catch (e) { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); timer = setTimeout(poll, 5000) } }
    }
    void poll()
    return () => { cancelled = true; clearTimeout(timer); void window.douchat.cancelIMLogin(agent.id, login.sessionId).catch(() => {}) }
  }, [login, selected, agent.id])
  async function run(action: () => Promise<void>) {
    setBusy(true); setError('')
    try { await action() } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (alive.current) setBusy(false) }
  }
  async function scan() {
    const revision = ++version.current
    setLogin(undefined); setQrStatus('wait')
    await run(async () => {
      const result = await window.douchat.startIMLogin(agent.id)
      if (alive.current && version.current === revision) setLogin(result)
      else await window.douchat.cancelIMLogin(agent.id, result.sessionId)
    })
  }
  function back() { version.current++; setSelected(undefined); setLogin(undefined); setError(''); setToken(''); setSecret(''); setAppId('') }
  const provider = providers.find(item => item.id === selected)
  return <NativeDialog onClose={onClose} width={640} layoutKey={`${selected ?? 'list'}-${qrStatus}-${error}-${channels.length}`}>
    <section className="agent-modal im-modal" role="dialog" aria-modal="true" aria-labelledby="im-title">
      <header className="im-heading"><h2 id="im-title"><Radio size={22} /> {tr('Message channels', '消息渠道')}</h2><button className="icon-button" onClick={onClose} aria-label={tr('Close', '关闭')}><X size={20} /></button></header>
      <div className="im-body">
        {!selected && <><p className="im-intro">{tr(`Connect ${agent.name} to your messaging apps.`, `为「${agent.name}」连接即时通讯平台，在其他 IM 中与其聊天。`)}</p>
        <p className="settings-note">{tr('Keep Foundry running and signed in. Text, images and files are supported; all channels share this contact’s conversation.', '接收消息时需保持 Foundry 运行并登录。支持文字、图片和文件，所有渠道共用此联系人的聊天记录。')}</p>
        </>}
        {error && <p className="settings-error" role="alert">{error}</p>}
        {!selected ? <>
          {loading ? <p role="status">{tr('Loading…', '正在加载…')}</p> : <div className="im-grid">{providers.map(item => {
            const channel = channels.find(c => c.provider === item.id)
            return <article className="im-card" key={item.id}>
              <div className="im-card-title"><img src={`./channels/${item.icon}`} alt="" /><h3>{item.name}</h3>{channel && <span className={`im-status ${channel.status}`}><CheckCircle2 size={14} />{channel.status === 'error' ? tr('Attention', '连接异常') : channel.status === 'connecting' ? tr('Connecting', '连接中') : tr('Connected', '已连接')}</span>}</div>
              <p className="im-description">{channel?.label || tr(...item.description)}</p>
              {channel?.error && <p className="settings-error" role="status">{channel.error}</p>}
              {channel && !channel.paired && <div className="im-pair"><p>{tr('Send this command in a private chat with the bot to pair your account:', '在机器人私信中发送以下指令，绑定你的账号：')}</p><button className="im-code" title={tr('Copy pairing command', '复制配对指令')} onClick={() => void run(() => window.douchat.copyText(`/pair ${channel.pairingCode}`))}><code>/pair {channel.pairingCode}</code><Copy size={14} /></button></div>}
              {channel?.paired && <p className="im-paired">{tr('Paired · ready for private messages', '已配对 · 可以开始私信聊天')}</p>}
              {remove === item.id ? <div className="im-remove"><p>{tr('Disconnect this bot? You can reconnect later.', '断开这个机器人？之后可以重新连接。')}</p><button className="secondary-button" disabled={busy} onClick={() => setRemove(undefined)}>{tr('Cancel', '取消')}</button><button className="secondary-button danger" disabled={busy} onClick={() => void run(async () => { await window.douchat.disconnectIMChannel(agent.id, item.id); setChannels(await window.douchat.listIMChannels(agent.id)); setRemove(undefined) })}>{tr('Disconnect', '断开连接')}</button></div> : <button className={`secondary-button im-action ${channel ? 'danger' : 'im-connect'}`} disabled={busy} onClick={() => { if (channel) setRemove(item.id); else { setSelected(item.id); setError(''); if (item.id === 'wechat') void scan() } }}>{channel ? <Trash2 size={16} /> : <Plus size={16} />}{channel ? tr('Disconnect', '断开连接') : tr('Connect', '连接')}</button>}
            </article>
          })}</div>}
        </> : <div className="im-setup">
          <button className="im-back" disabled={busy} onClick={back}><ArrowLeft size={16} />{tr('All channels', '全部渠道')}</button>
          <div className="im-setup-heading"><img src={`./channels/${provider?.icon}`} alt="" /><h3>{tr('Connect', '连接')} {provider?.name}</h3></div>
          {selected === 'wechat' ? <div className="im-qr">
            <p>{tr('Scan with the WeChat mobile app and confirm login on your phone.', '使用微信手机客户端扫码，并在手机上确认登录。')}</p>
            {login && qrStatus !== 'expired' ? <div className="im-qr-image"><QRCodeSVG value={login.qr} size={208} /></div> : <div className="im-qr-placeholder">{busy ? tr('Getting QR code…', '正在获取二维码…') : tr('Refresh the QR code to continue', '请刷新二维码后继续')}</div>}
            <p role="status">{qrStatus === 'scaned' ? tr('Scanned. Confirm on your phone.', '已扫码，请在手机上确认。') : qrStatus === 'expired' ? tr('QR code expired.', '二维码已过期。') : tr('Waiting for scan', '等待扫码')}</p>
            <button className="secondary-button" disabled={busy} onClick={() => void scan()}><RefreshCw size={15} />{tr('Refresh QR code', '刷新二维码')}</button>
          </div> : <form onSubmit={event => { event.preventDefault(); void run(async () => {
            await window.douchat.connectIMChannel(agent.id, selected === 'telegram' ? { provider: 'telegram', token } : { provider: 'feishu', appId, appSecret: secret })
            if (!alive.current) return
            setChannels(await window.douchat.listIMChannels(agent.id)); back()
          }) }}>
            {selected === 'telegram' ? <><ol className="im-help"><li>{tr('Open @BotFather in Telegram and send /newbot.', '在 Telegram 打开 @BotFather，发送 /newbot 创建机器人。')}</li><li>{tr('Paste the Bot Token below. Use a bot that is not connected to another service.', '将 Bot Token 粘贴到下方，请使用尚未接入其他服务的机器人。')}</li><li>{tr('After connecting, send the pairing command to your bot in a private chat.', '连接后，在机器人私信中发送配对指令即可开始聊天。')}</li></ol><label className="im-field">Bot Token<input autoFocus type="password" autoComplete="off" required value={token} onChange={e => setToken(e.target.value)} placeholder="123456789:AA…" disabled={busy} /></label></> : <><ol className="im-help"><li>{tr('Create a custom app in Feishu Open Platform and enable the bot capability.', '在飞书开放平台创建企业自建应用，开启机器人能力。')}</li><li>{tr('Enable im:message.p2p_msg:readonly, im:message:send_as_bot and im:message.reactions:write_only permissions (for typing status).', '开通 im:message.p2p_msg:readonly、im:message:send_as_bot 和 im:message.reactions:write_only（输入中状态）权限。')}</li><li>{tr('Connect below, then select persistent connection in Events & callbacks and subscribe to im.message.receive_v1.', '填写凭证连接后，在「事件与回调」选择长连接，订阅 im.message.receive_v1。')}</li><li>{tr('Publish the app and make it available to your account. Send the pairing command in a private chat.', '发布应用版本，确保你的账号在可用范围内，然后私信机器人发送配对指令。')}</li></ol><label className="im-field">App ID<input autoFocus autoComplete="off" required value={appId} onChange={e => setAppId(e.target.value)} placeholder="cli_…" disabled={busy} /></label><label className="im-field">App Secret<input type="password" autoComplete="off" required value={secret} onChange={e => setSecret(e.target.value)} disabled={busy} /></label></>}
            <p className="settings-note">{tr('Credentials are encrypted in your local system keychain-backed storage.', '凭证使用系统钥匙串加密后保存在本机。')}</p>
            <button className="secondary-button im-connect" disabled={busy}><Plus size={16} />{busy ? tr('Connecting…', '正在连接…') : tr('Connect', '连接')}</button>
          </form>}
        </div>}
      </div>
    </section>
  </NativeDialog>
}
