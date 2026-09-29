# Local state: FeltDB is the authority

> **FeltDB is the single durable authority for Desktop state.**
> `DesktopRepository` is the asynchronous application boundary over that authority.
> The renderer is a projection of FeltDB state, not an independent state store.

Douchat has no account and no cloud dependency. Everything the desktop remembers —
agents, chats, groups, topics, messages, routines, runs, group games and
workflows, settings, memories — lives in one embedded [FeltDB](https://www.npmjs.com/package/@feltdb/core)
(`@feltdb/core` 0.11.9) database in the application-data folder:

```
<userData>/felt/           state.json + journal + blobs (FeltDB's own files)
<userData>/felt/desktop.lock   which process owns it (removed on close)
<userData>/credentials/    provider and mailbox secrets, encrypted (never in FeltDB)
```

```
Douchat UI ──IPC──▶ DesktopRepository (async) ──transactions──▶ FeltDB (durable)
     ▲                                                              │
     └──── deltas ◀── DesktopProjection ◀── change announcements ◀──┘
```

## Coding invariant

> **A coding agent operates against an explicit project working directory. The
> repository filesystem is the authority for source code; FeltDB is the authority
> for application/session state.**

Projects and coding sessions are FeltDB records (`Workspace`, `CodingSession`);
the code, its Git state and any generated files stay on disk, and the agent and
its commands are OS processes that are never persisted. See
[coding-execution-path.md](coding-execution-path.md).

## The rules

1. **The repository is asynchronous.** Every `DesktopRepository` method returns a
   promise. There is no synchronous read path, and no `Table`, `Map` or array
   that holds a second copy of durable state. Reads ask FeltDB.
2. **Writes are FeltDB transactions.** An operation that changes several records
   (a turn's message plus its run and tool state, creating a group with its
   members and topic, deleting a chat with its messages) stages every write in a
   `Batch` and commits them in one FeltDB transaction: after a crash you see all
   of it or none of it. If the operation throws, nothing was written.
3. **Reactivity comes from FeltDB.** `DesktopProjection` subscribes to FeltDB's
   change announcements and turns each into a small delta for the renderer. Only
   the changed record (or the one chat/agent composed from it) is read again.
   No code calls `emit()`/`notify()`/`refresh()` to say "persistence changed".
   Only state that never reaches FeltDB — who is busy, pending permission
   prompts, open browser sessions — is pushed, via `ephemeralChanged()`.
4. **No second durable store.** There is no fallback database. If FeltDB cannot
   open, the app shows an error and exits. `FileJsDb` is not used; it exists only
   inside `@feltdb/core`.
5. **The renderer holds a projection.** It reads one snapshot
   (`getSnapshot` → `{ snapshot, sequence }`) and then folds deltas in with
   `applyProjection`. Deltas carry whole current values (or `null` for gone), so
   applying one twice is harmless; deltas at or below the snapshot's sequence are
   skipped. A restarted window therefore rebuilds from FeltDB alone. Snapshots
   are built only at that moment — never per write.

## Why the graph subscription and not `collection.subscribe`

In 0.11.9 `collection.subscribe` costs O(collection size) per write, and a
transaction commit announces nothing. `FeltDatabase.subscribe` uses FeltDB's own
reactive graph (the notification a single write makes), and `FeltDatabase.transaction`
publishes each committed change to it after the commit, so a 1,000-message chat
costs the same to append to as an empty one (asserted in tests).

## Ids and keys

FeltDB transactions accept only keys of `[A-Za-z0-9._-]`, at most 128 characters.
Desktop ids are richer (a topic is `session/topic`, a group member `group:agent`,
IM message ids contain `:`, workflow message ids can be long). `recordKey` maps an
id to a key reversibly:

| id | key |
| --- | --- |
| already safe | the id itself |
| otherwise, if it fits | `_` + base64url of the UTF-8 bytes |
| too long | `.` + SHA-256 hex; the row keeps the original id in `rid` |

Rows always report the original id, announcements carry it (including deletes),
and callers never see keys. Unbounded reads page through FeltDB (its queries
return 100 records by default and would otherwise truncate silently).

## Startup and shutdown

Startup is explicit and ordered: open FeltDB (lock, damage check, flow
validation) → repository → legacy migration → runtime and scheduler → IM
channels → window. Any failure before the window is fatal and reported; nothing
falls back.

Shutdown (`before-quit`): stop accepting work → stop update checks, IM channels
and model queries → cancel everything in flight so each turn persists its final
state → wait for the scheduler, games, queued turns and run-event writes → stop
the projection → close FeltDB (awaits its writes, folds the journal into a
snapshot, releases the lock). Durable writes are never fire-and-forget.

## Migration from earlier releases

On first launch, `douchat.db` (SQLite), memory and profile Markdown, attachments
and workspace bindings are imported into FeltDB, then read back to verify. It is
read-only against the old files, keeps every id, and finishes before the runtime
starts. Running it again — even after losing its "complete" marker — replaces
records instead of duplicating them. Hosted-account state (cloud contacts,
friends, credits) is counted in the report, not imported; old provider secrets
move into the encrypted credential vault. A failed import records an attention
item and is retried on the next launch.

## Offline behavior

Creating, reading and updating agents, chats and messages needs no network, no
account and no configured provider (`startDesktop` makes no network call;
FeltDB's telemetry is disabled). Models, IM channels and manual update checks
use the network only when the person uses them.

## Tests that hold this together

`src/main/felt/database.test.ts` (durability, transactions, reactivity, ids,
unbounded reads, fail-closed open), `src/main/desktopRepository.test.ts`
(atomic multi-record operations, announcements, 1,000-message chat),
`src/main/projection.test.ts` (renderer rebuilds from FeltDB, deltas equal a
fresh snapshot), `src/main/desktop.test.ts` (offline, shutdown persistence,
migration idempotency, secrets stay out of FeltDB).
