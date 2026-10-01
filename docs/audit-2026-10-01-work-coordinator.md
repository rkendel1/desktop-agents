# Work coordinator audit — 2026-10-01

## Finding

Foundry does not need a second orchestration or communication system. Its persisted group workflow is already a dynamic coordinator: it elects a leader, produces validated task graphs and assignments, dispatches only selected members, records private/public deliveries, retries or replaces unavailable members, can wait for a human, and journals calls for recovery. The safe incremental design is therefore a hidden group conversation inside the existing `CodingSession` boundary. `CodingService` remains the sole durable Work mutation authority.

The resulting path is:

`UI/AppPort → CodingService → hidden direct/group conversation → common runtime/group journal → CodingService → DesktopRepository → Project`

The group workflow is communication and replay evidence. It is not Work persistence.

## Agent and provider inventory

The local-agent catalog contains Claude Code, Codex, Gemini, Grok Build, OpenClaw, Hermes, OpenCode, Cursor, Kimi, oh-my-pi, FastClaw, and user-defined local command agents. Hosted/model adapters support OpenAI, Anthropic, OpenRouter, TokenDance, DeepSeek, Ollama Cloud, Ollama, and configured OpenAI-, Anthropic-, and Ollama-compatible providers. Jev is a separate local structured-decision runtime, not a coding participant. Compute is a launcher for eligible local CLI agents, not an agent/provider or state store.

Those are implementations, not semantic roles. `AgentConfig.role`, instructions, labels, and group routing profiles already represent semantic purpose. A Coder and Tester can use the same provider; a single configured agent can perform several roles. Explicit agent/provider/model configuration remains on each `AgentConfig` and is never rewritten by Work routing.

There is no special built-in “Coordinator” agent. Any runnable group member can be elected leader, while the configured Work coordinator is the initial lead and explicit user choice. Hosted decision-capable agents and local CLI agents use the same validated group-decision contract. This is sufficient; the only new abstraction required is a bounded, durable projection of coordinator decisions and participant turns onto `CodingSession`.

## Existing group-chat trace

`Conversation.agentIds` forms the roster and `leadAgentId` is the stable initial lead. `Runtime.sendMessage` routes group conversations to `runGroupTurn`. The runtime loads configured agents, health, durable topic messages, private deliveries, and any `GroupWorkflow` journal. A decision model or eligible group member produces a validated `GroupDecision`: none, single, parallel, sequential, or a dependency-checked task graph. It can explicitly address members, assign role-specific instructions, require a leader summary, recover by replace/skip/pause, or wait for a human.

Participants see bounded task evidence rather than an unbounded raw replay: group task evidence is capped, completed structured results are truncated, private context is recipient-specific, task instructions and expected outputs have limits, and parallelism is capped at four. Reply and planning paths have deadlines; abort signals cancel them. `GroupWorkflowJournal` persists decision/reply slots and refuses to replay an interrupted tool-bearing reply whose external effects are uncertain. Topic messages, private messages, runs, and workflows are durable FeltDB state.

Previously, this durable group state was separate from Work state. It can support Work coordination directly, provided only `CodingService` converts its bounded journal into `CodingSession.coordination`.

## Existing Work trace and coder assumptions

The renderer or AppPort explicitly starts Work. `CodingService.start` validates Project and agent, pins the folder, admits and prepares Compute when selected, creates a hidden conversation, captures the Git baseline, and creates the `CodingSession`. `execute` sets the launch resolver, sends the Work prompt through the common runtime, reads the common `TaskRun` and messages, accounts for Git changes, records checks/events/result, and updates the session. Continuation reuses the same private conversation/topic and fixed Project. Commands and checks also return through `CodingService`.

The coder assumption was concentrated in a single `agentId`, a direct hidden conversation, one reply author, and coder-oriented UI labels. Provider, model, Git, Compute, checks, persistence, and recovery primitives are otherwise role-neutral. The implementation retains `agentId` as the compatible coordinator/owner identity and adds an optional coordination projection instead of destructively renaming `CodingSession`.

## Work contract

`CodingSession.coordination` records:

- mode and coordinator identity;
- bounded candidate participants with semantic role, status, and turn count;
- structured coordinator decisions (`run-role`, `retry-role`, `change-role`, `complete`, `ask-human`, `block`);
- bounded participant turns with role, objective, status, concise result, and artifact evidence;
- limits, next step, and metrics (decision/participant turns, tool calls where measurable, elapsed time, retries, invoked and skipped roles).

Existing `TaskRun`, `ChatMessage`, `CommandResult`, Git changes, artifacts, and group journals remain the detailed primitives. They are not duplicated in the Work model. Project identity is immutable in repository update patches, the hidden conversation is created from the Project record, and the turn guard refuses workspace retargeting.

## Coordinator loop and budgets

The existing scheduler is the decision loop. It receives the objective, bounded group history/evidence, routing capabilities, failures, and completed turn summaries. Its validated decision selects only necessary members and explicit assignments. Participants execute through the existing reply path and return messages/artifacts. The coordinator then receives the new structured evidence and either dispatches another bounded turn, recovers, waits, or selects `mode: none` to complete.

This is dynamic; there is no Planner → Coder → Tester → Reviewer pipeline. Candidate selection is explicit in the UI. The chosen coordinator remains the initial lead, while validated leader election/failover can occur inside the journal. Agent configuration preserves its explicit provider and model.

Coordinated Work has at most 12 candidates, 12 participant turns, and 13 recorded coordinator decisions. Twelve participant turns is three waves at the existing maximum parallelism of four; the thirteenth coordinator decision allows a terminal decision after the last wave. Group task graphs remain capped at 32 tasks, but Work's tighter turn cap wins. Existing 120-second participant deadlines, planning budgets, abort/cancellation, bounded task packets, message/result truncation, provider output limits, tool permission system, and recovery journal also apply. Tool-call count is exposed as zero when the common journal cannot measure it reliably rather than inferred. Ordinary group chats retain their existing wider conversational allowance.

These bounds avoid the reported oversized-context failure: unselected agents receive no turn, each selected member receives its assignment plus bounded evidence, and the durable Work projection stores concise results rather than replaying full transcripts.

## Compute, routing, completion, and attention

Compute remains a launcher. Coordinated Compute Work is admitted only when every candidate is a configured local CLI agent; there is no local fallback and no Work state inside Compute. Hosted and local agents may coordinate for local execution. Precedence is: explicit user-selected coordinator/candidate agent configuration (including provider/model), validated coordinator member selection, then that agent's existing model-fabric/provider defaults. Work never silently substitutes another model for an explicit configured agent.

A participant may report completion, but the workflow completes only after the coordinator returns a terminal decision. `CodingService` then combines the journal result with common runtime status, messages, Git changes, checks, and errors before persisting Work. `waitForHuman` becomes `coordination.status = waiting` and a visible attention message; resuming uses the existing continuation and waiting-workflow recovery path. Permission approval continues through the existing Attention UI.

## UI and authority

Both Work entry points now name the explicit Coordinator and offer optional candidate participants with their configured roles. The default roster is only the coordinator. The Work detail view shows objective, coordinator, decision/turn budget, next action, human-attention state, concise participant work, and structured decisions. The detailed hidden conversation remains available only within that Work record and internal Work context is stripped from displayed messages; it never appears in ordinary project chat.

Architecture tests enumerate the sole Work writers, reject provider/Compute/renderer/group mutation routes, require the bounded Work scheduler, require the coordinator projector to have no repository access, preserve immutable `projectId`, and reject a hard-coded role pipeline.

## Intentionally unchanged

`CodingSession` is retained for storage and API compatibility. Existing provider adapters, TaskRun/messages, group scheduler and recovery journal, permission Attention, Git accounting, checks, FeltDB collections, and Compute control-plane ownership are reused. No second `Work`, coordinator chat, role registry, provider registry, or Compute persistence layer was introduced.

## Residual risks and follow-up

The common group journal does not yet expose an authoritative aggregate tool-call count or token count, so the Work metrics report only measurable values; provider/runtime output and wall-clock guards remain the enforcement points. Live UI activity is conversation-level and does not yet persist every planning tick by design. A future change may expose authoritative tool/token counters from the common runtime, but must not infer or duplicate them in Work persistence.
