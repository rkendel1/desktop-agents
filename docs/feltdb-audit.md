# FeltDB authority audit

Scope: every production path in `src/` that could become a second durable
authority beside FeltDB. Enforced going forward by `src/main/authority.test.ts`
and the promise lint rules in `eslint.config.js`.

Result: **no production path uses `FileJsDb`, a `Table`, a per-write `emit()`, a
synchronous repository read, or a direct database mutation outside the
repository.** Two in-memory working sets and one configuration file are documented deviations (below).

## Searched terms

| Term | Occurrences in production code | Classification |
| --- | --- | --- |
| `FileJsDb` | none in `src/`. It exists only inside `node_modules/@feltdb/core` (its file engine, behind `createFeltDB`). | legitimate infrastructure (library internals) |
| `Table` / `SyncStore` | none. (Earlier: a `Table<T>` cache per collection over `FileJsDb`, and a synchronous `DesktopStore`.) | removed |
| `emit(` / `notify` / `changed()` / `refresh` | Main process: only `agentPermissions.ts` `changed()`, announcing a pending permission prompt held in memory. Renderer: `skillMarkdown.ts` `emit(line)` (markdown text builder), resize/measure callbacks, the unsent-message queue. | legitimate: none of these announce persistence |
| `@feltdb/core` imports | only `src/main/felt/database.ts` | legitimate infrastructure |
| `.felt.collection`, `.felt.transaction`, reactive graph | only `desktopRepository.ts`, `memoryRepository.ts`, `felt/database.ts` | legitimate: the repository boundary |
| `node:sqlite` | only `legacy/migrate.ts`, opened read-only | compatibility/migration code |
| Synchronous repository access | none: every `DesktopRepository` method returns a promise (checked by type, by `authority.test.ts`, and by `no-floating-promises`/`await-thenable`) | — |
| Test fixtures | tests open real FeltDB directories through `testSupport.ts`; there is no fake synchronous store | test fixture |

## In-memory state, classified

| State | Where | Class | Why it is not a competing authority |
| --- | --- | --- | --- |
| Agent statuses, activity, tool actions, pending replies, sessions, queues, abort controllers, workspace locks | `runtime.ts` | live process state | Describes running work; meaningless after a restart. Never written to FeltDB; sent to the renderer through `ephemeralChanged()`. |
| Pending permission prompts, native sessions | `agentPermissions.ts` | live process state | Same. |
| Browser/computer sessions | `computer.ts` | live process state | Same. |
| Running game jobs | `groupGames.ts` `running` | live process state | The game record itself is read and committed in FeltDB (`commitGame` with a revision check). |
| One-time routine retry counters | `scheduler.ts` | live process state | The routine and its `nextRunAt` are in FeltDB; multi-step scheduler changes are one transaction. |
| Model availability cache | `runtime.ts` `liveAuth` | derived cache | Result of a live auth probe, not application data. |
| Model registry (`customProviders`, `decisionProviders`) | `runtime.ts` | derived from FeltDB + vault | Rebuilt from the stored provider records (and their vault secrets) at startup and after every save (`configureCustomModels`). Nothing writes to it; it cannot be edited except by editing FeltDB. |
| Projection change batches | `projection.ts` | transient | Change ids waiting for the next microtask flush; emptied on flush, values re-read from FeltDB. |
| Renderer `snapshot` state | `App.tsx` | projection | Rebuilt from `getSnapshot` + deltas; discarded on restart. |
| **IM channel working set** | `imChannels.ts` `records` | **documented deviation** | Loaded from FeltDB/vault at activation and kept beside the live workers. Every change awaits `storage.save(...)` before it is acknowledged, and the manager is the only writer, so it cannot diverge — but it is a copy, and `save` rewrites the whole set. Follow-up: move it to per-record repository calls. |
| **Custom local agent registry** | `localAgents.ts` → `userData/local-agents.json` | **documented deviation** | The list of user-registered agent CLIs (name, command, arguments) is a JSON file written outside FeltDB. It is configuration, not chat/session state, and nothing else caches it, but it is a second durable store for that configuration. Follow-up: move to a FeltDB collection. |
| **Skill file directories** | `desktopRepository.ts` (`writeFileSync` on agent update) | derived materialization | The skill's content and files are stored in the agent's FeltDB record; the directories are regenerated copies a local CLI can read. Losing them loses no data. |

## Sync filesystem access

| Use | Class |
| --- | --- |
| `felt/database.ts`: lock file, pre-open damage check | legitimate infrastructure (runs before FeltDB opens) |
| `credentialVault.ts` | separate by design: secrets must not be in FeltDB (`desktop.test.ts` asserts a key never appears in FeltDB's files) |
| `localWorkspaces.ts`, `workspaceTools.ts` | the user's project folders, not application state |
| `legacy/*` | compatibility/migration code, read-only |

## Defects found and fixed while auditing

- FeltDB transactions rejected ids containing `/`, `:`, non-ASCII characters or over 128 characters (topics, group members, IM and workflow message ids) — fixed with the reversible key mapping (see `feltdb-architecture.md`).
- FeltDB answers a query with at most 100 records by default; `all()`/`where()` would have silently truncated a collection — fixed by paging, with a 1,230-record regression test.
- A greeting could start twice because the guard was checked before the slow reads — now claimed first.
- Cancelling a running group game did not stop its generation until after several reads — now immediate.
- Run-event writes recorded from model callbacks are now chained, awaited before a turn completes, and drained at shutdown.

## Not part of this migration

`localAgentConnection.test.ts` › "terminates owned descendant processes when a
connection is disposed" fails identically on the commit before this work
(`6e0794b`); it is an environment-dependent process test, unrelated to storage.
