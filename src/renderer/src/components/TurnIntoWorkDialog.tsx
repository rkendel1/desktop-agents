import { X } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent, type ReactElement } from 'react'
import { canRunWorkOnCompute } from '../../../shared/coding'
import type { AgentConfig, CodingSession, Project } from '../../../shared/types'
import { t } from '../preferences'
import { NativeDialog } from './NativeDialog'

export interface WorkDraft {
  title: string
  task: string
  preferredAgentId?: string
  workspacePath?: string
}

export function TurnIntoWorkDialog({ draft, projects, agents, onClose, onAddProject, onStarted }: {
  draft: WorkDraft
  projects: Project[]
  agents: AgentConfig[]
  onClose: () => void
  onAddProject: () => Promise<Project | undefined>
  onStarted: (session: CodingSession) => void
}): ReactElement {
  const initialProject = useMemo(() => projects.find(project => project.path === draft.workspacePath) ?? projects[0], [draft.workspacePath, projects])
  const [projectId, setProjectId] = useState(initialProject?.id ?? '')
  const [agentId, setAgentId] = useState(agents.some(agent => agent.id === draft.preferredAgentId) ? draft.preferredAgentId! : agents[0]?.id ?? '')
  const [task, setTask] = useState(draft.task)
  const [execution, setExecution] = useState<'local' | 'compute'>('compute')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const computeEligible = canRunWorkOnCompute(agents.find(agent => agent.id === agentId))
  useEffect(() => { if (!computeEligible) setExecution('local') }, [computeEligible])
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!projectId || !agentId || !task.trim() || busy) return
    setBusy(true); setError('')
    try {
      const session = await window.douchat.startCodingSession({ projectId, agentId, task: task.trim(), ...(execution === 'compute' ? { execution: { kind: 'compute' as const } } : {}) })
      onStarted(session)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(cause))
    } finally { setBusy(false) }
  }
  return <NativeDialog className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && !busy && onClose()} onClose={onClose}>
    <form className="agent-modal turn-work-modal" role="dialog" aria-modal="true" aria-labelledby="turn-work-title" onSubmit={event => void submit(event)}>
      <div className="modal-heading">
        <div><h2 id="turn-work-title">{t('Turn into work')}</h2><p>{draft.title}</p></div>
        <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label={t('Close')}><X size={18} /></button>
      </div>
      {!projects.length ? <div className="turn-work-empty">
        <p>{t('Add a project folder before starting this work.')}</p>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void onAddProject().then(project => { if (project) setProjectId(project.id) }).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))}>{t('Add project')}</button>
      </div> : <>
        <div className="two-fields">
          <label><span>{t('Project')}</span><select autoFocus value={projectId} onChange={event => setProjectId(event.target.value)}>{projects.map(project => <option key={project.id} value={project.id}>{project.name} — {project.path}</option>)}</select></label>
          <label><span>{t('Agent')}</span><select value={agentId} onChange={event => setAgentId(event.target.value)}>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
        </div>
        <label className="field-row"><span>{t('Execution')}</span><select value={execution} onChange={event => setExecution(event.target.value as 'local' | 'compute')}><option value="compute" disabled={!computeEligible}>{t('Compute environment')}</option><option value="local">{t('Project folder on this computer')}</option></select></label>
        <label className="field-row"><span>{t('Work instructions')}</span><textarea rows={12} value={task} onChange={event => setTask(event.target.value)} /></label>
        <p className="settings-note">{t('Review the instructions before starting. The agent will work in the selected project and the session will appear under Projects.')}</p>
        <div className="modal-footer"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>{t('Cancel')}</button><button className="primary-button" disabled={busy || !projectId || !agentId || !task.trim()}>{t(busy ? 'Starting…' : 'Start work')}</button></div>
      </>}
      {error && <p className="coding-error" role="alert">{error}</p>}
    </form>
  </NativeDialog>
}
