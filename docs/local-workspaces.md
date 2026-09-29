# Local workspaces and session recovery

All local CLI adapters use the same workspace manager. Production storage lives
under the application's user-data directory, in `local-workspaces/`.

- `sessions/`: private metadata mapping account, agent and runtime session key to
  a workspace generation and optional native thread ID. Records are atomically
  replaced; account and agent names are hashed in paths.
- `files/`: persistent task files, isolated by account, agent, session key and
  generation. Model/personality changes retain files but invalidate the native
  session binding.

Closing Foundry, stopping a connection, or evicting an idle process does not delete
these files. Codex starts non-ephemeral app-server threads and resumes saved IDs.
Claude Code enables session persistence and captures the root session ID from its
initialization event, then uses `--resume` on reconnection. A recognized missing
session can be rebuilt with Foundry's transcript; execution failures are not
automatically replayed.

Other CLI adapters use the same stable directory, but continue receiving the
transcript through their existing one-shot interfaces. Stable files do not imply
native conversational memory support. Cloud model history remains managed by
Foundry; this directory policy applies to local CLI execution.

Clearing/resetting a conversation or deleting its topic invalidates saved thread
IDs even if no process is running. It starts a new workspace generation so an
old memory file does not silently reintroduce cleared context. Previous files
are retained, not automatically deleted. Late results cannot overwrite reset
metadata. These directories organize data; they are not a new OS security sandbox.

Existing temporary sessions cannot be retroactively resumed after they have
closed. Their first new persistent session is bootstrapped from the existing
Foundry transcript. Provider-native compaction and retention policies still apply;
this feature does not promise unlimited context or visibility in another app's UI.

Protocol references:
- https://developers.openai.com/codex/app-server (`thread/start`, `thread/resume`)
- https://code.claude.com/docs/en/cli-reference (`--resume`)

Resource policy: normal direct, group, and shared-room chats keep their stable
workspace and native thread binding. Internal controllers, health checks, and
other requests without a stable conversation key use temporary directories and
non-persistent threads; their files/processes are removed after the request.
Application-created reply/policy scratch files are removed after one-shot calls.
User inputs, generated assets, and memory files in persistent chats remain intact.

## Custom chat workspace

A direct chat with one of your own local agents, or a group whose members are
all your own local agents, can use a folder you choose (chat details →
Workspace). Shared rooms, person chats and any chat that includes a cloud agent
are not eligible.

- Every local CLI (Codex, Claude, Gemini, Grok, custom) runs with that folder as
  its working directory. Foundry does not create or recreate it; if it is moved
  or deleted, replies fail with an "unavailable" error until you pick another
  folder or restore the default.
- Agents sharing one folder run one at a time (a per-folder lock across chats).
  A stopped waiter releases its turn without blocking later runs.
- If a chat later stops being eligible (for example a cloud agent joins), runs
  fall back to the managed folder while the setting is kept; it applies again
  once the chat becomes eligible.
- Internal controllers, attendance checks and handoffs never use the folder.
- Reply/policy scratch files live in a temporary directory; input images are
  written to a `.douchat-input-*` folder inside the workspace and removed after
  the run.
- Native thread bindings are tied to the folder. Changing or clearing the
  folder starts a new thread and releases idle connections.
- Folders are rejected if they are the disk root, your home folder itself, a
  system location, Foundry's data folder, or not readable and writable.
