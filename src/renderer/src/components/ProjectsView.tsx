import { FolderGit2, Plus } from 'lucide-react'
import { useEffect, useState, type ReactElement } from 'react'
import { codingDisplayState, codingStateLabels, formatCommandLine } from '../../../shared/coding'
import type { AppSnapshot, ComputeInventory, GitState, Project } from '../../../shared/types'
import { t, tr } from '../preferences'
import { CiPanel } from './CiPanel'
import { CodingSessionPanel } from './CodingSessionPanel'

export interface ProjectSelection { projectId?: string; sessionId?: string }

function ProjectPanel({ project, snapshot, onOpenSession }: { project: Project; snapshot: AppSnapshot; onOpenSession: (id: string) => void }): ReactElement {
  const [git, setGit] = useState<GitState | { error: string }>()
  const [agentId, setAgentId] = useState('')
  const [task, setTask] = useState('')
  const [command, setCommand] = useState('')
  const [execution, setExecution] = useState<'local' | 'compute'>('local')
  const [environment, setEnvironment] = useState('')
  const [inventory, setInventory] = useState<ComputeInventory>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const sessions = (snapshot.codingSessions ?? []).filter(session => session.projectId === project.id)
  useEffect(() => {
    let live = true
    setGit(undefined)
    if (!project.isGit) return
    window.douchat.projectGitStatus(project.id).then(state => { if (live) setGit(state) }, cause => { if (live) setGit({ error: cause instanceof Error ? cause.message : String(cause) }) })
    return () => { live = false }
  }, [project.id, project.isGit, sessions.map(session => `${session.id}:${session.status}`).join()])
  // Compute's inventory is asked for when Compute is chosen and read from Compute each time: Foundry keeps no list of Computers.
  useEffect(() => {
    if (execution !== 'compute') return
    let live = true
    setInventory(undefined)
    window.douchat.computeInventory().then(value => { if (live) { setInventory(value); setEnvironment(current => value.environments.some(item => item.name === current) ? current : value.environments.find(item => item.observed === 'running')?.name ?? '') } },
      cause => { if (live) setInventory({ available: false, reason: cause instanceof Error ? cause.message : String(cause), daemon: { endpoint: '', reachable: false }, environments: [] }) })
    return () => { live = false }
  }, [execution])
  const agents = snapshot.agents
  const chosenAgent = agentId || agents[0]?.id || ''
  const guard = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setError('')
    try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(cause)) }
    finally { setBusy(false) }
  }
  return <div className="coding-project">
    <header>
      <h2>{project.name}</h2>
      <p className="coding-meta"><code>{project.path}</code></p>
      <p className="coding-meta muted">
        {!project.isGit ? t('Not a Git repository') : !git ? t('Reading Git status…') : 'error' in git ? git.error
          : `${git.branch ?? t('detached HEAD')} · ${git.changes.length ? tr('{count} changed files', { count: git.changes.length }) : t('clean')}`}
      </p>
    </header>

    <section className="coding-section" aria-label={t('Check command')}>
      <h3>{t('Check command')}</h3>
      <p className="muted">{project.testCommand ? <code>{formatCommandLine(project.testCommand)}</code> : t('None. Set the command that “Run checks” should run in this project, for example npm test.')}</p>
      <form className="coding-inline" onSubmit={event => { event.preventDefault(); void guard(async () => { await window.douchat.setProjectTestCommand(project.id, command); setCommand('') }) }}>
        <input value={command} onChange={event => setCommand(event.target.value)} placeholder="npm test" aria-label={t('Check command')} />
        <button className="secondary-button" type="submit" disabled={busy}>{t('Set…')}</button>
      </form>
    </section>

    <section className="coding-section" aria-label={t('Start a coding session')}>
      <h3>{t('Start a coding session')}</h3>
      {!agents.length ? <p className="muted">{t('Create an agent first.')}</p> : <form className="coding-start" onSubmit={event => {
        event.preventDefault()
        if (!task.trim()) return
        void guard(async () => { const session = await window.douchat.startCodingSession({ projectId: project.id, agentId: chosenAgent, task, ...(execution === 'compute' ? { execution: { kind: 'compute' as const, environment } } : {}) }); setTask(''); onOpenSession(session.id) })
      }}>
        <label>{t('Agent')}
          <select value={chosenAgent} onChange={event => setAgentId(event.target.value)}>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>
        </label>
        <label>{t('Execution')}
          <select value={execution} onChange={event => setExecution(event.target.value as 'local' | 'compute')}>
            <option value="local">{t('Local')}</option>
            <option value="compute">{t('Compute')}</option>
          </select>
        </label>
        {execution === 'compute' && <div className="coding-compute" aria-label={t('Compute')}>
          {!inventory ? <p className="muted">{t('Asking Compute…')}</p> : <>
            {inventory.platform && <p className="coding-meta"><span className={`coding-platform coding-platform-${inventory.platform.status}`}>{t(inventory.platform.label)}</span>{inventory.installation ? <span className="muted"> · Compute Configured {inventory.installation.version}</span> : null}</p>}
            {inventory.available && inventory.environments.length > 0 && <label>{t('Computer')}
              <select value={environment} onChange={event => setEnvironment(event.target.value)}>
                <option value="" disabled>{t('Choose a Computer')}</option>
                {inventory.environments.map(item => <option key={item.environmentId} value={item.name}>{item.name} — {item.observed}</option>)}
              </select>
            </label>}
            {inventory.available && !inventory.environments.length && <p className="muted">{t('Compute has no Computers yet. Create one in Compute.')}</p>}
            {!inventory.available && <p className="coding-error" role="alert">{inventory.reason}</p>}
            <button type="button" className="secondary-button" onClick={() => void window.douchat.openComputeUi()}>{t('Open Compute')}</button>
          </>}
        </div>}
        <textarea value={task} onChange={event => setTask(event.target.value)} rows={3} placeholder={t('What should the agent do in this project?')} aria-label={t('Task')} />
        <button className="primary-button" type="submit" disabled={busy || !task.trim() || (execution === 'compute' && !environment)}>{t('Start session')}</button>
      </form>}
      {error && <p className="coding-error" role="alert">{error}</p>}
    </section>

    {project.isGit && <CiPanel project={project} runs={(snapshot.ciRuns ?? []).filter(run => run.projectId === project.id)} />}

    <section className="coding-section" aria-label={t('Sessions')}>
      <h3>{t('Sessions')}</h3>
      {!sessions.length ? <p className="muted">{t('No sessions yet.')}</p> : <ul className="coding-session-list">
        {sessions.map(session => {
          const state = codingDisplayState(session, snapshot.codingActivity?.find(item => item.sessionId === session.id))
          return <li key={session.id}><button onClick={() => onOpenSession(session.id)}>
            <span className={`coding-state coding-state-${state}`}>{t(codingStateLabels[state])}</span> {session.task}
          </button></li>
        })}
      </ul>}
    </section>
  </div>
}

/** The Projects surface: folders agents work in, and the coding sessions run there. Everything shown comes from the snapshot or from Git. */
export function ProjectsView({ snapshot, selection, onSelect }: { snapshot: AppSnapshot; selection: ProjectSelection; onSelect: (selection: ProjectSelection) => void }): ReactElement {
  const projects = snapshot.projects ?? []
  const sessions = snapshot.codingSessions ?? []
  const [error, setError] = useState('')
  const session = sessions.find(item => item.id === selection.sessionId)
  const project = projects.find(item => item.id === (selection.projectId ?? session?.projectId))
  const add = async (): Promise<void> => {
    setError('')
    try { const added = await window.douchat.chooseProject(); if (added) onSelect({ projectId: added.id }) }
    catch (cause) { setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(cause)) }
  }
  return <>
    <aside className="sidebar contacts-sidebar coding-sidebar" aria-label={t('Projects')}>
      <div className="sidebar-titlebar window-drag"><h1 className="sidebar-title">{t('Projects')}</h1>
        <button className="sidebar-add no-drag" onClick={() => void add()} aria-label={t('Add project')} title={t('Add project')}><Plus size={18} /></button></div>
      {error && <p className="coding-error" role="alert">{error}</p>}
      <div className="contact-list">
        {!projects.length && <p className="empty-search">{t('No projects yet. Add a local repository to let an agent work in it.')}</p>}
        {projects.map(item => <div key={item.id}>
          <button className={`contact-row ${item.id === project?.id && !session ? 'active' : ''}`} onClick={() => onSelect({ projectId: item.id })}>
            <FolderGit2 size={18} /><span className="contact-row-copy"><strong>{item.name}</strong><small>{item.path}</small></span>
          </button>
          {sessions.filter(candidate => candidate.projectId === item.id).slice(0, 5).map(candidate => {
            const state = codingDisplayState(candidate, snapshot.codingActivity?.find(activity => activity.sessionId === candidate.id))
            return <button key={candidate.id} className={`contact-row coding-session-row ${candidate.id === session?.id ? 'active' : ''}`} onClick={() => onSelect({ projectId: item.id, sessionId: candidate.id })}>
              <span className={`coding-dot coding-state-${state}`} aria-hidden /><span className="contact-row-copy"><strong>{candidate.task}</strong><small>{t(codingStateLabels[state])}</small></span>
            </button>
          })}
        </div>)}
      </div>
    </aside>
    <main className="workspace coding-workspace">
      {session ? <CodingSessionPanel session={session} project={project} agent={snapshot.agents.find(agent => agent.id === session.agentId)}
          activity={snapshot.codingActivity?.find(activity => activity.sessionId === session.id)} />
        : project ? <ProjectPanel project={project} snapshot={snapshot} onOpenSession={id => onSelect({ projectId: project.id, sessionId: id })} />
          : <div className="contact-empty-copy"><h2>{t('Projects')}</h2><p className="muted">{t('Choose a project, or add a local repository.')}</p>
            <button className="primary-button" onClick={() => void add()}>{t('Add project')}</button></div>}
    </main>
  </>
}
