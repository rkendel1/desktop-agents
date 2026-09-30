import { FolderGit2, Plus, Search, X } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { DEFERRED_WORK_ERROR, codingDisplayState, codingStateLabels, formatCommandLine } from '../../../shared/coding'
import type { AppSnapshot, Conversation, DevelopmentEnvironmentView, GitState, Project, ProjectCommandOption } from '../../../shared/types'
import type { StoredJevEvaluation } from '../../../shared/jev'
import { t, tr } from '../preferences'
import { CiPanel } from './CiPanel'
import { EnvironmentPanel, EnvironmentStatus } from './EnvironmentPanel'
import { ApprovalCard, CodingSessionPanel } from './CodingSessionPanel'
import { BranchLine, GitPanel, ToolingLine } from './GitPanel'
import { SidebarResizer } from './common'
import { ChatPane } from './ChatPane'
import type { WorkDraft } from './TurnIntoWorkDialog'

export interface ProjectSelection { projectId?: string; sessionId?: string }

const when = (at?: number): string => at ? new Date(at).toLocaleString() : '—'
const seconds = (ms: number): string => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`

/**
 * The project home: what I am working on (project, repository, branch), what is happening (the running session and its approval),
 * what changed (Git, and what the last session changed), and what to do next (start, continue, review, check, commit).
 * Everything is read from Foundry's service, FeltDB and Git each time; nothing is kept here.
 */
function ProjectConversation({ project, snapshot, onCreateWork }: { project: Project; snapshot: AppSnapshot; onCreateWork: (draft: WorkDraft) => void }): ReactElement {
  const projected = (snapshot.conversations ?? []).filter(item => item.projectId === project.id)
  const [loaded, setLoaded] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState('')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const chats = [...new Map([...loaded, ...projected].map(chat => [chat.id, chat])).values()].sort((a, b) => b.updatedAt - a.updatedAt)
  const conversation = chats.find(chat => chat.id === activeId) ?? chats[0]
  useEffect(() => {
    let live = true
    setLoaded([]); setActiveId('')
    setError('')
    const request = typeof window.douchat.projectConversations === 'function'
      ? window.douchat.projectConversations(project.id)
      : typeof window.douchat.projectConversation === 'function'
        ? window.douchat.projectConversation(project.id).then(value => [value])
        : undefined
    if (!request) return () => { live = false }
    request.then(value => { if (live) { setLoaded(value); setActiveId(value[0]?.id ?? '') } }, cause => {
      if (live) setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(cause))
    })
    return () => { live = false }
  }, [project.id])
  const createChat = async (): Promise<void> => {
    if (!name.trim()) return
    setError('')
    try {
      const chat = await window.douchat.createProjectConversation({ projectId: project.id, name: name.trim() })
      setLoaded(current => [chat, ...current]); setActiveId(chat.id); setName(''); setCreating(false)
    } catch (cause) { setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(cause)) }
  }
  if (error && !conversation) return <section className="coding-section project-conversation"><h3>{t('Chats')}</h3><p className="coding-error" role="alert">{error}</p></section>
  if (!conversation) return <section className="coding-section project-conversation"><h3>{t('Chats')}</h3><p className="muted">{t('Opening project chats…')}</p></section>
  const topic = conversation.topics.find(item => item.id === conversation.activeTopicId) ?? conversation.topics[0]
  const messages = (snapshot.messages ?? []).filter(message => message.conversationId === conversation.id && (!topic || message.topicId === topic.id))
  const members = conversation.agentIds.map(id => snapshot.agents.find(agent => agent.id === id)).filter((agent): agent is NonNullable<typeof agent> => Boolean(agent))
  const activity = (snapshot.activity ?? []).find(item => item.conversationId === conversation.id && item.topicId === topic?.id)
  return <section className="coding-section project-conversation" aria-label={t('Project chats')}>
    <div className="project-conversation-heading"><div><h3>{t('Chats')}</h3><p className="muted">{t('Discuss and plan here. Chat replies do not start coding work; use Turn into work or the Work tab when you want files changed.')}</p></div>
      <button className="primary-button" onClick={() => setCreating(current => !current)}>{t(creating ? 'Cancel' : 'New chat')}</button></div>
    {creating && <form className="project-new-chat" onSubmit={event => { event.preventDefault(); void createChat() }}>
      <input autoFocus value={name} onChange={event => setName(event.target.value)} maxLength={80} placeholder={t('Chat name, e.g. Architecture')} aria-label={t('Chat name')} />
      <button className="primary-button" type="submit" disabled={!name.trim()}>{t('Create chat')}</button>
    </form>}
    {error && <p className="coding-error" role="alert">{error}</p>}
    <div className="project-chat-layout">
      <nav className="project-chat-list" aria-label={t('Project chats')}>{chats.map(chat => {
        const count = (snapshot.messages ?? []).filter(message => message.conversationId === chat.id).length
        return <button key={chat.id} className={chat.id === conversation.id ? 'active' : ''} onClick={() => setActiveId(chat.id)}><strong>{chat.name}</strong><small>{tr('{count} messages', { count })}</small></button>
      })}</nav>
      <div className="project-chat-stage"><ChatPane
      key={`${conversation.id}:${topic?.id}`} userName={snapshot.userName} userAvatar={snapshot.userAvatar}
      conversation={conversation} topic={topic} messages={messages} allMessages={snapshot.messages ?? []}
      agents={snapshot.agents} members={members} activity={activity}
      offline={snapshot.runtime?.mode === 'offline' && !members.some(agent => agent.localAgentId)}
      onConnect={() => undefined} inspectorOpen={false} onToggleInspector={() => undefined}
      onOpenAgentProfile={() => undefined} onOpenUserProfile={() => undefined} onCreateWork={onCreateWork}
      onSend={(text, images, files, mentions) => window.douchat.sendMessage(conversation.id, text, images, files, mentions)}
      onStop={() => { void window.douchat.stopConversation(conversation.id) }} />
      </div>
    </div>
  </section>
}

function ProjectPanel({ project, snapshot, initialSessionId, onCreateWork }: { project: Project; snapshot: AppSnapshot; initialSessionId?: string; onCreateWork?: (draft: WorkDraft) => void }): ReactElement {
  const [section, setSection] = useState<'chats' | 'work' | 'environment' | 'checks' | 'history'>('chats')
  const [selectedSessionId, setSelectedSessionId] = useState(initialSessionId ?? '')
  const [git, setGit] = useState<GitState | { error: string }>()
  const [agentId, setAgentId] = useState('')
  const [task, setTask] = useState('')
  const [command, setCommand] = useState('')
  const [commandChoice, setCommandChoice] = useState('')
  const [commandOptions, setCommandOptions] = useState<ProjectCommandOption[]>()
  const [commandDiscoveryError, setCommandDiscoveryError] = useState('')
  const [execution, setExecution] = useState<'local' | 'compute'>('compute')
  const [environment, setEnvironment] = useState<DevelopmentEnvironmentView>()
  const [evaluations, setEvaluations] = useState<StoredJevEvaluation[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const sessions = (snapshot.codingSessions ?? []).filter(session => session.projectId === project.id)
  const running = sessions.find(session => session.status === 'running')
  const latest = sessions[0]
  const selectedSession = sessions.find(session => session.id === selectedSessionId)
  const activity = running ? snapshot.codingActivity?.find(item => item.sessionId === running.id) : undefined
  const agents = snapshot.agents
  const chosenAgent = agentId || agents[0]?.id || ''
  const agentOf = (id: string) => agents.find(agent => agent.id === id)

  // Git is read when the project opens, whenever a session starts, ends or runs a check, when the window returns, and while an agent works.
  const refreshGit = useCallback(async (): Promise<void> => {
    if (!project.isGit) { setGit(undefined); return }
    try { setGit(await window.douchat.projectGitStatus(project.id)) } catch (cause) { setGit({ error: cause instanceof Error ? cause.message : String(cause) }) }
  }, [project.id, project.isGit])
  const signature = sessions.map(session => `${session.id}:${session.status}:${session.commands.length}:${session.events.length}`).join()
  useEffect(() => { setGit(undefined); void refreshGit() }, [refreshGit, signature])
  useEffect(() => {
    const onFocus = (): void => { void refreshGit() }
    window.addEventListener('focus', onFocus)
    const timer = running ? setInterval(onFocus, 4000) : undefined
    return () => { window.removeEventListener('focus', onFocus); if (timer) clearInterval(timer) }
  }, [refreshGit, running?.id])
  // The project's environment is asked of Compute when it is chosen as the place to run: Foundry keeps a reference, not a list of Computers.
  useEffect(() => {
    let live = true
    setEnvironment(undefined)
    window.douchat.environmentState(project.id).then(value => { if (live) setEnvironment(value) }, () => { if (live) setEnvironment(undefined) })
    return () => { live = false }
  }, [project.id])
  useEffect(() => {
    setSelectedSessionId(initialSessionId ?? '')
    setSection(initialSessionId ? 'work' : 'chats')
  }, [initialSessionId, project.id])
  useEffect(() => {
    let live = true
    const saved = project.testCommand ? formatCommandLine(project.testCommand) : ''
    setCommand(saved); setCommandChoice(''); setCommandOptions(undefined); setCommandDiscoveryError('')
    window.douchat.discoverProjectCommands(project.id).then(options => {
      if (!live) return
      setCommandOptions(options)
      const matched = options.findIndex(option => formatCommandLine(option.command) === saved)
      if (matched >= 0) setCommandChoice(String(matched))
      else if (saved) setCommandChoice('custom')
      else {
        const recommended = Math.max(0, options.findIndex(option => option.operation === 'test'))
        if (options[recommended]) { setCommandChoice(String(recommended)); setCommand(formatCommandLine(options[recommended].command)) }
        else setCommandChoice('custom')
      }
    }, cause => {
      if (!live) return
      setCommandOptions([]); setCommandChoice('custom')
      setCommandDiscoveryError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(cause))
    })
    return () => { live = false }
  }, [project.id, project.testCommand])
  useEffect(() => {
    let live = true
    const refresh = (): void => {
      void window.douchat.listJevEvaluations(project.id).then(value => { if (live) setEvaluations(value) }, () => { if (live) setEvaluations([]) })
    }
    refresh()
    window.addEventListener('focus', refresh)
    const timer = setInterval(refresh, 4000)
    return () => { live = false; window.removeEventListener('focus', refresh); clearInterval(timer) }
  }, [project.id])
  const guard = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setError('')
    try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(cause)) }
    finally { setBusy(false) }
  }
  const recentChecks = sessions.flatMap(session => session.commands.map(result => ({ result, session }))).sort((a, b) => b.result.startedAt - a.result.startedAt).slice(0, 5)
  const lastState = latest ? codingDisplayState(latest) : undefined
  const openSession = (id: string): void => { setSelectedSessionId(id); setSection('work') }
  return <div className="coding-project">
    <header>
      <h2>{project.name}</h2>
      <p className="coding-meta"><code>{project.path}</code></p>
      <p className="coding-meta"><BranchLine git={git} project={project} /></p>
      <ToolingLine project={project} refreshKey={signature} />
    </header>

    <nav className="project-section-tabs" role="tablist" aria-label={t('Project sections')}>
      {([['chats', 'Chats'], ['work', 'Work'], ['environment', 'Environment'], ['checks', 'Checks'], ['history', 'History']] as const).map(([id, label]) =>
        <button key={id} role="tab" aria-selected={section === id} className={section === id ? 'active' : ''} onClick={() => setSection(id)}>{t(label)}
          {id === 'work' && running ? <span className="project-tab-badge is-running">1</span> : null}
          {id === 'environment' && environment ? <span className={`project-tab-dot is-${environment.state}`} aria-label={t(environment.state)} /> : null}
        </button>)}
    </nav>
    <div className="project-section-summary" role="status">
      <span><strong>{t('Chat')}</strong> {t('plan and decide')}</span><span aria-hidden>→</span><span><strong>{t('Work')}</strong> {t('assign executable changes')}</span><span aria-hidden>→</span><span><strong>{t('History')}</strong> {t('review results')}</span>
    </div>

    {section === 'chats' && <ProjectConversation project={project} snapshot={snapshot} onCreateWork={onCreateWork ?? (() => undefined)} />}

    {section === 'environment' && <EnvironmentPanel project={project} />}

    {section === 'work' && selectedSession && <>
      <div className="project-work-detail-heading">
        <button className="secondary-button" onClick={() => setSelectedSessionId('')}>{t('Back to project work')}</button>
        <span className="muted">{t('Work details stay inside this project.')}</span>
      </div>
      <CodingSessionPanel session={selectedSession} project={project}
        messages={(snapshot.messages ?? []).filter(message => message.conversationId === selectedSession.conversationId && message.topicId === selectedSession.topicId)}
        agent={snapshot.agents.find(agent => agent.id === selectedSession.agentId)}
        activity={snapshot.codingActivity?.find(activity => activity.sessionId === selectedSession.id)} />
    </>}

    {section === 'work' && !selectedSession && <>

    <section className="coding-section" aria-label={t('Now')}>
      <h3>{running ? t('Happening now') : t('Last time')}</h3>
      {running ? <>
        <p className="coding-meta"><span className={`coding-state coding-state-${codingDisplayState(running, activity)}`} role="status">{t(codingStateLabels[codingDisplayState(running, activity)])}</span>
          {' · '}{agentOf(running.agentId)?.name ?? running.agentId}{' · '}{running.execution?.kind === 'compute' ? `${t('Environment')} ${running.execution.environment}` : t('This Computer')}</p>
        <p className="coding-task">{running.task.split('\n')[0]}</p>
        {activity?.state === 'awaiting-approval'
          ? <ApprovalCard activity={activity} session={running} project={project} agent={agentOf(running.agentId)} onCancel={() => void guard(() => window.douchat.cancelCodingSession(running.id))} />
          : <p><span className="coding-pulse" aria-hidden />{activity?.label ?? t('Running…')}</p>}
        <div className="coding-actions">
          <button className="secondary-button" onClick={() => openSession(running.id)}>{t('Open details')}</button>
          {activity?.state !== 'awaiting-approval' && <button className="secondary-button danger" disabled={busy} onClick={() => void guard(() => window.douchat.cancelCodingSession(running.id))}>{t('Cancel session')}</button>}
        </div>
      </> : latest ? <>
        <p className="coding-meta"><span className={`coding-state coding-state-${lastState}`}>{t(codingStateLabels[lastState!])}</span>
          {' · '}{agentOf(latest.agentId)?.name ?? latest.agentId}{' · '}{latest.execution?.kind === 'compute' ? `${t('Compute')} ${latest.execution.environment}` : t('This Computer')}{' · '}{when(latest.finishedAt ?? latest.startedAt ?? latest.createdAt)}</p>
        <p className="coding-task">{latest.task.split('\n')[0]}</p>
        {latest.result && latest.status !== 'cancelled' && <p className="muted">{latest.result.slice(0, 240)}{latest.result.length > 240 ? '…' : ''}</p>}
        {latest.error && latest.status !== 'interrupted' && <p className="coding-error">{latest.error}</p>}
        <p className="muted">{tr('{count} changed files', { count: latest.changes.filter(change => change.origin === 'session').length })} · {tr('{count} checks', { count: latest.commands.length })}</p>
        {latest.status === 'succeeded' && lastState === 'failed' && <p className="coding-error" role="alert">{t(DEFERRED_WORK_ERROR)}</p>}
        <div className="coding-actions">
          {latest.status === 'interrupted' && <button className="primary-button" disabled={busy} onClick={() => void guard(async () => { await window.douchat.continueCodingSession(latest.id); openSession(latest.id) })}>{t('Continue')}</button>}
          <button className="secondary-button" onClick={() => openSession(latest.id)}>{t('Open details')}</button>
        </div>
      </> : <p className="muted">{t('No sessions yet.')}</p>}
    </section>

    <section className="coding-section project-assign-work" aria-label={t('Assign work')}>
      <h3>{t('Assign executable work')}</h3>
      <p className="muted">{t('Use this box when you want an agent to inspect or change project files. Work starts only after you click Start work, and its progress appears above.')}</p>
      {!agents.length ? <p className="muted">{t('Create an agent first.')}</p> : <form className="coding-start" onSubmit={event => {
        event.preventDefault()
        if (!task.trim()) return
        void guard(async () => { const session = await window.douchat.startCodingSession({ projectId: project.id, agentId: chosenAgent, task, ...(execution === 'compute' ? { execution: { kind: 'compute' as const } } : {}) }); setTask(''); openSession(session.id) })
      }}>
        <label>{t('Agent')}
          <select value={chosenAgent} onChange={event => setAgentId(event.target.value)}>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>
        </label>
        <label>{t('Execution')}
          <select value={execution} onChange={event => setExecution(event.target.value as 'local' | 'compute')}>
            <option value="compute">{t('Compute environment (recommended)')}</option>
            <option value="local">{t('This Computer — local fallback')}</option>
          </select>
        </label>
        <p className="muted coding-note">{execution === 'local' ? t('Local execution: the agent runs on this computer, in this folder. No network or Compute is needed.') : t('Environment: the agent runs on this project’s Compute environment, on a checkout of the committed revision, once Compute reports it ready. If it is not ready, nothing starts here instead.')}</p>
        {execution === 'compute' && <div className="coding-compute" aria-label={t('Environment')}>
          {!environment ? <p className="muted">{t('Asking Compute…')}</p> : <>
            <p className="coding-meta">{environment.reference ? <>{environment.recipe?.name ?? environment.reference.environment}{environment.computer?.platformLabel ? ` · ${environment.computer.platformLabel}` : ''} · </> : null}<EnvironmentStatus view={environment} /></p>
            {environment.state !== 'ready' && environment.state !== 'degraded' && <p className="coding-error" role="alert">{environment.reason ? `${t(environment.reason.title)} ${t(environment.reason.message)}` : environment.state === 'none' ? t('This project has no development environment yet. Create one above.') : t('The environment is not ready for workloads.')} {t('Nothing will run on this computer instead.')}</p>}
          </>}
        </div>}
        <textarea value={task} onChange={event => setTask(event.target.value)} rows={3} placeholder={t('Describe the files, behavior, or result you want changed…')} aria-label={t('Work request')} />
        <button className="primary-button" type="submit" disabled={busy || !!running && running.agentId === chosenAgent || !task.trim() || (execution === 'compute' && environment?.state !== 'ready' && environment?.state !== 'degraded')}>{t('Start work')}</button>
      </form>}
      {error && <p className="coding-error" role="alert">{error}</p>}
    </section>

    <GitPanel project={project} git={git} onRefresh={refreshGit} latest={latest} running={!!running} />
    </>}

    {section === 'checks' && <>
    <section className="coding-section" aria-label={t('Check command')}>
      <h3>{t('Checks')}</h3>
      <p className="muted">{project.testCommand ? <code>{formatCommandLine(project.testCommand)}</code> : t('None. Set the command that “Run checks” should run in this project, for example npm test.')}</p>
      <form className="coding-check-command" onSubmit={event => { event.preventDefault(); void guard(async () => { await window.douchat.setProjectTestCommand(project.id, command) }) }}>
        <div className="coding-inline">
          <select value={commandChoice} disabled={commandOptions === undefined} aria-label={t('Check command')} onChange={event => {
            const choice = event.target.value
            setCommandChoice(choice)
            if (choice === 'none') setCommand('')
            else if (choice !== 'custom') setCommand(formatCommandLine(commandOptions?.[Number(choice)]?.command ?? []))
          }}>
            {commandOptions === undefined && <option value="">{t('Discovering project commands…')}</option>}
            {commandOptions?.map((option, index) => <option key={`${option.operation}:${formatCommandLine(option.command)}`} value={String(index)}>{t(option.operation)} — {formatCommandLine(option.command)}</option>)}
            <option value="custom">{t('Custom command…')}</option>
            <option value="none">{t('No check command')}</option>
          </select>
          <button className="secondary-button" type="submit" disabled={busy || commandOptions === undefined}>{t('Use command')}</button>
        </div>
        {commandChoice === 'custom' && <input value={command} onChange={event => setCommand(event.target.value)} placeholder="npm test" aria-label={t('Custom check command')} />}
      </form>
      {commandDiscoveryError && <p className="muted coding-note">{t(commandDiscoveryError)} {t('You can still enter a custom command.')}</p>}
      {commandOptions?.length === 0 && !commandDiscoveryError && <p className="muted coding-note">{t('No project check commands were discovered. You can still enter a custom command.')}</p>}
      {project.testCommand && latest && !running && <button className="primary-button" disabled={busy} onClick={() => void guard(async () => { await window.douchat.runCodingChecks(latest.id) })}>{t('Run checks')}</button>}
      {project.testCommand && !latest && <p className="muted">{t('Checks are recorded in a coding session; start one to run them.')}</p>}
      {!!recentChecks.length && <ul className="coding-checks">{recentChecks.map(({ result, session }) => <li key={`${session.id}-${result.startedAt}`} className="coding-check">
        <code>{formatCommandLine(result.argv)}</code>
        <span className={result.exitCode === 0 ? 'coding-ok' : 'coding-bad'}>{result.exitCode === 0 ? '✓' : '✗'} {result.cancelled ? t('cancelled') : result.timedOut ? t('timed out') : tr('exit {code}', { code: result.exitCode ?? result.signal ?? '?' })}</span>
        <span className="muted"> · {seconds(result.durationMs)} · {when(result.startedAt)}</span>
        <button className="secondary-button" onClick={() => openSession(session.id)}>{t('Open details')}</button>
      </li>)}</ul>}
    </section>

    {project.isGit && <CiPanel project={project} runs={(snapshot.ciRuns ?? []).filter(run => run.projectId === project.id)} />}
    </>}

    {section === 'history' && <>
    <section className="coding-section" aria-label="Structured decisions">
      <h3>Structured decisions</h3>
      {!evaluations.length ? <p className="muted">No Jev evaluations yet.</p> : <div className="jev-results">{evaluations.slice(0, 10).map(({ question, result, context }) =>
        <details key={result.evaluationId} className="jev-result">
          <summary><span className={result.decision.status === 'pass' ? 'coding-ok' : result.decision.status === 'fail' ? 'coding-bad' : ''}>{result.decision.status.toUpperCase()}</span> {question.question}</summary>
          <p className="muted">{result.evaluations.length} rules · {question.inputs.length} evidence items · {result.uncertainty.length} uncertainty · {when(Date.parse(result.provenance.timestamp))}</p>
          <p className="muted">Evaluated by Jev {result.provenance.jevVersion} · {result.provenance.runtime} · {result.provenance.model}{context.sourceAgentId ? ` · agent ${context.sourceAgentId}` : ''}</p>
          <ul>{result.evaluations.map(item => <li key={item.ruleId}><code>{item.ruleId}</code>: {item.result.toUpperCase()}{item.explanation ? ` — ${item.explanation}` : ''}</li>)}</ul>
          <details><summary>Evidence</summary><ul>{question.inputs.map(item => <li key={item.id}><code>{item.name}</code>: <code>{JSON.stringify(item.value)}</code></li>)}</ul></details>
          {!!result.uncertainty.length && <p className="coding-error">{result.uncertainty.join(' · ')}</p>}
        </details>)}</div>}
    </section>

    <section className="coding-section" aria-label={t('Work history')}>
      <h3>{t('Work history')}</h3>
      {!sessions.length ? <p className="muted">{t('No sessions yet.')}</p> : <ul className="coding-session-list">
        {sessions.map(session => {
          const state = codingDisplayState(session, snapshot.codingActivity?.find(item => item.sessionId === session.id))
          return <li key={session.id}><button onClick={() => openSession(session.id)}>
            <span className={`coding-state coding-state-${state}`}>{t(codingStateLabels[state])}</span> {session.task.split('\n')[0]}
            <span className="muted"> · {agentOf(session.agentId)?.name ?? session.agentId} · {session.execution?.kind === 'compute' ? t('Compute') : t('This Computer')} · {when(session.finishedAt ?? session.startedAt ?? session.createdAt)}</span>
          </button></li>
        })}
      </ul>}
    </section>
    </>}
  </div>
}

/** The Projects surface: folders agents work in, and the coding sessions run there. Everything shown comes from the snapshot or from Git. */
export function ProjectsView({ snapshot, selection, onSelect, onCreateWork }: { snapshot: AppSnapshot; selection: ProjectSelection; onSelect: (selection: ProjectSelection) => void; onCreateWork?: (draft: WorkDraft) => void }): ReactElement {
  const projects = snapshot.projects ?? []
  const sessions = snapshot.codingSessions ?? []
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const search = query.trim().toLocaleLowerCase()
  const visibleProjects = projects.filter(item => !search || item.name.toLocaleLowerCase().includes(search) || item.path.toLocaleLowerCase().includes(search)
    || sessions.some(candidate => candidate.projectId === item.id && candidate.task.toLocaleLowerCase().includes(search)))
  const session = sessions.find(item => item.id === selection.sessionId)
  const project = projects.find(item => item.id === (selection.projectId ?? session?.projectId))
  const add = async (): Promise<void> => {
    setError('')
    try { const added = await window.douchat.chooseProject(); if (added) onSelect({ projectId: added.id }) }
    catch (cause) { setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(cause)) }
  }
  return <>
    <aside className="sidebar contacts-sidebar coding-sidebar" aria-label={t('Projects')}>
      <SidebarResizer />
      <div className="sidebar-titlebar window-drag">
        <div className="search-box no-drag"><Search size={15} /><input data-app-search aria-keyshortcuts="Meta+F Control+F" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Search projects')} aria-label={t('Search projects')} />{query && <button onClick={() => setQuery('')} aria-label={t('Clear search')}><X size={13} /></button>}</div>
        <div className="sidebar-titlebar-actions no-drag"><button className="sidebar-add" onClick={() => void add()} aria-label={t('Add project')} title={t('Add project')}><Plus size={18} /></button></div>
      </div>
      {error && <p className="coding-error" role="alert">{error}</p>}
      <div className="contact-list">
        {!projects.length && <p className="empty-search">{t('No projects yet. Add a local repository to let an agent work in it.')}</p>}
        {!!projects.length && !visibleProjects.length && <p className="empty-search">{t('No matching projects')}</p>}
        {visibleProjects.map(item => <div key={item.id}>
          <button className={`contact-row ${item.id === project?.id ? 'active' : ''}`} onClick={() => onSelect({ projectId: item.id })}>
            <FolderGit2 size={18} /><span className="contact-row-copy"><strong>{item.name}</strong><small>{item.path}</small></span>
          </button>
        </div>)}
      </div>
    </aside>
    <main className="workspace coding-workspace">
      {project ? <ProjectPanel project={project} snapshot={snapshot} initialSessionId={session?.id} onCreateWork={onCreateWork} />
          : <div className="contact-empty-copy"><h2>{t('Projects')}</h2><p className="muted">{t('Choose a project, or add a local repository.')}</p>
            <button className="primary-button" onClick={() => void add()}>{t('Add project')}</button></div>}
    </main>
  </>
}
