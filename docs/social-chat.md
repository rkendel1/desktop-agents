# Friends and shared groups

The Friends group in the desktop Contacts section uses the existing Foundry desktop login token to talk to
`/api/desktop-auth/social` in the sibling `douchat-tanstack` service. Tokens and task
claims stay in Electron's main process.

Current cross-account interaction and approval behavior is documented in
[Agent permissions](agent-permissions.md). The first-version notes below describe
the original delivery model; permission-controlled group calls extend it.

## First version

The Add friend dialog uses a narrower 480px width and shares its typography and
header styling with the scheduled-task viewer. Create agent is in the message-list plus menu; its dialog includes an Add friend
button that opens this search dialog.

Friends appear under Contacts alongside built-in agents, group chats and agents;
there is no separate Friends navigation tab. Requests and accepted friends appear directly as avatar/name/status rows. Select
a person to view their profile using the same layout as an agent, then accept or
decline the request, or send a message. Start a group from the shared chat-details member picker. Shared groups
appear in the existing Group chats folder.

- Open the message list’s **+ → Create agent → Add friend** flow, search
  an existing user’s email, review their avatar/name/email, and send a friend request. The recipient accepts or
  declines it; an accepted relationship permits direct messages and group invitations.
- Create a group from accepted friends. Each member adds/removes their own locally
  owned agents, including their own built-in account administrator.
- Send ordinary text to the group, or select one of your agents to assign a task.
  Writing an `@name` in a normal message does not dispatch work.
- Group agents receive the owner's request plus bounded shared chat context, not
  private chat history. Replies are visible to all group members.
- The owner's desktop executes both local CLI agents and Cloud agents. Pending tasks
  wait for a device that has that agent. Messages refresh every two seconds while the
  conversation is open; people, rooms and requests refresh every three seconds.
- Human direct messages and shared groups support text and up to four pasted images (8 MB each, 20 MB total). Images attached to a group task are passed to the explicitly addressed agent; generated reply images synchronize to group members. Deploy the matching service update before updating desktops. Other shared file uploads,
  presence, read receipts, group moderation and adding people after group creation
  are outside this first version.

## Unified direct-message inbox

Human direct rooms synchronize in the main process every two seconds, even when
Contacts is closed. They are stored as ordinary account-scoped conversations and
messages. A conversation carries a person and a remote room address, never a fake
model configuration. Both participants get independent local IDs and preferences.

BotInbox, ChatPane, InspectorRail, the member picker, history/search, mark-read,
manual unread, pin, mute, hide, delete, and detached windows use the existing
conversation APIs. Runtime.sendMessage dispatches human recipients to SocialClient
before connecting any model; ordinary agent conversations retain model execution.
The old standalone FriendChatPane adapter has been removed.

Deleting/clearing history is local to the account/device, as with agent chats.
Persisted message-ID tombstones prevent the next sync from restoring cleared
messages, without relying on the device clock. A new incoming message can bring
a hidden/deleted conversation back. Pending send retries reuse the same message
ID after a lost receipt. Photos are read from current account profiles.

The service stores versioned direct-message bodies in its existing content column,
including bounded image attachments, and returns decoded text/images. Downloaded
images enter the same local attachment store used by agent chat.

## Ownership and delivery

Service-side agent ids combine the authenticated account id with the local agent id.
The server derives the sender from the session and checks room membership and the
target agent’s interaction permissions when sending. Only the agent owner can claim
and complete its tasks. Ordinary messages and agent results never
enter the task queue. The renderer cannot claim or complete jobs.

The main process validates the task’s target owner against the persisted local agent
owner, and checks external callers against the owner’s local permission policy before
invoking the runtime. Legacy local agents acquire ownership the first
time they are shared; newly created agents inherit the current account. Updating an
agent through IPC cannot change ownership.

Task claiming uses a conditional database update and verifies the saved claim (including
on MySQL, where the shared database adapter emulates `returning()`). Only one device
executes a task. Sending a message with the same id is idempotent. Execution results
are stored in a local SQLite outbox and publication can be retried without rerunning
tools. Signing out aborts active execution and keeps that account's unpublished result
for its next login. A crash after claiming is not automatically retried, because tools
may already have performed work; a saved in-flight receipt becomes an interrupted-task
result. A connection loss during the initial claim can leave an uncertain running task;
confirm any external effects before sending another task.

## Run and deploy

Both desktop and service changes are required. The development database has been
updated with `social_friendship`, `social_room`, `social_membership`, and `social_message`.
Start the service on the desktop's `DOUCHAT_SERVICE_URL`, then restart the desktop main
process to load its new IPC handlers.

The service's SQLite, PostgreSQL and MySQL schema templates include the new tables.
Production deployment still needs a reviewed, additive migration generated for the
production database provider before deploying the service. No production migration or
deployment is performed by this implementation.

Verification:

```sh
# desktop
npm run typecheck
npm test
npm run build

# douchat-tanstack service
pnpm exec tsc --noEmit
pnpm exec tsx --test tests/social.test.ts
pnpm build
```

The service integration test uses an isolated temporary SQLite database and does not
send messages to real users. Renderer checks use fixture accounts.

## Shared member presentation and follow-ups

The standard inbox supports explicit agent mentions, subject to the owner's
`interactionHumans` permission. Human and agent names are resolved together;
ambiguous duplicate names are rejected rather than selecting another owner's agent.
The legacy workspace also offers an explicit owned-agent recipient picker.

Agent memberships include public appearance metadata (image, emoji, generated
avatar seed, color, built-in identity and local agent type). The owning desktop
refreshes changed profiles during inbox synchronization via `update-agent`. This
operation requires an existing membership, preserves its ordering, and cannot
restore a removed agent. Receivers use these fields without looking up a matching
local contact. Avatar data is excluded from model task context. Both the desktop
and service must run this version, and the owner's desktop must sync once to fill
appearance data for older memberships. No database migration is required.

Shared rooms use explicit invocation by default, including rooms that later have
only one human left. Ordinary messages, questions, replies to human peers and
`@all` carry `agentIds: []`. They do not choose a leader, call a decision model,
continue the previous speaker automatically, or wake an owner's first agent.
Only named agent mentions or an explicit recipient-picker selection create tasks.
Quoted text, code and links are excluded from mention matching. Multiple explicit
mentions preserve their order in the outgoing target list; this list does **not**
guarantee global sequential execution across owners' devices.

Both send entry points enforce this policy. Explicit cross-owner calls still
require `allow` or `ask`; `ask` is checked at the owner's execution boundary and
is not treated as prior approval. Missing permission metadata fails closed.
The legacy picker resets after a successful send so the next human reply cannot
inherit its recipient. Shared rooms never receive local automatic greetings.
Previously assigned tasks may finish and delegate through their existing claimed
task; observing an unrelated human message does not create a new task.

This is a desktop policy, not a new distributed scheduler or global room setting.
The service remains responsible for membership, owner permissions, idempotent
sends and exclusive task claims. Older clients may retain their previous routing
behavior until updated. Opt-in semantic participation and one cross-owner leader
per task require a separate room-level protocol; they are not silently enabled.
Local groups containing only the user and their agents retain the configured
model-driven scheduling policy.

The regression suite exercises two fixture accounts with multiple agents each,
both desktop send entry points, permission states, ambiguous names, human replies,
quoted mentions and recipient reset. This is a local integration test with a
mock social service, not a live two-account network acceptance run.

### Low-latency inbox synchronization

The service advertises `syncVersion: 1`. Desktops then hold one authenticated
`watch` request (15-second maximum), comparing persisted room revisions every
500 ms. Sending a message or completing a task changes the revision in the same
database transaction. This works across service instances without in-memory
notification state. The 500 ms interval is detection cadence, not a measured
end-to-end delivery guarantee. Proxies must allow requests lasting 15 seconds;
failed/unsupported notification requests fall back to two-second polling.

Up to four rooms synchronize concurrently, publishing each room immediately.
Unchanged rooms skip message downloads; changed rooms fetch forward by the
(timestamp, ID) cursor plus explicit pending task IDs, so old completions are
not missed. A five-second overlap handles cursor boundary races; periodic full
reconciliation (five minutes) and startup history replay recover older gaps.
A lightweight reconciliation runs at least every 30 seconds. Stop/sign-out
aborts notification requests and stale sync generations cannot overwrite state.
Message IDs retain idempotent sends and deduplication. Deploy the service first,
then update desktops; older services continue using the original polling path.
No database migration is required.

The notification fast path now wakes same-process waiters immediately after the
message transaction commits. Listeners are installed before checking revisions
to avoid a read/subscribe race and removed on completion, abort, or timeout.
Other instances still detect changes through the 500 ms database fallback;
process memory is never required for correctness.

New desktops request bundled notifications (`includeMessages` plus per-room
cursors). A changed response includes the authorized room snapshot and up to
four incremental message pages. Desktops apply matching pages directly, avoiding
the separate snapshot and message HTTP round trips. Cursor mismatches, extra
pages, periodic reconciliation, and older servers fall back to ordinary sync.
This is an optimization of the existing long-poll protocol, not a WebSocket
migration. Multi-instance immediate fanout would require a shared event bus.

## Shareable group invitations

Group details → **Invite to group** opens a dialog with a seven-day invitation link. The dialog can copy the link or regenerate the invitation
after confirmation. QR codes and image exports are deferred. Regeneration revokes
the previous link. Any current member can share; a link issued by a member who
has since left is invalid. Opening the dialog reuses an unexpired invitation.

The desktop `group-invite` action promotes a local group through the existing
shared-group flow before requesting an invitation. The service allows a shared
group initially containing only its creator. It stores one expiring invitation
per room in the existing `verification` table (`group-invite:<roomId>`); no schema
migration is required. Tokens contain 32 random bytes and are never included in
normal room snapshots. Public previews expose only the name, member count and
expiry, not member identities or chat messages.

The web `/join-group` page preserves the invitation through login, requires an
explicit Join action and offers `douchat://group/open?room=...` after joining.
The app verifies membership through its authenticated inbox before opening the
room. If signed out, it waits for login; opening a link never silently joins a
room. The web and desktop accounts must match. Download links go to the website's
download section; after installation, users can reopen the invitation.

Joining is idempotent and respects the 50-person room limit. A server-controlled
`joinedAt` field on link-invited members limits history, cursor paging and pending
message updates to messages created after joining. Existing members keep their
history. Group revisions serialize membership changes against invite rotation.

Release both repositories together: the `douchat-tanstack` service/routes must be
deployed before the desktop invitation entry can work against production. The
local implementation and tests do not deploy the server or publish the desktop.
