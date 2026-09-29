# Foundry coding through AppPort

Foundry's Projects and Coding Sessions are available to a remote client as an AppPort capability. The desktop and
the remote client control the same `CodingService`; AppPort is the transport and capability boundary, not a second
authority.

> **AppPort exposes Foundry capabilities; it does not become an alternate authority for coding state, source state,
> approvals, or execution.**

```text
Remote client ──▶ AppPort ──▶ CodingApi ──▶ CodingService ──▶ FeltDB (shared .flow)
Desktop UI    ────────────────────────────▶ CodingService     Git/filesystem: source state
                                                              OS processes: ephemeral
```

## The audit that shaped this

What exists, from the published packages (`@appport/*` 1.0.x, `@appport/services` 0.4.6, `@appport/github` 1.0.2):

| Question | Answer, from the code |
| --- | --- |
| Capability primitives | `defineCapability({ name, version, input, output, authorization, effect, handler })` and `defineEvent`, schemas from `@appport/schema` (`s.object(...)`). Names are `<namespace>.<operation>` and may not name a transport. |
| Request / response | Envelopes (`appport/1`); `client.call(name, input)`; every outcome is an envelope, application status separate from transport status. |
| Errors | `AppPortError` with standard codes (`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `INVALID_INPUT`, …); other errors are sanitized to `INTERNAL_ERROR`. |
| Events | `EventBus`: in-process, **at-most-once, nothing buffered**. Delivered over SSE / WebSocket / IPC to subscribers present at that moment. |
| Authentication | AppPort does not authenticate: `authenticate(request) → Identity` is a host hook. Authorization is by capability permission (`permissionAuthorizer`); anonymous callers are refused for anything that declares permissions, including subscribing to events. |
| FeltDB | Core has no storage; a capability handler gets what the host closes over. AppPort Services and `@appport/github` each take FeltDB options (`path`, `namespace`) and call `createFeltDB` — which resolves a `path` to one store. |
| Another app consuming Services | `appport.toml` + `feltdb.flow`: the application's flow contains the Services collections for the capabilities it `use`s (`loadAuthoritativeFlow` insists on it), then `deployFlowSpec`. Only the packages' own source could be read; no *other* application was available to inspect. |
| AuthBoundry | Published as `@authboundry/core` (a client of an AuthBoundry server). No server is available to Foundry, so it is not used; see *Security boundary*. |

Findings in the packages, reported rather than worked around: AppPort Services' flow template declares PascalCase
collections (`ApiKeys`) while its stores physically write snake_case ones (`api_keys`); `@appport/github` uses the
declared names. `@authboundry/core` nests older `@feltdb/core` copies (0.11.1 / 0.11.5), which are not used by the
capability code paths Foundry calls.

## The capability

| Capability | Effect | Permission |
| --- | --- | --- |
| `douchat.projects.list` / `.get` / `.gitstate` | observation | `douchat.projects.read` |
| `douchat.projects.remote` | observation — origin URL from Git; metadata from `@appport/github` | `douchat.projects.read` |
| `douchat.projects.add` | consequential — register a folder as a project (same checks as the app) | `douchat.projects.write` |
| `douchat.coding.agents.list` | observation — id and name | `douchat.coding.read` |
| `douchat.coding.sessions.list` / `.get` | observation | `douchat.coding.read` |
| `douchat.coding.sessions.start` / `.continue` / `.cancel` | consequential | `douchat.coding.control` |
| `douchat.coding.approvals.list` | observation | `douchat.approvals.read` |
| `douchat.coding.approvals.resolve` | consequential — approve or deny one | `douchat.approvals.resolve` |

A session view carries: project (id, name, path, branch at start), agent, task, status, `startedAt`/`finishedAt`,
result, error, changed files (each `before` — already modified — or `session`), files clean again, `HEAD` at start and
end, checks (argv, exit, bounded output), the bounded history, live activity **with its origin**, and the pending
approval. It is a view; nothing in it is stored beyond what FeltDB already holds.

### Events

`session.started`, `session.continued`, `approval.requested`, `approval.resolved`, `check.started`,
`check.completed`, `files.changed`, `session.finished`, `session.interrupted`. Each carries `sessionId`, `projectId`,
`at`, `origin` and a small payload. `origin` is `agent`, `douchat` or `unknown`: every event above is something Foundry
observed (`douchat`); `agent` is reserved for what a CLI reports about itself and is never inferred — a silent agent's
session contains no `agent` events, and its live `activity.origin` is `unknown`. Over HTTP the client keeps one event
stream, so subscribe once with `'*'` rather than once per event.

### Approvals

The pending approval names its agent, project, session and folder. `resolve` needs the approval id **and** the session
id, must find that approval pending *now*, and answers through the runtime's permission broker — the same
`resolveAgentPermission` the desktop prompt uses; there is no second approval system, and it accepts only
`approve` / `deny` (never a reusable grant). An approval that expired (cancelled, the session ended, was continued, or
Foundry restarted), never existed, or belongs to another session is refused (`NOT_FOUND` / `CONFLICT`) and authorizes
nothing.

## Lifecycle

| Event | What happens |
| --- | --- |
| Desktop window closes | Nothing changes for the session; the app is still running. Quitting Foundry cancels running sessions (unchanged): each records `cancelled`. |
| AppPort client disconnects | Nothing. **Disconnecting never cancels a session**; only `sessions.cancel` does. Nothing is written. |
| Client reconnects | Reads the durable session (`sessions.get`). Notices are not replayed; no session is created. |
| Another client connects | Sees the same session; both may answer an approval, and the first answer wins (the second finds it gone). |
| Session running, machine restarts | On the next start the session is `interrupted` (history keeps an `interrupted` entry); any agent process the crash left running is killed first (process ledger); pending approvals are gone. |
| Approval pending, anything above | It expires with the session or the process. |
| Continue remotely | `sessions.continue` starts a *new* agent process on the same conversation; earlier approvals do not carry over. |
| Agent process survives unexpectedly | Killed at the next start by the process ledger, before anything runs. |

`session.interrupted` is announced to clients already connected when the desktop recovers; a client that connects
later reads the `interrupted` history entry.

## Security boundary

*Transport reachable* is not *authorized to control coding sessions*.

- The host is **off by default** (`DOUCHAT_APPPORT=1` turns it on), listens on `127.0.0.1` only and accepts no browser origin.
- A caller is identified by an **AppPort Services API key** (`Authorization: Bearer …`). Keys are created through the
  Services capability — hashed, audited and revocable in the shared flow — and the first is written, once, to
  `appport-api-key` in the app's data folder (mode 0600).
- Services never decides who may cause an effect; a host authorizer does. Foundry has no AuthBoundry server, so a
  **stand-in local-owner authorizer** allows exactly one thing — the local owner managing this application's API keys — and
  nothing else. A valid key then carries Foundry's coding permissions (a key has no scopes; that decision is Foundry's and is
  in one function). This is a single-owner, same-machine arrangement. It is **not** multi-user authentication and must not
  be used to expose Foundry beyond this computer; a real AuthBoundry authority replaces the stand-in, it is not extended.
- `@appport/github` gets its own local-owner boundary that grants read capabilities only. Its credential is a *reference*
  in the flow; the token is in Foundry's credential vault (`github:<secretId>`), never in FeltDB state, evidence or logs.

## What is intentionally not exposed

No read or write of files, no command execution, no shell, no change of a session's folder, no reusable "allow" grants, no
FeltDB collection access, no agent creation or editing, no project removal, no setting of the check command (that needs
the owner's confirmation dialog). The remote client controls a coding session, not the machine.

## Desktop and remote

Both control the same `CodingService`. The desktop's IPC handlers call it directly and read its state through the
projection; `CodingApi` is the same service presented as plain views (and the one place a remote caller's input is
validated). Approvals converge on the runtime's permission broker. The desktop's preload API was not rewritten onto
AppPort's Electron transport in this change; that would only re-route the same calls.

## GitHub

Foundry has no GitHub API code for projects. `douchat.projects.remote` reads `remote.origin.url` from Git (the working
tree is the authority for that), parses `owner/repo`, and asks `@appport/github` (`repositories.get`) for the rest.
`github.repositories.source`, branches, issues and pull requests are there when the coding workflow needs them. Two older,
unrelated Foundry features still call GitHub directly — the release check for local agent CLIs and the skill installer's
download — and are pinned by a test so no third appears; they are candidates to move onto the capability.
Webhooks (`github.webhooks.handle`) are not wired: Foundry has no inbound endpoint.

## Verification

Contract tests run through AppPort's real client and in-process transport (`appport.test.ts`), and the shared-flow tests
(`sharedFlow.test.ts`) cover: one flow directory for all three owners, state of each in it, restart without a second flow,
declared collections equal to each provider's contract, no unowned collection, credentials absent from every flow file,
the GitHub call going through the capability (network boundary stubbed), no source in the flow, no second `createFeltDB`.
The loop was also run for real: Foundry with `DOUCHAT_APPPORT=1`, a real Claude Code process, an HTTP client with an API key —
an anonymous call refused, project and agent listed, a session started, the `Bash` approval seen and approved remotely, the
changed file reported as changed by the session with the pre-existing dirty files marked already modified, the session
continued remotely, the app killed with `kill -9`, restarted, the same session read back and continued again. Not done:
Codex, and Cody on the Mac.
