# Account and contact Markdown files

Foundry keeps shared user information and contact configuration in one account
file hierarchy under the application's user-data directory:

```
accounts/<sha256(account-id)>/
  shared/
    USER.md
    MEMORY.md
    memory/YYYY-MM-DD.md
  agents/<sha256(agent-id)>/
    USER.md
    MEMORY.md
    memory/YYYY-MM-DD.md
    SOUL.md
    IDENTITY.md
    AGENTS.md
    BOOTSTRAP.md
    TOOLS.md
    HEARTBEAT.md
```

Files are created when configured; untouched identity files need not exist.
IDs rather than names keep the paths stable when contacts are renamed. On macOS
production uses `~/Library/Application Support/douchat`; development uses
`douchat-dev`. The customization panel displays the contact directory; memory
settings display the exact USER.md, MEMORY.md and dated-history paths.

Markdown is the source read by both settings and model prompts. Database fields
retain migration/recovery snapshots, not competing identity definitions.
Settings saves and automatic agent updates write the same files. Manual file
edits apply on the next read/turn. Stale settings submissions and agent edits
are rejected rather than overwriting changed files. Identity batches have a
recovery journal so an interrupted write finishes on the next read. Deleting a
contact removes its current directory. Removing an initialized identity file
clears its old instructions instead of restoring the database copy.

On upgrade, database identity text is exported only where files do not already
exist. Existing USER.md files from the older `memories/` hierarchy take priority
over their database copies, and are copied into the new hierarchy. Old files
are retained as migration backups and are no longer active. Subsequent reads
use the `accounts/` directory. Never edit the old copies expecting them to apply.

## User memory

USER.md and MEMORY.md contain readable Markdown with `douchat-memory` comments preserving
fact keys, exact source evidence, account scope, and revision. Edit text between
the comments and keep the comments intact. To delete a fact manually, remove
its comment and text. To clear all memory, use memory settings. If USER.md is
missing, the database recovery copy is restored. Malformed files produce an
error and are not silently overwritten. Automatic remembering, forgetting, and
settings edits use these same files.

Owned contacts and verified local internal groups can read account memory across
contacts and internal groups. Source documents stay in their original scopes;
sharing is read access, not copying everything into every contact's files.
Prompts receive bounded, source-labelled summaries and relevant historical
excerpts, including recent internal conversations for tasks not previously saved.
Hosted agents can use `search_internal_memory` to retrieve more relevant context.
Local CLI agents receive retrieved context in their prompt.

Remote/shared rooms and external callers receive only that room's memory, never
this internal account context. Cached remote membership is not sufficient proof
of an owner-only audience. Search access rechecks account and audience at each
call. Linking an internal group to a shared room starts a separate memory audience;
old internal memory remains stored but is not exposed to that room. Stale settings
writes from the previous audience are rejected.

Owner-assigned tasks, travel plans and agreed next steps may be saved as `memory`
with source evidence and stable keys for status updates. A successful save is
required before claiming persistence; saving is not booking, scheduling a reminder,
or completing the task. Transcript claims are historical evidence, not proof of
successful execution. Incomplete retrieval must not be reported as “no tasks”.

## Automatic identity updates

Contacts can maintain their own configuration when their owner explicitly
requests a persistent role or behavior change in a private chat.
`read_agent_files` reads current Markdown. `update_agent_files` updates identity
files using a quote from the current human request and exact previous content.
The tools cannot target another contact, change permissions/model routing, or
create scheduled tasks. User profiles and memory still use `update_user_memory` so privacy,
evidence, and memory controls apply. Group, delegated, scheduled, and completed
turns cannot use self-editing tools.

Local CLI contacts use a private `douchat_update_agent_files` directive validated
by the same code. Foundry removes the directive from visible output and appends
a result receipt. Hosted contacts receive a tool receipt. Files apply on
subsequent turns and can be reviewed in contact customization settings.

## Tiered long-term memory

Both `shared/` and each `agents/<id>/` directory now use:

```
USER.md                 # Stable user background/preferences
MEMORY.md               # Current long-term agreements, conclusions and progress
memory/YYYY-MM-DD.md    # Dated changes and previous versions, in local calendar time
```

`USER.md` and `MEMORY.md` are the current summaries. Their combined limit is
100 facts and 20,000 content characters per scope. Stable profile facts are not
automatically evicted. When a new remembered fact exceeds the summary limit,
the oldest saved non-profile facts leave the summary but remain searchable in
the dated files. Stable keys replace current facts when corrected. This is
bounded retention of current facts, not an automatic LLM rewrite of every diary.

The daily files record actual saved changes, not full chat transcripts or an
empty file for every day. They are not loaded wholesale into model context.
Hosted contacts have scoped `search_user_memory` and paginated
`read_user_memory` tools. Local CLI contacts receive keyword-matched historical
excerpts retrieved by Foundry for the current message. Search supports segmented
Chinese/Unicode keywords; it is lexical search, not vector/semantic search.
Results are bounded (8 excerpts; at most the most recent 5,000 dated files per
scope) and report truncation. Each historical result is marked as potentially
superseded. Current summaries and explicit human corrections take precedence.

Automatic saves default to the contact's private scope. Cross-agent sharing
requires an explicit human request, represented by `shareWithAll: true` on the
save tool. The model must include the current human's exact words as evidence.
USER.md uses `kind: profile`; agreements and decisions use `kind: memory`.
Human memory settings can edit either category, the summary notes, or move a
fact between categories. Identity/workflow requests still use the separate
identity-file tools.

Explicit forgetting deletes a stable key from current facts and all active
dated history, even if the key already left the summary. Deleting a fact through
settings does the same. Clearing memory through settings also clears dated
history. These operations do not erase original chat messages or external
backups. Summary/history writes use a durable batch journal; recovery does not
reapply an already-committed history mutation after a database interruption.

Older unclassified facts in a combined USER.md migrate to MEMORY.md; existing
profile notes remain in USER.md. No heuristic guesses or fabricated historical
dates are introduced. Migrated records enter the diary on the migration date.
The original evidence remains attached. Existing profiles and group memories
retain their scope boundaries; group memory remains independently stored.
