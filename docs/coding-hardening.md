# Coding in real repositories: what is guaranteed

This is the contract of the coding loop after it was driven by hand, in the real
Electron app, against a real dirty repository with a real Claude Code CLI, and
hardened from what that showed. It describes what the code does, and marks what has
and has not been verified — nothing here is a promise about a provider that has not
been run.

## Invariants

> **A CodingSession owns application state; the process executing it is ephemeral
> and must not survive the session boundary uncontrolled.**
>
> **A coding session never grants authority beyond its project working directory and
> its explicit approval state.**
>
> **FeltDB owns application/session state; Git/filesystem owns source state; OS
> processes are ephemeral.**

## A dirty repository is the normal case

When a session starts, Foundry records `git status --porcelain` (with untracked files),
`HEAD`, and a fingerprint of every dirty file (a SHA-1 of its bytes; size and time for
files over 8 MB). When it ends it reads the same things again and reports:

| Shown as | Means |
| --- | --- |
| **Changed during this session** | Not dirty at the start, or dirty in a different way / with different content now. |
| **Already modified** | Dirty in the same way with the same content as at the start. Never credited to the session. |
| *Untracked* (a label on either) | Git status `??`; not part of `git diff`. |
| "Modified before the session, clean now" | Dirty at the start, clean at the end. |
| "HEAD moved" | A commit was made while the session ran. |

Git cannot say **who** changed a file — the agent, you, a formatter, a file watcher —
only that it changed while the session ran. The screen says exactly that ("Git shows
that these changed while the session ran, not who changed them."); the label is a
statement about the time window, not about the agent. A continued session keeps the
baseline of its first turn. A running session is compared with the repository as it is
now; a finished one keeps what was true when it ended. A tracked file's diff is always
read live from Git. Session events use paths relative to the project.

## Checks are an argument vector, not a shell line

Proposed (typed as a command line in the UI) → parsed into `argv` (quotes group words;
nothing else is interpreted) → **you confirm it** in a native dialog that shows the
program and each argument on its own line → stored as `Workspace.testCommand: string[]`
→ displayed → executed directly (`spawn` of `argv[0]`, no shell, own process group,
login-shell environment plus the inherited one, 10-minute timeout, bounded output) →
the `CommandResult` (with the same `argv`, exit code or signal, cancelled/timed-out
flags, output tail) is stored on the session. Spaces, quotes, `$HOME`, `;` and `*` in
arguments are data. A non-zero exit is a result; a program that cannot be started is an
error. Tests: spaces in the working directory and arguments, quoted arguments, env
inheritance and additions, non-zero exit, timeout, cancellation, 200,000 lines of
output kept to a bounded tail, a missing program, and persistence across a restart.

## Approvals belong to one running session

A request is made by an agent process, is held in memory by the permission broker, and
carries its agent, its project, its session and the working directory it is for
(`codingSession`), plus the operation in words (`Run npm test`, `Edit src/math.js`).
Allow/Deny answer exactly that request once. A request **expires** when

- the session is cancelled while it waits,
- the session ends by itself (the agent exits, fails, finishes) while it waits,
- Foundry shuts down (orderly), or crashes — approvals are never written to FeltDB, so a
  restarted app has none, and
- the session is continued: whatever was pending or reusable before is withdrawn first.

An answer to an expired request is refused ("no longer available"); it authorizes
nothing. Starting or continuing a session withdraws every earlier approval and
"allow for this session" grant of that agent, so an old approval never authorizes a
later session. Tests cover approve, deny, cancel while pending, the session ending while
pending, shutdown while pending, and a stale approval after a restart.

## Session history

A bounded (100 entries) list of outcomes, never progress ticks: Started (with how many
files were already modified), Approval requested / Allowed / Denied / cancelled,
Command completed, Tests completed (✓/✗ with exit status), Files changed during this
session, Finished / Cancelled / Failed, Continued, Interrupted.

## Live activity is only what is known

The activity line comes from three sources and says which:

1. **The agent's own report** (`source: 'agent'`) — a tool it says it is running, or the step a CLI stream reports.
2. **Foundry's own knowledge** (`source: 'douchat'`) — waiting for your approval, a check Foundry is running, the repository's changes.
3. **The final result** — the agent's last message.

When an agent has reported nothing, the screen says "Running…" and, in words, that this
agent has not reported step-by-step activity. Foundry does not invent tool calls.

## Continue

Continue never reattaches to an old process.

- Always: *"A new agent process will be started in this project. The previous process will not be resumed."*
- Claude Code and Codex: their own conversation is picked up again from the native thread id kept in FeltDB, and Foundry provides the project and session context too.
- Every other agent: *"Continue will start a new conversation with the existing project/session context."*

## A crash leaves nothing running

Every agent process and every command Foundry starts is noted in FeltDB (`AgentProcess`:
pid + the operating system's start time for that process) and forgotten when it exits.
At startup, **before anything else can run**, each note is checked: if that pid is still
the same process (same start time — a reused pid is not mistaken for it), its whole
process group is killed; otherwise the note is discarded. Sessions still marked running
become **Interrupted**, keep their history and files, and show Continue. Approvals that
were pending are gone. Verified by hand with a real Claude Code process after
`kill -9` of the app, and by test with a real agent that keeps writing to the repository:
after the next start it is dead and the file stops growing. On Windows the ledger is not
kept (no start-time check is implemented), so a crash there can still leave a process
behind. Process groups are not a security boundary: an agent that deliberately
double-forks out of its group is not stopped.

## What was verified how

| Capability | Implemented | Verified with installed CLI | Provider-dependent |
| --- | --- | --- | --- |
| Project folder, pinned cwd, Git status/diff, dirty accounting | ✅ | ✅ (real Claude Code, real repo, in the Electron app) | |
| Approvals for Edit / Bash | ✅ Claude Code, Codex (`app-server`) | ✅ **Claude Code only**. Codex is implemented against its protocol but **was not run live** here. | Other CLIs run without Foundry approvals (see below) |
| Native step-by-step activity | ✅ Claude Code, Codex, Grok, Gemini streams | ✅ Claude Code | Reported by the CLI; custom/other agents report nothing |
| Native conversation resume on Continue | ✅ Claude Code, Codex | ✅ Claude Code (Continue after a crash) | Others start a new conversation with context |
| Edits and commands without Foundry approval | — | — | Depends on each CLI's defaults and sandbox; Grok, Cursor and oh-my-pi are read-only by construction |
| Checks, cancellation, timeouts, big output | ✅ | ✅ (real processes, tests) | |
| Orphan cleanup after a crash | ✅ Linux, macOS | ✅ Linux | Windows: not implemented |
| 1,000+ file dirty tree | ✅ | ✅ (1,200 tracked files, edits, deletion, staged rename, nested and spaced untracked files, a multi-MB diff) | |

## The manual drive

The real app was driven through Playwright over the Chrome DevTools protocol against a
real Claude Code CLI and a dirty copy of this repository: add project, set the check
(confirmed through the native dialog), start, Allow an `Edit` and a `Bash`, finish, read
the grouped changes and a real diff, then `kill -9` the app while an approval was
pending. Fixed because of it: pre-existing dirty files were credited to the session; an
agent process survived the crash (the ledger); approval events showed absolute paths; a
multi-line task was rendered as a giant heading; Deny / Set… / Run checks were unstyled;
the sidebar title was right-aligned; Continue said nothing about what it would do.
