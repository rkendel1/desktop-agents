# Local agent execution

Local agents are not universally ACP clients. Foundry uses the protocol supported by each CLI:

- Codex: persistent `codex app-server` over private stdio JSON-RPC. One live thread per account + agent configuration + conversation/topic.
- Claude Code: persistent `--input-format stream-json --output-format stream-json` session over private stdio. Session persistence to Claude's transcript files is disabled.
- Other built-in and custom CLIs: existing one-shot adapters. They receive startup/heartbeat feedback but do not yet reuse a process or native session.

See [Codex App Server](https://developers.openai.com/codex/app-server/) and [Claude CLI reference](https://code.claude.com/docs/en/cli-reference).

## Lifetime and isolation

At most eight persistent connections are retained. A connection is never used by two simultaneous turns. Idle connections are evicted after five minutes or when capacity is needed; active tasks are not evicted. Account switches, agent disposal, conversation resets, cancellation and normal application exit close the owned process tree. Workspace cleanup waits for the child process to close. Request timers, abort listeners and progress timers are released on completion and failure. JSON frames are bounded; the application does not retain the complete streaming output.

Warm turns reuse native conversation state instead of re-sending the direct-chat transcript. Cold direct-chat connections receive recent topic history (the existing 20-message / 24,000-character bound). Live connections are not persisted across app restarts. After eviction, cancellation or a crash, a subsequent user turn opens a new connection. Failed tasks are never blindly replayed: tools may already have changed external state. The sole retry is Claude's specific pre-execution credential-source conflict using its existing account-login fallback.

No transport opens a network listener or enables permission bypass. Unsupported interactive protocol requests receive an explicit error instead of hanging. Codex retains workspace-write sandboxing; Claude retains its tool allowlist and denies unattended permission prompts.

## Codex Computer Use

Foundry uses the Computer Use plugin/MCP servers configured in the user's Codex environment. It does not replace them with its embedded web browser or silently enable disabled plugins. macOS executable discovery also recognizes the Codex engine bundled in ChatGPT.app.

Before a tool-enabled Codex turn, Foundry queries the actual thread's `mcpServerStatus/list` inventory and supplies native desktop-tool availability to Codex. Discovery is bounded and falls back gracefully on older servers; inventory success does not imply that every app/browser is authorized. The model is instructed to use the installed tools and report actual failures, rather than infer machine-wide restrictions from a browser navigation error.

Native application-access confirmations from `cua_repl`, `computer-use`, or `computer_use` are forwarded to Foundry's owner approval UI. Only Computer Use confirmation metadata and empty-object forms are accepted, bound to the current thread and turn. Low-risk app-access requests with native session-persistence support can be explicitly approved for the current live connection and app; each later request is still checked by the owner permission broker. URL flows, input forms, mismatched turns and user-verification requests are not automatically approved. Cancellation invalidates outstanding approvals and connection-scoped grants. macOS Screen Recording/Accessibility permissions and Codex's own app policies still apply.

If native tools are absent, enable the Computer Use plugin in Codex/ChatGPT desktop and grant the requested OS permissions, then start a new Foundry conversation. Existing Chrome/browser control also requires the appropriate native browser integration; the built-in Foundry browser cannot control App Store.

## Long tasks and feedback

The old unconditional three-minute task timeout is removed. Protocol acknowledgements still have a 60-second timeout; it applies to accepting an RPC, not to completion of a running turn. The user can stop a task at any time. Every 15 seconds, a running task reports elapsed time and time since the last protocol event. Actual agent commentary and tool events update the visible activity bubble, throttled to once per second. After 60 seconds without events, the UI says it is waiting for new progress, rather than claiming continued successful work. These transient reports are not added as final chat answers.

While a local task is active, Electron requests `prevent-app-suspension`; this does not prevent forced sleep, shutdown, network failure, CLI/model limits, or external process termination. A disconnected task fails visibly. Tasks do not survive quitting Foundry.

## Verification

`localAgentConnection.test.ts` uses real Node subprocesses speaking the two protocols to exercise process/session reuse, topic/account isolation, cancellation, concurrent access rejection, crashes, malformed packets, long-running heartbeat behavior and idle workspace/process cleanup. Existing one-shot process tests continue to cover custom commands and Claude account-login fallback. Runtime and UI tests exercise visible progress state.

A local Codex two-turn smoke test verified retained context and warm reuse. Claude's live smoke test reached the CLI but failed on the configured account's insufficient credit; its successful multi-turn behavior is covered with the protocol fixture, not claimed as a live-model test. Windows process handling continues to use the executable-shim resolver and `taskkill /T /F`; this change still needs Windows interactive smoke testing.

## Conversation workspaces

Owned cloud/custom-model agents can also select a workspace in chat details.
They use `list_workspace_files`, `read_workspace_file` and `write_workspace_file`
to access that folder through the desktop host, subject to the agent's file
permissions. Paths are relative to the workspace; traversal and symbolic links
are rejected. Selecting a folder does not grant shell execution. Private groups
containing only the owner's agents can share a custom folder. Shared rooms and
other people's agents cannot use private conversation workspaces. The default
folder is managed per agent and topic; hovering over its label reveals an open
folder button.
