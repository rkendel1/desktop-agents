import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { accountChanges, changeLabel, isUntracked } from '../../../shared/coding'
import type { CodingSession, GitChange, GitDiffMode, GitState, PaxAnswer, Project } from '../../../shared/types'
import { t, tr } from '../preferences'

const isStaged = (change: GitChange): boolean => change.code !== '??' && change.code[0] !== ' '
const isUnstaged = (change: GitChange): boolean => change.code !== '??' && change.code[1] !== ' '

/** Git's own words for the branch, with what it tracks and how far apart they are. */
export function BranchLine({ git, project }: { git?: GitState | { error: string }; project: Project }): ReactElement {
  if (!project.isGit) return <>{t('Not a Git repository')}</>
  if (!git) return <>{t('Reading Git status…')}</>
  if ('error' in git) return <>{git.error}</>
  const count = git.changes.length
  return <>
    <strong>{git.branch ?? t('detached HEAD')}</strong>
    {git.upstream && <span className="muted"> → {git.upstream}{git.ahead ? ` ↑${git.ahead}` : ''}{git.behind ? ` ↓${git.behind}` : ''}{!git.ahead && !git.behind ? ` (${t('up to date')})` : ''}</span>}
    {git.head && <span className="muted"> · <code>{git.head.slice(0, 8)}</code></span>}
    <span className="muted"> · {count ? tr('{count} changed files', { count }) : t('clean')}</span>
  </>
}

/**
 * The working tree as Git reports it — staged, not staged, untracked — with the diff of each and the developer's own Git actions.
 * Nothing here is remembered: every list is Git's answer from the last read, and every action ends by reading Git again.
 */
export function GitPanel({ project, git, onRefresh, latest, running }: {
  project: Project; git?: GitState | { error: string }; onRefresh: () => Promise<void>; latest?: CodingSession; running: boolean
}): ReactElement | null {
  const [selected, setSelected] = useState<{ path: string; mode: GitDiffMode }>()
  const [diff, setDiff] = useState<{ diff: string; truncated: boolean } | { error: string }>()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  const state = git && !('error' in git) ? git : undefined
  const changes = state?.changes ?? []
  // Where a change came from, as far as Git can say: relative to the latest session's starting point.
  const attribution = latest && state ? new Map(accountChanges(latest.baseline.changes, changes).changes.map(change => [change.path, change.origin])) : new Map<string, GitChange['origin']>()
  const staged = changes.filter(isStaged), unstaged = changes.filter(isUnstaged), untracked = changes.filter(isUntracked)

  const show = useCallback(async (path: string, mode: GitDiffMode): Promise<void> => {
    setSelected({ path, mode }); setDiff(undefined)
    try { setDiff(await window.douchat.projectGitDiff(project.id, path, undefined, mode)) } catch (cause) { setDiff({ error: cause instanceof Error ? cause.message : String(cause) }) }
  }, [project.id])
  // A diff that is open is read again whenever Git is.
  useEffect(() => { if (selected && changes.some(change => change.path === selected.path)) void show(selected.path, selected.mode); else if (selected) { setSelected(undefined); setDiff(undefined) } }, [git])

  const act = async (work: () => Promise<unknown>, message_?: string): Promise<void> => {
    setBusy(true); setError(''); setDone('')
    try { await work(); await onRefresh(); if (message_) setDone(message_) }
    catch (cause) { setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(cause)) }
    finally { setBusy(false) }
  }
  if (!project.isGit) return null

  const badge = (change: GitChange): ReactElement | null => {
    const origin = attribution.get(change.path)
    return origin ? <span className={`coding-change-kind${origin === 'session' ? ' session' : ''}`} title={t('Git shows that this changed while the session ran, not who changed it.')}>{origin === 'session' ? t('changed during session') : t('already modified')}</span> : null
  }
  const row = (change: GitChange, mode: GitDiffMode, action?: ReactElement): ReactElement => <li key={`${mode}-${change.path}`}>
    <button className={selected?.path === change.path && selected.mode === mode ? 'active' : ''} onClick={() => mode === 'head' ? setSelected({ path: change.path, mode }) : void show(change.path, mode)}>
      <code className="coding-change-code">{change.code.replace(/ /g, ' ')}</code> <span className="coding-change-path">{change.path}</span> <span className={`coding-change-kind${isUntracked(change) ? ' untracked' : ''}`}>{t(changeLabel(change))}</span> {badge(change)}
    </button>{action}
  </li>
  const stage = (paths: string[]): ReactElement => <button className="secondary-button" disabled={busy || running} onClick={() => void act(() => window.douchat.projectGitStage(project.id, paths))}>{t('Stage')}</button>
  const unstage = (paths: string[]): ReactElement => <button className="secondary-button" disabled={busy || running} onClick={() => void act(() => window.douchat.projectGitUnstage(project.id, paths))}>{t('Unstage')}</button>

  return <section className="coding-section" aria-label={t('Working tree')}>
    <h3>{t('Working tree')} <button className="secondary-button" disabled={busy} onClick={() => void act(() => Promise.resolve())} aria-label={t('Refresh Git')}>{t('Refresh')}</button></h3>
    {running && <p className="muted coding-note">{t('A coding session is running here. Stage and commit when it has finished.')}</p>}
    {state && !changes.length && <p className="muted">{t('Working tree clean.')}</p>}
    {!!staged.length && <><h4 className="coding-subheading">{t('Staged')} <span className="muted">({staged.length})</span></h4>
      <ul className="coding-changes">{staged.map(change => row(change, 'staged', unstage([change.path])))}</ul></>}
    {!!unstaged.length && <><h4 className="coding-subheading">{t('Not staged')} <span className="muted">({unstaged.length})</span></h4>
      <ul className="coding-changes">{unstaged.map(change => row(change, 'unstaged', stage([change.path])))}</ul></>}
    {!!untracked.length && <><h4 className="coding-subheading">{t('Untracked')} <span className="muted">({untracked.length})</span></h4>
      <ul className="coding-changes">{untracked.map(change => row(change, 'head', stage([change.path])))}</ul></>}
    {selected && (untracked.some(change => change.path === selected.path) && selected.mode === 'head'
      ? <p className="coding-untracked">{t('Untracked — not included in git diff')}</p>
      : diff && ('error' in diff ? <p role="alert">{diff.error}</p>
        : diff.diff ? <><p className="muted coding-note">{selected.mode === 'staged' ? t('Staged changes (index against HEAD)') : t('Changes not staged yet (working tree against the index)')}</p><pre className="coding-diff">{diff.diff}</pre>{diff.truncated && <p className="muted">{t('The diff was cut short.')}</p>}</>
          : <p className="muted">{t('No differences.')}</p>))}
    {!!(unstaged.length || untracked.length) && <button className="secondary-button" disabled={busy || running} onClick={() => void act(() => window.douchat.projectGitStage(project.id, [...unstaged, ...untracked].map(change => change.path).filter((path, index, all) => all.indexOf(path) === index)))}>{t('Stage all')}</button>}
    {!!staged.length && <form className="coding-continue" onSubmit={event => { event.preventDefault(); if (!message.trim()) return; void act(async () => { const result = await window.douchat.projectGitCommit(project.id, message); setMessage(''); setDone(tr('Committed {commit}: {summary}', { commit: result.commit.slice(0, 8), summary: result.summary })) }) }}>
      <textarea value={message} onChange={event => setMessage(event.target.value)} rows={2} placeholder={t('Commit message')} aria-label={t('Commit message')} />
      <button className="primary-button" type="submit" disabled={busy || running || !message.trim()}>{tr('Commit {count} staged', { count: staged.length })}</button>
    </form>}
    {error && <p className="coding-error" role="alert">{error}</p>}
    {done && <p className="muted" role="status">{done}</p>}
  </section>
}

/** What PAX says about the project's tooling — its words, unchanged. Ambiguity and drift are shown as PAX reports them, never resolved here. */
export function ToolingLine({ project, refreshKey }: { project: Project; refreshKey: string }): ReactElement | null {
  const [state, setState] = useState<{ info?: PaxAnswer; drift?: PaxAnswer; unavailable?: string }>()
  useEffect(() => {
    let live = true
    setState(undefined)
    Promise.all([window.douchat.projectPax(project.id, 'info'), window.douchat.projectPax(project.id, 'drift')])
      .then(([info, drift]) => { if (live) setState({ info, drift }) }, cause => { if (live) setState({ unavailable: cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(cause) }) })
    return () => { live = false }
  }, [project.id, refreshKey])
  if (!state) return null
  if (state.unavailable) return <p className="coding-meta muted">{t(state.unavailable)}</p>
  const manager = (state.info?.json as { manager?: { name?: string; selectedBy?: string } } | undefined)?.manager
  const issues = (state.drift?.json as { issues?: { status: string; expected: string; actual: string }[] } | undefined)?.issues ?? []
  return <p className="coding-meta">
    <span className="muted">{t('Tooling (PAX)')}: </span>{manager?.name ? <>{manager.name}<span className="muted"> — {manager.selectedBy}</span></> : <span className="muted">{t('no package manager detected')}</span>}
    {state.drift?.findings.ambiguous && <span className="coding-bad"> · {t('ambiguous')}: {issues.filter(issue => issue.status === 'ambiguous').map(issue => issue.actual).join('; ')}</span>}
    {state.drift?.findings.drift && <span className="coding-bad"> · {t('drift')}: {issues.filter(issue => issue.status === 'drift').map(issue => `${issue.expected} (${issue.actual})`).join('; ')}</span>}
    {state.drift && !state.drift.findings.ambiguous && !state.drift.findings.drift && <span className="muted"> · {t('no drift')}</span>}
  </p>
}
