# The Foundry workbench

**Foundry is the developer workbench where agents build software.** A developer opens a project, continues one of its durable conversations,
assigns executable work to an agent, approves it, reads exactly what changed, runs checks, continues the session, commits — and restarts Foundry
without losing any of it. This page describes that loop and which system is the authority for each part of it. Nothing here is a
new engine: it is the coding service, the local-agent runtime, the Compute integration, PAX and Git, presented in one place.

```text
Open project → discuss in Chats → assign work → agent works → review activity
      → review changed files and diff → run checks → continue → commit / inspect Git → repeat
```

## Who owns what

| | Authoritative for | Foundry's part |
| --- | --- | --- |
| **Git / filesystem** | source, branches, commits, the index (staged state), the working tree, diffs, ahead/behind | Reads it every time it is shown. Runs the developer's own `git add`, `git restore --staged` and `git commit` and shows what Git then says. Keeps no source-control state of its own. |
| **PAX** | package manager, lockfile interpretation, workspace detection, drift, native operation selection | Asks (`pax info`, `pax drift`) and shows PAX's words. Ambiguity stays ambiguous and drift is never repaired. PAX is read-only and optional: if it is not installed the workbench says so and carries on. |
| **FeltDB** | projects, project conversations/messages, coding sessions, activity/evidence, approvals' outcomes, checks, CI runs | One shared `desktop.flow`. Conversations and sessions hold references and bounded evidence, never source. |
| **Compute** | recipes, environments, Computers, runtime, execution and lifecycle | Foundry stores only the project’s environment reference and asks Compute for current reality. |
| **OS processes** | nothing durable | The agent and check processes are ephemeral; a session that was running when Foundry closed becomes `interrupted`. |
| **Foundry** | the workflow: sessions, agent interaction, approvals, activity presentation, check orchestration, history | `CodingService` — used identically by the desktop and by AppPort. |

The renderer is a projection: it reads the snapshot (FeltDB, through the repository and the projection) and asks the service for
Git/PAX/Compute answers each time. It stores nothing that could disagree with them.

## The project home

The project header keeps repository identity and current Git/PAX reality visible. The rest of the page is divided by intent so that discussion, execution and evidence do not compete for the same space.

- **Chats** contains the project's durable conversations. A project can have multiple named chats for separate topics, all pointing at the same project workspace. Sending a chat message discusses or plans work; it does **not** start an agent process or change files. Use *Turn into work* on a useful reply, or move to **Work**, when the discussion is ready to execute.
- **Work** shows what is happening now and what happened last, then provides **Assign executable work**. This is the box for a concrete request to inspect or change project files. Work begins only after *Start work* is pressed. The same tab shows the working tree, diffs, staging and commit controls.
- **Environment** shows where Compute will run the work: recipe and version, Computer, configuration and readiness, plus lifecycle controls. Environment readiness does not itself start work.
- **Checks** owns command discovery and selection, recent check results and CI. Selecting a command configures future checks; *Run checks* is the explicit execution action.
- **History** contains durable work-session history and structured decisions, separate from the conversational histories in **Chats**.

The summary above the tabs makes the intended progression explicit: **Chat — plan and decide → Work — assign executable changes → History — review results**. The chat composer always reports whether an agent action is currently running, so an idle chat never looks like invisible background work.

Git is read when the project opens, whenever a session starts, ends or records a check, when the window regains focus, and every few seconds while an agent works. Nothing has to be refreshed by hand (a *Refresh* button exists anyway).

## Assign work: where the agent runs

| Choice | What it means |
| --- | --- |
| **Compute environment** (the default) | The project's development environment on Compute. The agent runs only after Compute reports its Computer ready, on a checkout of the *committed* revision. |
| **This Computer — local fallback** | Explicit legacy fallback. The agent runs on this computer in the project's folder. Foundry never selects it because Compute is unavailable. |

Selecting the Environment is a decision, not a preference. The session runs on the project's Compute environment, and only when Compute reports it ready. If it cannot — Compute not installed or too old, daemon not answering, no environment, environment stopped, failed or not ready —
the reason is shown, *Start work* stays disabled, and the service itself refuses (`Compute was selected, so nothing was started on this computer`) with no session, no topic and no local process created. Foundry never falls back to running locally. If no
execution target is chosen the workbench requests Compute. Selecting local is explicit; a failed or missing environment never changes targets silently.

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

The explicitly selected local fallback can work offline. Compute remains the normal coding target and its absence is reported rather than hidden.

## Known baseline

`src/main/localAgentConnection.test.ts › terminates owned descendant processes when a connection is disposed` fails in this environment (a process that has exited is still visible to `process.kill(pid, 0)` until it is reaped). It fails on the branch before and after the workbench changes, is unrelated to them, and is neither skipped nor weakened.
