# Agent permissions in shared groups

The owner opens their agent profile → menu → **Agent permissions**. Two independent interaction rules govern requests from human members and requests authenticated as agent-to-agent calls. Each supports Allow / Ask every time / Deny. New desktop profiles publish Allow for group interaction. Older unpublished profiles remain owner-only at the service boundary until their owner syncs.

For externally initiated cloud-agent tasks, the owner separately controls local file reads, file modifications, network navigation, browser control, connected-account reads, account writes, scheduling and other tools. Unknown tools require the other-tools rule, rather than falling through to allow. Sensitive rules default to Ask. The browser's navigation tool also requires browser-control permission because it can use a logged-in browser. Existing owner-issued direct instructions keep their current behavior.

## Enforcement

- The service validates membership and the target's published interaction rule. Only the target owner's authenticated device can claim or finish the task, regardless of its author.
- The owner's main process checks the locally stored rule again. External callers cannot submit permission overrides.
- Cloud tools are wrapped at their execution boundary. Approvals contain the requester identity, group, actual operation and arguments; results may be public. No tool starts before approval.
- Approvals default to one-shot and expire unanswered after ten minutes. Recognized bounded operations also offer **Allow for this task**, with the actual resource scope displayed. Grants are bound to the account, executing agent, requester and active reply task, and removed when that task completes or is cancelled. Later messages and delegated tasks start fresh. Current Deny rules still override grants. Matching parallel pending requests are released together only after explicit task approval.
- Reusable scopes cover a website origin for navigation, an exact path for file reads/listing, a mailbox account and folder for email search/read, and new artifacts in task output storage. Other paths, origins and mailboxes ask again. Sending, deletion, modification of existing files, browser clicks, scheduling, script execution and unknown operations remain one-shot. Enabled packaged skill listing/reading is handled by its bounded package reader and does not require personal-file approval; script execution does.
- Cloud model execution timeouts exclude tools and approval waits and reset on model progress. Tool cancellation signals and task lifetime are checked before executing an approved operation.
- Permissions persist in the owner's agent configuration. Interaction rules sync with the shared appearance metadata. Detailed sensitive rules and pending approvals stay on the owner's device.

## Local agents

For native approval protocols, structured Claude `Read` and `WebFetch` requests
can use the same exact-path/origin task grants. Codex Computer Use low-risk
application-access confirmations that explicitly support session persistence offer
**Allow this app for this session**. This authorizes access to the named app,
including reading its screen, clicking, typing and scrolling. App-access scope is
recognized from the structured app-only confirmation, independently of the GUI tool name. The grant is bound to the owner, agent,
requester, chat context, application ID and live native connection. It spans
replies on that connection and is revoked on close, idle eviction, cancellation,
reset, or agent disposal. Each callback still checks the current Deny policy.
Other apps, high-risk confirmations and operations other than native app-access
requests continue to ask. These grants are not written into Codex's global settings.
Free-form commands, scripts and unrecognized native tools still require individual confirmation.
The system does not infer safe privileges from a tool's human-readable description.

Local CLIs own their internal tool harness. Foundry cannot truthfully enforce the same per-tool categories inside every supported executable. The UI therefore shows an explicit **Run the local agent program** policy instead of pretending that individual local tools are intercepted. It defaults to Ask for external requests. Approving it authorizes this invocation under the CLI's existing filesystem, command and network privileges. No external invocation begins without this grant. Deny disables external local execution even when group interaction is allowed. This is not a tool-free local chat sandbox or fine-grained ACP approval implementation.

## Agent-to-agent interaction

A running shared cloud task has a `call_group_agent` tool; local CLI tasks can produce the corresponding Foundry directive after their owner has permitted local execution. The service authenticates the originating running task and its private claim, and checks both agents belong to that group and that the receiver permits agent interaction. Claims never reach the renderer. Ordinary message text or an `@` in an agent reply cannot impersonate this mechanism.

A task can delegate to one agent, idempotently, with a maximum of three delegation hops per human-started chain. Delegated tasks remain external requests even when their author account matches the receiving owner; they cannot launder permissions by hopping through a same-owner agent. Replies are public. This change does not implement secret role/word delivery for games.

Both service and desktop changes must ship for cross-account calls to work. No database migration is needed: interaction settings use existing room-agent JSON, permission profiles use existing local agent JSON, and bounded delegation IDs derive from authenticated source task IDs.

## Presence and task feedback

The owner desktop sends a heartbeat every ten seconds, independently of long-running tasks. Room agent metadata holds a server-issued 45-second lease, so disconnected clients eventually appear offline. Older clients without a lease show unknown status. Only the authenticated owner can refresh its own agents; metadata updates use revision checks to preserve concurrent membership edits. Mentions remain permission-filtered but include offline agents. Pending task statuses are retained on the originating message, including multi-agent child tasks. The UI shows waiting for device, waiting to start, processing or waiting for approval, and removes pending feedback on completion. Presence describes a reachable desktop, not guaranteed model availability. Both service and desktop must be updated; no new database table is needed.
