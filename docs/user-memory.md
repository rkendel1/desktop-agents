# User profiles and agent memory

Foundry separates agent configuration from information about its human user:

| Scope | Storage in the local `douchat.db` | Editor |
| --- | --- | --- |
| Agent personality, identity, tools and bootstrap instructions | `agents.data.systemFiles` | Edit agent → Customize |
| General user profile | `user_profiles`, keyed by `userId` | Settings → About me |
| User's relationship with a particular agent | `agent_user_memories`, keyed by `(userId, agentId)` | Edit agent → Private memory |
| Group member information and agreements | `group_memories`, keyed by `(userId, groupId)` | Group details → Group memory |

Profiles contain manually entered notes, remembered facts, an automatic-memory
switch and a revision number. Facts retain their stable key, originating agent
and a verbatim quote from the human message that supported the write. Manual
fact edits remove that attribution. Saving an outdated revision reports a
conflict and leaves the editor's draft intact; Reload fetches the latest data.

Normal names, hobbies and language preferences can be shared across the signed-in
user's own agents. Relationship-specific, sensitive or ambiguous facts default
to the agent-specific scope; sensitive facts require an explicit request to
remember. Agents are instructed not to store speculation, assistant-generated
descriptions, roleplay, third-party information, transient tasks or credentials.
Fact selection and scope classification are model decisions; the user can inspect,
correct or delete them and disable automatic memory globally or for one agent.

Hosted models use `update_user_memory`. Local agents use private
`[[douchat_user_memory]]` directives; Foundry removes the directives, validates
and persists them, and appends an authoritative receipt. Both paths require an
active authenticated human turn, exact evidence from its current message, matching
account/agent ownership, automatic memory enabled and no cancellation.
Paired IM conversations use the same owner context. Historical chats are not
automatically backfilled. Groups do not load or write private profiles. They load a separate group document
across topics, shared by this account's local agents in the same group. Local
human messages bind to the signed-in user; shared-room tasks bind to the trusted
requester's ID. Group facts are keyed by (speaker ID, stable fact key), so one
speaker cannot overwrite or forget another's records through the memory tool.
The editor displays speaker attribution and lets the account owner manage all
local group records. A member's statement is not treated as everyone's agreement.

Group memory has its own automatic-memory switch. Read-only group turns can use
saved context but cannot write. Controller, scheduled and agent-delegated turns
do not gain memory access. An unknown shared room is synchronized before task
execution. Disabling memory during a turn is rechecked before every write; revision
conflicts preserve editor drafts. Deleting the actual group row cascades its
memory, while hiding or clearing chat history does not erase saved memory.

Memory is loaded afresh on every eligible turn, including warm hosted sessions
and local CLI continuations. Clearing memory removes its future injection but
does not delete facts still present in ordinary conversation history. Start a
new topic or clear the relevant chat context when that history is also unwanted.

Legacy `USER.md` and `MEMORY.md` stored on an agent are moved, once, to its owner's
agent-specific document on database open. They are never automatically promoted
to shared profile data. Deleting an agent cascades its private memory, while
the user's shared profile remains. Account switching does not expose another
account's profile, and stale editor submissions are rejected by account ID as
well as revision. Memory is local to this installation; there is no cross-device
or remote-agent profile synchronization.
