import { useEffect, useRef, useState } from 'react'
import { RefreshCw, Save, Trash2 } from 'lucide-react'
import type { UserMemoryDocument } from '../../../shared/userMemory'
import { resolveInterfaceLanguage, usePreferences } from '../preferences'
import './UserMemoryPanel.css'

export function UserMemoryPanel({ agentId, conversationId, onDirty, onSaved, onBusyChange }: {
  agentId?: string; conversationId?: string; onDirty?: () => void; onSaved?: () => void; onBusyChange?: (busy: boolean) => void
}) {
  const preferences = usePreferences()
  const tr = (en: string, zh: string) => resolveInterfaceLanguage(preferences.language) === 'zh-CN' ? zh : en
  const [document, setDocument] = useState<UserMemoryDocument>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)
  const generation = useRef(0)
  useEffect(() => {
    const version = ++generation.current
    setLoading(true); setError(''); setNotice('')
    const request = conversationId ? window.douchat.getGroupMemory(conversationId) : window.douchat.getUserMemory(agentId)
    request.then(value => {
      if (version !== generation.current) return
      setDocument(value); setDirty(false)
    }).catch(cause => { if (version === generation.current) setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (version === generation.current) setLoading(false) })
    return () => { generation.current++ }
  }, [agentId, conversationId, refresh])
  const edit = (next: UserMemoryDocument) => { setDocument(next); setDirty(true); setNotice(''); onDirty?.() }
  const save = async () => {
    if (!document || loading || saving) return
    const version = generation.current
    setSaving(true); onBusyChange?.(true); setError('')
    try {
      const result = await (conversationId ? window.douchat.saveGroupMemory(document, conversationId) : window.douchat.saveUserMemory(document, agentId))
      if (version !== generation.current) return
      setDocument(result); setDirty(false); setNotice(tr('Saved. Applies from the next message.', '已保存，从下一条消息开始生效。')); onSaved?.()
    } catch (cause) { if (version === generation.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (version === generation.current) { setSaving(false); onBusyChange?.(false) } }
  }
  return <div className="user-memory-panel">
    <header className="settings-heading"><div><h1>{conversationId ? tr('Group memory', '群记忆') : agentId ? tr('User profile & memory', '用户资料与记忆') : tr('About me', '关于我')}</h1><p>{conversationId ? tr('Member information and agreements remembered in this group.', '在本群中记住的成员信息和约定。') : agentId ? tr('Edit the private USER.md profile, MEMORY.md summary, and remembered facts for you and this agent.', '编辑你与这个智能体专属的 USER.md 资料、MEMORY.md 摘要和记忆条目。') : tr('Your name, interests and preferences, shared across your agents.', '你的名字、爱好和偏好，在你的多个智能体之间共享。')}</p></div>
      <button className="primary-button" disabled={!document || loading || saving || !dirty || document.facts.some(fact => !fact.text.trim())} onClick={() => void save()}><Save size={16} />{saving ? tr('Saving…', '正在保存…') : tr('Save', '保存')}</button>
    </header>
    <p className="settings-note user-memory-scope">{conversationId ? tr('Stored on this computer. Shared by your agents in this group across topics. Private chat memories are kept separate.', '保存在本机，本群中你的智能体可跨话题使用。与私聊记忆隔离。') : agentId ? tr('Shared information is managed in Settings → About me. Neither shared nor private memory is loaded in group conversations.', '共享资料请在「设置 → 关于我」管理。共享资料和专属记忆都不会在群聊中加载。') : tr('Stored on this computer. Used in private chats with your agents, including paired messaging channels; never loaded in group chats.', '保存在本机。用于与你的智能体私聊及已配对渠道，不会在群聊中加载。')}</p>
    <p className="settings-note">{tr('Stored in this computer’s local FeltDB database.', '保存在本机的 FeltDB 数据库中。')}</p>
    <div className="user-memory-toolbar"><button className="secondary-button" disabled={saving || loading} onClick={() => { if (dirty && !window.confirm(tr('Discard edits and reload the latest memory?', '放弃当前修改并重新加载最新记忆？'))) return; setRefresh(value => value + 1); onSaved?.() }}><RefreshCw size={14} />{tr('Reload', '重新加载')}</button>
      {document && <button className="secondary-button danger" disabled={saving || loading || (!document.notes && !document.memoryNotes && !document.facts.length)} onClick={() => { if (window.confirm(tr('Clear this memory? Save to apply.', '清空这份记忆？保存后生效。'))) edit({ ...document, notes: '', memoryNotes: '', facts: [], clearHistory: true }) }}><Trash2 size={14} />{tr('Clear memory', '清空记忆')}</button>}
    </div>
    {loading ? <p role="status">{tr('Loading…', '正在加载…')}</p> : document && <fieldset className="user-memory-fields" disabled={saving}>
      <label className="user-memory-toggle"><input type="checkbox" checked={document.autoRemember} onChange={event => edit({ ...document, autoRemember: event.target.checked })} /><span>{conversationId ? tr('Let my agents remember information from this group', '允许我的智能体记住本群中的信息') : agentId ? tr('Let this agent remember useful information from our chats', '允许这个智能体从我们的对话中记住有用信息') : tr('Let my agents remember useful information from private chats', '允许智能体从私聊中记住有用信息')}</span></label>
      <label className="user-memory-notes"><span>{conversationId ? tr('Notes for this group', '给本群智能体的说明') : agentId ? tr('Private user profile · USER.md', '专属用户资料 · USER.md') : tr('What should your agents know about you?', '你希望智能体了解哪些关于你的信息？')}</span>
        <textarea value={document.notes} maxLength={20000} rows={7} placeholder={conversationId ? tr('Group preferences and confirmed agreements…', '群内偏好、已确认的约定……') : agentId ? tr('Stable background and preferences…', '稳定的背景资料、兴趣和偏好……') : tr('My name, interests, preferred language…', '我的名字、兴趣、常用语言……')} onChange={event => edit({ ...document, notes: event.target.value })} /></label>
      {!conversationId && <label className="user-memory-notes"><span>{tr('Long-term summary · MEMORY.md', '长期记忆要点 · MEMORY.md')}</span><textarea value={document.memoryNotes ?? ''} maxLength={20000} rows={5} onChange={event => edit({ ...document, memoryNotes: event.target.value })} /></label>}
      <h2>{tr('Remembered from conversations', '从对话中记住的信息')}</h2>
      {!document.facts.length && <p className="settings-note">{tr('No remembered information yet.', '还没有记住的信息。')}</p>}
      <div className="user-memory-facts">{document.facts.map(fact => <article key={fact.key}>
        {conversationId && fact.subjectId && <p className="settings-note">{fact.subjectName || fact.subjectId} <small>({fact.subjectId})</small></p>}
        {!conversationId && <label>{tr('Save as', '保存到')} <select aria-label={tr('Memory category', '记忆分类')} value={fact.kind ?? 'memory'} onChange={event => edit({ ...document, facts: document.facts.map(item => item.key === fact.key ? { ...item, kind: event.target.value as 'profile' | 'memory' } : item) })}><option value="profile">USER.md</option><option value="memory">MEMORY.md</option></select></label>}
        <div className="user-memory-fact-row"><textarea aria-label={tr('Remembered information', '记忆内容')} maxLength={2000} rows={2} value={fact.text} onChange={event => edit({ ...document, facts: document.facts.map(item => item.key === fact.key ? { ...item, text: event.target.value, evidence: undefined, sourceAgentId: undefined } : item) })} /><button className="icon-button danger" aria-label={tr('Delete memory', '删除记忆')} onClick={() => edit({ ...document, facts: document.facts.filter(item => item.key !== fact.key) })}><Trash2 size={16} /></button></div>
        {fact.evidence && <details><summary>{tr('View source', '查看来源')}</summary><p>{fact.evidence}</p></details>}
      </article>)}</div>
    </fieldset>}
    {notice && <p className="settings-success" role="status">{notice}</p>}
    {error && <p className="settings-error" role="alert">{error}</p>}
  </div>
}
