# The Foundry workbench

**Foundry is the developer workbench where agents build software.** A developer opens a project, sees what state it is really in,
starts an agent, approves its work, reads exactly what changed, runs checks, continues the session, commits — and restarts Foundry
without losing any of it. This page describes that loop and which system is the authority for each part of it. Nothing here is a
new engine: it is the coding service, the local-agent runtime, the Compute integration, PAX and Git, presented in one place.

```text
Open project → see repository reality → start coding → agent works → review activity
      → review changed files and diff → run checks → continue → commit / inspect Git → repeat
```

## Who owns what

| | Authoritative for | Foundry's part |
| --- | --- | --- |
| **Git / filesystem** | source, branches, commits, the index (staged state), the working tree, diffs, ahead/behind | Reads it every time it is shown. Runs the developer's own `git add`, `git restore --staged` and `git commit` and shows what Git then says. Keeps no source-control state of its own. |
| **PAX** | package manager, lockfile interpretation, workspace detection, drift, native operation selection | Asks (`pax info`, `pax drift`) and shows PAX's words. Ambiguity stays ambiguous and drift is never repaired. PAX is read-only and optional: if it is not installed the workbench says so and carries on. |
| **FeltDB** | projects, coding sessions, activity/evidence, approvals' outcomes, checks, CI runs | One shared `desktop.flow`. Sessions hold references and bounded evidence, never source. |
| **OS processes** | nothing durable | The agent and check processes are ephemeral; a session that was running when Foundry closed becomes `interrupted`. |
| **Foundry** | the workflow: sessions, agent interaction, approvals, activity presentation, check orchestration, history | `CodingService` — used identically by the desktop and by AppPort. |

The renderer is a projection: it reads the snapshot (FeltDB, through the repository and the projection) and asks the service for
Git/PAX/Compute answers each time. It stores nothing that could disagree with them.

## The project home

Selecting a project answers four questions at once.

- **What am I working on?** Project, repository path, branch, the upstream it tracks and how far ahead/behind it is, the commit, and PAX's tooling line.
- **What is happening?** The running session, its agent, where it runs, its live activity — and its approval, right there, with *Allow*, *Deny* and *Cancel session*. If nothing is running: **Last time**, the most recent session (status, agent, where it ran, when, result, changed files, checks).
- **What changed?** The working tree as Git reports it — *Staged*, *Not staged*, *Untracked* — each file's diff (staged and unstaged shown separately), and, for the latest session, whether Git shows the change as arising *during the session* or as *already modified* beforehand.
- **What next?** *Start coding*, *Continue*, *Review*, *Run checks*, *Stage / Unstage*, *Commit*, and CI.

Git is read when the project opens, whenever a session starts, ends or records a check, when the window regains focus, and every few seconds while an agent works. Nothing has to be refreshed by hand (a *Refresh* button exists anyway).

## Start coding: where the agent runs

| Choice | What it means |
| --- | --- |
| **This Computer** (the default) | Local execution. The agent runs on this computer in the project's folder. No network, account, Compute or hosted service is needed for anything in the local loop. |
| **Compute** | Remote Computer. The agent runs on a Computer from the installed Compute Configured, on a checkout of the *committed* revision ([compute-integration.md](compute-integration.md)). |

Selecting Compute is a decision, not a preference. If Compute cannot run the session — not installed, daemon not answering, Computer not running, no Computer chosen —
the reason is shown, *Start session* stays disabled, and the service itself refuses (`Compute was selected, so nothing was started on this computer`) with no session, no topic and no local process created. Foundry never falls back to running locally. If no
execution target is chosen the existing default (local) applies.

## Agent activity and approvals

Activity shown is what Foundry observed: the agent's own activity where its CLI reports one, Foundry's approvals, checks and repository changes, and native/project results. An agent that reports nothing is shown as running with no step-by-step claim; nothing is invented.

Approvals are the runtime's permission broker, unchanged: scoped to the session, withdrawn when the session ends, is continued or Foundry restarts, and answerable once. On the project home and in the session they show the agent, project, folder and the exact action (`Run …`, `Edit path`, …).

## Changes and attribution

Foundry records the repository's state when a session begins (HEAD and a content fingerprint per dirty file) and compares it with the state when the session ends or as it is now. A file that is dirty the same way with the same content is *already modified*; anything else is *changed during the session*. That is the strongest evidence available — Git cannot say *who* changed a file, and timestamps are never used to claim authorship. Untracked files are listed as such (a diff does not include them); staged changes are shown against HEAD, unstaged against the index.

## Checks

A project's check command is an argument vector (never shell text) set by the owner and confirmed in the main process. *Run checks* runs it with the no-shell command runner in the session's location and records argv, where it ran, exit status, duration, bounded output and time in the session. Recent checks across sessions are listed on the project home. Foundry has no command detector: where PAX names a project's operations (CI) PAX decides, and native tools execute.

## Continue

Continue starts a **new** agent process in the same project, conversation and topic; it never reattaches to the old one. Whether the agent's *own* conversation carries over depends on its CLI: Claude Code and Codex resume their native thread (Foundry keeps its id); other agents start a fresh conversation with the project and session context. The UI says which. An interrupted session (Foundry closed while it ran) has a one-click *Continue* on the project home.

## Git

*Stage*, *Unstage*, *Stage all* and *Commit* act on the project's folder and are exactly `git add -- <paths>`, `git restore --staged -- <paths>` (or `git rm --cached` before the first commit) and `git commit -m <message>`. They accept only paths Git itself lists as changed, never `-a`, never shell text; the repository's own hooks run as they do when a developer commits. They are refused while a coding session runs in the project, because changing the index under an agent would change what its change accounting compares against. Compute sessions' checkouts on the Computer are not touched by these.

## History

Everything above survives a restart because it lives in FeltDB: sessions with their status, agent, execution target, times, conversation (your messages and the agent's replies), approvals and their outcomes, checks, changed files, interruptions, cancellations and continuations. Reopening a project shows **Last time** immediately.

## AppPort parity

The desktop and AppPort call the same `CodingService`. `douchat.projects.gitstate` now also reports the upstream and ahead/behind. Git *writes* (stage, unstage, commit) are deliberately **not** AppPort capabilities: committing is the developer's own action at their machine, and no remote client is given it. See [appport-coding.md](appport-coding.md).

## Offline

The local loop — open projects, read Git, run local agents (with a provider or a local CLI that itself works offline), approve, review diffs, run checks, continue, stage and commit, read history — needs no network, Compute, GitHub, account or hosted service. PAX, Compute and CI are optional and each says so plainly when absent.

## Known baseline

`src/main/localAgentConnection.test.ts › terminates owned descendant processes when a connection is disposed` fails in this environment (a process that has exited is still visible to `process.kill(pid, 0)` until it is reaped). It fails on the branch before and after the workbench changes, is unrelated to them, and is neither skipped nor weakened.
