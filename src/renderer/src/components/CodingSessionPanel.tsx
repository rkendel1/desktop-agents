import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { canContinue, changeLabel, codingDisplayState, codingStateLabels, describeApproval, formatCommandLine, isUntracked } from '../../../shared/coding'
import type { AgentConfig, CodingActivity, CodingSession, CommandResult, GitState, Project } from '../../../shared/types'
import { t } from '../preferences'

const time = (at?: number): string => at ? new Date(at).toLocaleString() : '—'

/** "Agent wants to: …", with where it will happen and who is asking — and the only ways to answer. */
export function ApprovalCard({ activity, session, project, agent, onCancel }: {
  activity: CodingActivity; session: CodingSession; project?: Project; agent?: AgentConfig; onCancel: () => void
}): ReactElement | null {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = activity.approval
  if (!request) return null
  const { verb, target } = describeApproval(request, project?.path)
  const answer = async (allow: boolean): Promise<void> => {
    setBusy(true); setError('')
    try { await window.douchat.resolveAgentPermission(request.id, allow) }
    catch { setError(t('Could not save changes')) }
    finally { setBusy(false) }
  }
  return <section className="coding-approval" role="alertdialog" aria-label={t('Approval needed')}>
    <p className="coding-approval-context">{agent?.name ?? request.agentName} · {project?.name ?? session.projectId} · <code>{project?.path ?? session.workingDirectory}</code></p>
    <p className="coding-approval-ask">{t('Agent wants to:')}</p>
    <pre className="coding-approval-action"><strong>{verb}</strong> {target}</pre>
    {error && <p role="alert">{error}</p>}
    <div className="coding-actions">
      <button className="primary-button" disabled={busy} onClick={() => void answer(true)}>{t('Allow')}</button>
      <button className="secondary-button" disabled={busy} onClick={() => void answer(false)}>{t('Deny')}</button>
      <button className="secondary-button danger" disabled={busy} onClick={onCancel}>{t('Cancel session')}</button>
    </div>
  </section>
}

function ChangeList({ session, project, live }: { session: CodingSession; project?: Project; live?: GitState }): ReactElement {
  const [selected, setSelected] = useState<string>()
  const [diff, setDiff] = useState<{ diff: string; truncated: boolean } | { error: string }>()
  const changes = live?.changes ?? session.changes
  const select = async (path: string, untracked: boolean): Promise<void> => {
    setSelected(path); setDiff(undefined)
    if (untracked || !project) return
    try { setDiff(await window.douchat.projectGitDiff(project.id, path)) } catch (error) { setDiff({ error: error instanceof Error ? error.message : String(error) }) }
  }
  const chosen = changes.find(change => change.path === selected)
  return <section className="coding-section" aria-label={t('Changed files')}>
    <h3>{t('Changed files')}</h3>
    {!changes.length ? <p className="muted">{t('No files changed')}</p> : <ul className="coding-changes">
      {changes.map(change => <li key={change.path}>
        <button className={change.path === selected ? 'active' : ''} onClick={() => void select(change.path, isUntracked(change))} title={t(changeLabel(change))}>
          <code className="coding-change-code">{change.code.replace(/ /g, ' ')}</code> <span>{change.path}</span>
        </button>
      </li>)}
    </ul>}
    {chosen && (isUntracked(chosen)
      ? <p className="coding-untracked">{t('Untracked — not included in git diff')}</p>
      : diff && ('error' in diff ? <p role="alert">{diff.error}</p>
        : diff.diff ? <><pre className="coding-diff">{diff.diff}</pre>{diff.truncated && <p className="muted">{t('The diff was cut short.')}</p>}</>
          : <p className="muted">{t('No differences from the last commit.')}</p>))}
  </section>
}

function CheckResult({ result }: { result: CommandResult }): ReactElement {
  const ok = result.exitCode === 0
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
  return <li className="coding-check">
    <code>{formatCommandLine(result.argv)}</code>
    <span className={ok ? 'coding-ok' : 'coding-bad'}>{ok ? '✓' : '✗'} {result.cancelled ? t('cancelled') : result.timedOut ? t('timed out') : `exit ${result.exitCode ?? result.signal}`}</span>
    {output && <details><summary>{t('Output')}</summary><pre className="coding-output">{output}</pre></details>}
  </li>
}

export function CodingSessionPanel({ session, project, agent, activity }: {
  session: CodingSession; project?: Project; agent?: AgentConfig; activity?: CodingActivity
}): ReactElement {
  const state = codingDisplayState(session, activity)
  const [live, setLive] = useState<GitState>()
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [text, setText] = useState('')
  const refresh = useCallback(async () => {
    if (!project?.isGit) return
    try { setLive(await window.douchat.projectGitStatus(project.id)) } catch { setLive(undefined) }
  }, [project?.id, project?.isGit])
  // The repository is read again whenever the session changes (it finished, checks ran).
  useEffect(() => { void refresh() }, [refresh, session.status, session.finishedAt, session.commands.length])
  const act = async (work: () => Promise<unknown>): Promise<void> => {
    setRunning(true); setError('')
    try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(cause)) }
    finally { setRunning(false) }
  }
  const cancel = (): void => { void act(() => window.douchat.cancelCodingSession(session.id)) }
  return <div className="coding-session" data-state={state}>
    <header className="coding-session-header">
      <h2>{session.task}</h2>
      <p className="coding-meta">
        <span className={`coding-state coding-state-${state}`} role="status">{t(codingStateLabels[state])}</span>
        {' · '}{agent?.name ?? session.agentId}{' · '}{project?.name ?? session.projectId}{' · '}<code>{session.workingDirectory}</code>
      </p>
      <p className="coding-meta muted">{t('Started')} {time(session.startedAt ?? session.createdAt)}{session.finishedAt ? ` · ${t('Finished')} ${time(session.finishedAt)}` : ''}</p>
    </header>

    {session.status === 'running' && (activity?.state === 'awaiting-approval'
      ? <ApprovalCard activity={activity} session={session} project={project} agent={agent} onCancel={cancel} />
      : <section className="coding-activity"><span className="coding-pulse" aria-hidden />{activity?.label ?? t('Running…')}
        <button className="secondary-button danger" onClick={cancel} disabled={running}>{t('Cancel session')}</button></section>)}

    {session.status === 'interrupted' && <section className="coding-banner" role="status">
      <p>{t('This session was interrupted when Douchat closed.')}</p>
      <p className="muted">{t('Its process is gone. Continuing starts the agent again on the same conversation; it does not reattach to the old process.')}</p>
      <button className="primary-button" disabled={running} onClick={() => void act(() => window.douchat.continueCodingSession(session.id))}>{t('Continue')}</button>
    </section>}

    {session.error && session.status !== 'interrupted' && <p className="coding-error" role="alert">{session.error}</p>}
    {session.result && <section className="coding-section"><h3>{t('Result')}</h3><p className="coding-result">{session.result}</p></section>}

    <ChangeList session={session} project={project} live={live} />

    <section className="coding-section" aria-label={t('Checks')}>
      <h3>{t('Checks')}</h3>
      <p className="muted">{project?.testCommand ? <code>{formatCommandLine(project.testCommand)}</code> : t('No check command is set for this project.')}</p>
      <button className="secondary-button" disabled={!project?.testCommand || session.status === 'running' || running}
        onClick={() => void act(() => window.douchat.runCodingChecks(session.id))}>{running ? t('Running…') : t('Run checks')}</button>
      {!!session.commands.length && <ul className="coding-checks">{[...session.commands].reverse().map((result, index) => <CheckResult key={`${result.startedAt}-${index}`} result={result} />)}</ul>}
    </section>

    <section className="coding-section" aria-label={t('Activity')}>
      <h3>{t('Activity')}</h3>
      <ol className="coding-events">{session.events.map((event, index) => <li key={`${event.at}-${index}`} data-kind={event.kind}>
        <time>{new Date(event.at).toLocaleTimeString()}</time> <strong>{event.label}</strong>{event.detail && <span className="muted"> — {event.detail}</span>}
      </li>)}</ol>
    </section>

    {error && <p className="coding-error" role="alert">{error}</p>}
    {canContinue(session) && session.status !== 'interrupted' && <form className="coding-continue" onSubmit={event => {
      event.preventDefault()
      const message = text.trim()
      if (!message) return
      void act(async () => { await window.douchat.continueCodingSession(session.id, message); setText('') })
    }}>
      <textarea value={text} onChange={event => setText(event.target.value)} rows={2} placeholder={t('Tell the agent what to do next…')} aria-label={t('Continue the conversation')} />
      <button className="primary-button" type="submit" disabled={running || !text.trim()}>{t('Send')}</button>
    </form>}
  </div>
}
