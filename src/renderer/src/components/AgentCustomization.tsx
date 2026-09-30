import { SkillDetailDialog } from './SkillDetailDialog'
import { SkillUploadDialog } from './SkillUploadDialog'
import { useEffect, useState } from 'react'
import { Save, Trash2, Upload } from 'lucide-react'
import { validateAgentSkills, type AgentFileName, type AgentFiles, type AgentSkill } from '../../../shared/agentCustomization'
import type { AgentConfig, UpdateAgentInput } from '../../../shared/types'
import { t, resolveInterfaceLanguage, usePreferences } from '../preferences'

type Props = { agent: AgentConfig; onSave: (input: UpdateAgentInput) => Promise<void>; onDirty: () => void }
const editableFiles = [
  { name: 'SOUL.md', en: 'Soul', zh: '灵魂' },
  { name: 'IDENTITY.md', en: 'Identity', zh: '身份' },
  { name: 'TOOLS.md', en: 'Tools', zh: '工具' },
  { name: 'BOOTSTRAP.md', en: 'Bootstrap', zh: '引导' },
  { name: 'AGENTS.md', en: 'Workflow', zh: '工作流程' },
  { name: 'HEARTBEAT.md', en: 'Checks', zh: '持续检查' }
] as const

export function AgentFilesPanel({ agent, onSave, onDirty }: Props) {
  const preferences = usePreferences()
  const tr = (en: string, zh: string) => resolveInterfaceLanguage(preferences.language) === 'zh-CN' ? zh : en
  const [files, setFiles] = useState<AgentFiles>(agent.systemFiles ?? {})
  const [baseline, setBaseline] = useState<AgentFiles>(agent.systemFiles ?? {})
  const [edited, setEdited] = useState(false)
  useEffect(() => {
    if (!edited) { setFiles(agent.systemFiles ?? {}); setBaseline(agent.systemFiles ?? {}) }
  }, [agent.systemFiles, edited])
  const [active, setActive] = useState<AgentFileName>('SOUL.md')
  const [error, setError] = useState('')
  const tabs = editableFiles.filter(file => !['TOOLS.md', 'AGENTS.md', 'HEARTBEAT.md'].includes(file.name))
  return <section className="agent-customize-panel">
    <header className="settings-heading agent-settings-heading"><div><h1>{tr('Customize', '自定义')}</h1></div>
      <button className="primary-button" onClick={async () => { setError(''); try { await onSave({ systemFiles: Object.fromEntries(editableFiles.filter(file => files[file.name] !== baseline[file.name]).map(file => [file.name, files[file.name] ?? ''])), expectedSystemFiles: baseline }); setEdited(false) } catch (e) { setError(String(e instanceof Error ? e.message : e)) } }}>{t('Save')}</button>
    </header>
    <div className="agent-file-tabs" role="tablist" aria-label={tr('Custom files', '自定义文件')}>
      {tabs.map(({ name, en, zh }) => <button type="button" key={name} role="tab" aria-selected={active === name} aria-controls="agent-file-editor" id={`agent-file-${name}`} onClick={() => setActive(name)}>{tr(en, zh)}</button>)}
    </div>
    <div role="tabpanel" id="agent-file-editor" aria-labelledby={`agent-file-${active}`}>
      <label className="agent-file-label" htmlFor="agent-file-content">{active}</label>
      <textarea id="agent-file-content" className="agent-markdown-editor" value={files[active] ?? ''} spellCheck={false} maxLength={100000} placeholder={`# ${active}\n\n${tr('Write your content here…', '在此编写内容…')}`} onChange={e => { setFiles({ ...files, [active]: e.target.value }); setEdited(true); onDirty() }} />
    </div>
    <p className="settings-note">{tr('Saved files apply from the next message. Edit USER.md and MEMORY.md in the Memory section.', '保存后从下一条消息开始生效。请在「记忆」中编辑 USER.md 和 MEMORY.md。')}</p>
    {error && <p className="settings-error" role="alert">{error}</p>}
  </section>
}

export function AgentSkillsPanel({ agent, onSave, onDirty }: Props) {
  const preferences = usePreferences()
  const tr = (en: string, zh: string) => resolveInterfaceLanguage(preferences.language) === 'zh-CN' ? zh : en
  const [skills, setSkills] = useState<AgentSkill[]>(agent.skills ?? [])
  const [selected, setSelected] = useState<string>()
  const [error, setError] = useState('')
  const [uploadOpen, setUploadOpen] = useState(false)
  const active = skills.find(skill => skill.id === selected)
  const change = (next: AgentSkill[]) => { setSkills(next); onDirty() }
  return <section>
    <header className="settings-heading agent-settings-heading"><div><h1>{tr('Skills', '技能')}</h1></div>
      <div className="agent-skills-header-actions">
        <button className="secondary-button" disabled={skills.length >= 50} onClick={() => setUploadOpen(true)}><Upload size={16} />{tr('Upload skills', '上传技能')}</button>
        <button className="primary-button" disabled={skills.some(skill => !skill.name.trim())} onClick={async () => { setError(''); try { await onSave({ skills }) } catch (e) { setError(String(e instanceof Error ? e.message : e)) } }}><Save size={16} />{t('Save')}</button>
      </div>
    </header>
    <p className="settings-note">{tr('Upload a ZIP containing one or more skills. Save to apply from the next message.', '上传包含一个或多个技能的 ZIP 压缩包，保存后从下一条消息开始生效。')}</p>
    {!skills.length && <div className="agent-skills-empty">{tr('No skills yet. Upload a skills ZIP to get started.', '还没有技能，上传技能 ZIP 压缩包吧。')}</div>}
    <div className="agent-skills-list">{skills.map(skill => <article key={skill.id} className={`agent-skill-card${skill.enabled ? '' : ' disabled'}`}>
      <button className="agent-skill-card-main" aria-label={`${tr('View skill', '查看技能')} ${skill.name}`} onClick={() => setSelected(skill.id)}>
        <span className="agent-skill-card-heading"><span className="agent-skill-card-title"><strong>{skill.name || tr('Untitled skill', '未命名技能')}</strong><span className="agent-skill-badge">skill</span></span></span>
        <span className="agent-skill-description">{skill.description || tr('No description', '暂无描述')}</span>
      </button>
      <div className="agent-skill-card-actions"><label className="agent-skill-toggle"><input type="checkbox" checked={skill.enabled} aria-label={`${tr('Enable', '启用')} ${skill.name}`} onChange={e => change(skills.map(item => item.id === skill.id ? { ...item, enabled: e.target.checked } : item))} />{skill.enabled ? tr('Enabled', '已启用') : tr('Disabled', '已停用')}</label>
        <button className="icon-button danger" aria-label={`${tr('Delete skill', '删除技能')} ${skill.name}`} onClick={() => { if (!window.confirm(tr('Delete this skill?', '删除这个技能？'))) return; change(skills.filter(item => item.id !== skill.id)); if (selected === skill.id) setSelected(undefined) }}><Trash2 size={15} /></button>
      </div>
    </article>)}</div>
    {active && <SkillDetailDialog skill={active} onClose={() => setSelected(undefined)} />}
    {uploadOpen && <SkillUploadDialog remaining={50 - skills.length} onClose={() => setUploadOpen(false)} onUpload={uploaded => {
      const next = [...skills, ...uploaded]
      validateAgentSkills(next)
      change(next); setError('')
    }} />}
    {error && <p className="settings-error" role="alert">{error}</p>}
  </section>
}
