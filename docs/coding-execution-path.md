# Can Foundry's agents code in a real repository?

**Yes, through a local agent CLI — and this PR proves it end to end.** A real
Claude Code CLI, started by Foundry with a real repository as its working
directory, read the failing test, edited the file on disk and re-ran the test;
the desktop then showed the change through Git. Everything that makes that
possible already existed in the runtime; what was missing was a durable *project*
and *session* to hang it on, Git visibility, and a way to run and cancel checks.
Those are what this PR adds — and nothing more.

> **A coding agent operates against an explicit project working directory. The
> repository filesystem is the authority for source code; FeltDB is the
> authority for application/session state.**

```
FeltDB                       Filesystem / Git                 OS processes
  projects, sessions,          source code,                     the running agent,
  agents, chats, runs,         repository state,                its shell commands,
  events, changed paths,       generated files                  tests and builds
  command results
```

Foundry never copies source into FeltDB. A `CodingSession` stores *which paths*
changed (`git status` codes) and the results of commands, never file contents or
diffs; the diff is asked of Git when someone wants to see it. There is no second
project database: a project is a `Workspace` row (the folder record chats already
used) that has been given a name.

## The execution path, from the code

```
Foundry UI ─ IPC ─▶ CodingService.start          (main/coding/service.ts)
  create topic in the agent's direct chat; point the chat's workspace at the project;
  baseline `git status`; record CodingSession(status=running) in FeltDB
        │
        ▼
DouchatRuntime.sendMessage → performSendMessage → runReply → performReply   (main/runtime.ts)
  createRun(status=queued→running); local agent branch: workspaceDirectory =
  conversation.workspacePath (validated: never the disk root, home, system dirs or
  Foundry's own data); acquireWorkspace(directory) serializes agents per folder
        │
        ▼
desktopAgentExecutor.run → runLocalAgent                                   (main/localAgentRuntime.ts)
  ├─ codex, claude (with a session key)  → runConnectedAgent → LocalAgentConnection
  │     one long-lived stdio process per chat/topic; `codex app-server` (JSON-RPC) or
  │     `claude -p --input-format stream-json`; cwd = the folder; env = spawnEnvironment()
  └─ every other CLI, and custom agents  → executeLocalAgent
        one process per turn: spawn(cmd, args, { cwd: directory, detached, stdio: pipes })
        │
        ▼
the agent CLI, working in the folder: reads/edits files, runs shell commands, uses Git
        │
        ▼
Foundry reads stdout/stderr (bounded), turns it into progress and the final reply,
persists the reply as a message, finishes the Run, then CodingService re-reads
`git status` and stores the changed paths on the session.
```

| Step | Implementation |
| --- | --- |
| Agent creation | `douchat:create-agent` (index.ts) → `validateLocalAgent` → `repository.createAgent`; a local agent is `provider: 'local'` plus `localAgentId`. |
| Session creation | A "session" is a chat topic: session key `direct:<conversation>:<topic>` (group: `group:…`). `CodingService.start` adds the `CodingSession` record and gives it its own topic. |
| Provider selection | `config.localAgentId` set → local CLI branch; otherwise a hosted model through `pi-agent-core`. Nothing is inferred from a provider's name. |
| Process spawning | `spawn(...)` in `localAgentRuntime.ts` (one-shot) and `localAgentConnection.ts` (persistent); own process group (`detached`), pipes for stdio. |
| Working directory | `localWorkspace(config, sessionKey, workspaceDirectory)`; `workspaceDirectory` comes only from `conversation.workspacePath`. Without one the agent gets an app-owned directory under `userData/local-workspaces` (a scratch space, not a project). |
| Environment | `spawnEnvironment()` (main/shellPath.ts): the app's environment with the login shell's `PATH`, plus a fixed allow-list of CLI credential variables. Claude/Gemini get extra tweaks in `localAgentEnvironment`. |
| Filesystem access | By the CLI, inside its own sandbox: Codex `workspace-write`; Claude only what the owner approves (below); Grok, Cursor (`--mode ask`) and oh-my-pi (`--no-tools`) are started read-only or without tools. Hosted-model agents get `list/read/write_workspace_file` (`workspaceTools.ts`), jailed to the folder, symlink-refusing, permission-gated. |
| Command execution | Only the CLI runs commands. Foundry has no shell tool for hosted-model agents. This PR adds `runCommand` (`coding/commands.ts`) for Foundry's own checks. |
| Process lifecycle | Budget of 8 processes; persistent connections idle out after 5 minutes (max 2 idle); a connection dies with its turn on error. |
| stdout/stderr/events | One-shot: collected (8 MB cap) and parsed per CLI (Grok/Gemini streams give progress). Codex: JSON-RPC notifications. Claude: stream-json. Progress is transient (`latestActivity`); only the reply is stored. |
| Cancellation | `AbortSignal` → `killLocalProcess`: `SIGKILL` to the whole process group (`taskkill /T /F` on Windows). |
| Reconnect / resume | The process is never reattached. Codex `thread/resume` and Claude `--resume` continue the *conversation* from a native thread id stored in `RuntimeBinding`, keyed by agent, chat and folder. |
| Persistence | FeltDB: messages, `Run` + events, runtime bindings, and now `Workspace`(project) + `CodingSession`. |

### How the CLIs are started (this decides what "coding" means for each)

| CLI | Started with | Can it edit files and run commands? |
| --- | --- | --- |
| Codex | `app-server`, sandbox `workspace-write`, network on | **Yes**, on its own, inside the folder. Not exercised here (not installed). |
| Claude Code | `--allowedTools WebSearch,WebFetch --permission-prompt-tool stdio` | **Yes, with owner approval**: every `Edit`/`Bash` request is routed to Foundry's permission prompt (`permissions.authorize`). With no approval handler it is `--permission-mode dontAsk`, which denies them. **Proven live.** |
| Grok | `--sandbox strict --allow Read,Grep,WebFetch,WebSearch,image_*` | No edits or shell by construction. |
| Cursor | `--mode ask` | Read-only by construction. |
| oh-my-pi | `--no-tools` | No. |
| Gemini, OpenCode, Kimi, OpenClaw, Hermes, FastClaw, custom | prompt-only arguments | Not established by Foundry's code: it depends on each CLI's defaults. |

## What this PR adds

- `Project` — a `Workspace` row with a name (`addProject`, `projects`, `removeProject`,
  `setProjectTestCommand`). The same folder is the same project. Folder rules are the
  existing `validateWorkspaceFolder`.
- `CodingSession` — `desktop.flow` collection: project, agent, chat + topic, explicit
  `cwd`, task, status, run id, result, baseline and final changed paths, command results.
  `running` sessions found at startup become `interrupted`.
- `CodingService` (`main/coding/service.ts`) — start, settle, cancel, run a command in the
  session's directory, run the project's check; keeps no state that is not in FeltDB
  except in-flight promises and abort controllers.
- `git.ts` — `gitStatus` / `gitDiff`, read-only, with the repository's own config
  (`core.fsmonitor`) unable to run programs.
- `commands.ts` — `runCommand(argv, { cwd })`: no shell, own process group, group kill on
  cancel, timeout and exit, bounded output, non-zero exit is a result.
- IPC (`list/choose/remove-project`, `project-git-status/diff`, `list/start/cancel-coding-session`).
  The renderer cannot submit a command line.

## Proof

`src/main/coding/coding.test.ts` (16 tests; real `git`, real `npm`, real child
processes). The agent there is `fixtures/scripted-agent.cjs`: started by Foundry's own
local-agent path like any custom agent, it reads the repository, runs `git status` and
`npm test`, rewrites `src/math.js` and reports. Its decisions are scripted, not a
model's — the process, working directory, file mutation, shell execution, output capture,
cancellation and persistence are all real.

`src/main/coding/coding.live.test.ts` (opt-in, `DOUCHAT_LIVE_CODING=claude`) runs the
same task with the real installed Claude Code CLI. Observed: 3 approval requests
(`Bash npm test | head`, `Edit`, `Bash npm test | tail`), all routed through Foundry's
permission prompt; `src/math.js` changed on disk; session `succeeded`; git status
`[{ src/math.js,  M }]`; reply "…`npm test` now passes."

## Capability matrix

| Capability | Exists today | Proven by test | Required work |
| --- | --- | --- | --- |
| Select local repo | Yes — `choose-project` dialog → `addProject` (validated folder, Git detection, stable id) | `coding.test` "is not a project until it is added…", "refuses a folder that is not allowed…" | UI to pick and list projects |
| Explicit cwd | Yes — `CodingSession.workingDirectory`, immutable for the session. The chat's folder cannot be changed while the session runs (repository refuses), and every turn in the session's topic is checked against it first (`setTurnGuard`) | "reads the project…" (`cwd=` equals the project); `runCommand` refuses an empty cwd | The runtime still derives cwd from the chat; the guard makes that safe rather than changing it |
| Read source | Yes — any CLI agent; hosted agents via `read_workspace_file` | "reads the project…" (agent lists files, runs tests); live Claude test; `runtimeWorkspace.test` for hosted tools | — |
| Modify source | Yes — Codex (sandbox), Claude (owner-approved `Edit`), hosted `write_workspace_file` | "…changes a real file…" (bytes on disk); live Claude test | Codex live proof (CLI not available here); Grok/Cursor/omp are read-only by design |
| Execute shell | Only inside CLIs (Codex, approved Claude `Bash`); Foundry itself now via `runCommand` | `runCommand` tests; live Claude ran `npm test` | Hosted-model agents have no shell tool |
| Run tests | Yes — by the agent, and by Foundry (`runChecks` with the project's `testCommand`) | "…runs the tests…" (`npm test` exit 0 recorded on the session); failing check recorded | Owner-confirmed in the UI (`Set…`), stored as an argument vector |
| Git status | Yes — `gitStatus`, session baseline and result | "reports a clean repository, then exactly what changed…"; porcelain parser test | — |
| Git diff | Yes — `gitDiff`, bounded, per path optional | same | Untracked files appear in status, not in the diff |
| Cancellation | Yes — `CodingService.cancel`, runtime `stopConversation`, `runCommand` signal | "cancels a running session…"; `runCommand` cancel/timeout | Cancelling during agent start-up needed a retry loop (added) |
| Process-tree cleanup | Yes — process-group `SIGKILL`; `runCommand` also kills leftovers after a clean exit | "kills the whole process tree…" (parent and grandchild not running); shutdown test | See the baseline note below |
| Session persistence | Yes — `CodingSession` + chat + Run in FeltDB; changed paths, results, commands | "reconstructs the project, session, conversation and changes from FeltDB alone" | Local CLIs' partial output/tool activity is not stored (only the final reply); hosted-model tool events are |
| Restart / reopen | Durable state yes; **live processes are not reattached, and any a crash left behind are stopped at the next start** (process ledger, see [coding-hardening.md](coding-hardening.md)) | restart tests; "marks a session… interrupted"; "cancels running sessions during an orderly shutdown" | Reattaching to a live agent process is not supported. Conversation continuity for Codex/Claude comes from native thread resume, not from the process |
| Multiple agents | Yes, serialized per folder (one agent at a time in a project) | "serializes two agents working in the same project folder" | Parallel work needs worktrees — out of scope |

## Limits found

- **Session activity is thin for CLIs.** The desktop sees the reply, progress detail and
  the resulting Git state, not the CLI's individual tool calls (except Claude's approval
  requests, which pass through the permission prompt).
- **Claude needs someone to approve.** Each `Edit`/`Bash` waits on the owner; nothing
  auto-approves. Good for safety, wrong for unattended work.
- **`git status` attribution.** If a file was already modified before the session and the
  agent modifies it further, its status code does not change. The baseline is stored so
  the UI can tell what was already dirty, but this case is not detectable.
- **One session per agent.** A second start for a running agent is refused.
- **No renderer UI or projection deltas for projects/sessions yet**: the IPC reads them
  on demand.

## The baseline failing test is not a process-cleanup bug

`localAgentConnection.test.ts` › "terminates owned descendant processes…" fails on the
pre-migration commit and still fails. While proving process-tree cleanup here, the cause
became visible: in this container PID 1 does not reap orphans, so a process that was
correctly `SIGKILL`ed stays listed as a zombie (`/proc/<pid>/stat` state `Z`, parent 1),
and the test's `process.kill(pid, 0)` still succeeds. With a zombie-aware check the same
test passes (verified against a scratch copy; the test file is unchanged). The new path
uses the same `killLocalProcess`, and its tests assert *not running* rather than *not
listed*. No production fix was needed.

## Using it: the coding loop in the app (next PR)

Projects (rail) → pick or add a repository → pick an agent, give a task → the session
panel shows the state, live activity, approvals, changed files (tracked diff; untracked
files are labelled as not in the diff), checks and the event history → Continue.

- **State** is the backend's (`running`, `succeeded`, `failed`, `cancelled`, `interrupted`);
  the UI adds only "Waiting for approval", derived from live permission requests.
- **Approvals** show "Agent wants to: Run `npm test | head`" / "Edit `src/math.js`" with the
  agent, project and path; Allow/Deny call the existing permission IPC and "Cancel session"
  stops the session. A request for a session that is open on screen is answered there; any
  other interrupts with a prompt that names its session and project. The renderer executes
  nothing.
- **Live activity** is ephemeral (from the runtime's activity and permission broker); the
  durable record keeps outcomes only: started, approval requested/allowed/denied, command and
  test results, files changed, finished, continued, interrupted.
- **Checks** run the project's stored `testCommand`. The renderer proposes a command line; the
  main process asks the owner to confirm it, then stores it as an argument vector.
- **Continue** goes through the ordinary chat turn on the same conversation, topic and folder.
  After a restart an `interrupted` session is offered "Continue": a new process starts and
  Codex/Claude resume from their native thread — the old process is never reattached.
- **The folder is pinned** for the life of a session (see the matrix).
- Custom local agents now live in FeltDB (`LocalAgentDefinition`), imported once from `local-agents.json`.

See [coding-hardening.md](coding-hardening.md) for what the real-repository hardening pass changed: dirty-tree accounting, session-scoped approvals, the process ledger, honest activity and Continue semantics.
