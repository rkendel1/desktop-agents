# Audit: one Work → Project path (2026-10-01)

## Conclusion and invariant

Foundry has one durable Work mutation boundary: `CodingService` in
`src/main/coding/service.ts`. A Work item is a `CodingSession`; its `projectId` is fixed at
creation, and all production creation, status, result, evidence, continuation, cancellation,
and command-result writes go from `CodingService` to `DesktopRepository`.

The exact path is:

```text
desktop IPC or AppPort CodingApi
  → CodingService.start / continue / cancel / runChecks
  → private Work conversation + CodingSession
  → DouchatRuntime.sendMessage
  → hosted model OR local CLI (optionally launched by Compute)
  → common TaskRun + final ChatMessage
  → CodingService.execute
  → Git re-read/change accounting
  → DesktopRepository.updateCodingSession / addCodingEvent
  → CodingSession associated with its immutable Project id
```

There is an important source-authority qualification. A provider does not return a patch
that Foundry later applies. Local CLIs edit the selected checkout, and hosted models edit
through the jailed workspace tools, while the Work turn is running. The filesystem and Git
are authoritative for source; FeltDB is authoritative for the Project registration and Work
record. `CodingService` owns the pinned workspace, execution lifecycle, final Git accounting,
and durable association. Introducing a second patch/apply model just to make the diagram
literal would contradict the existing architecture.

## Work-generation inventory

| Ingress | Agent/provider and execution | Work/session | Common result | Durable conversion and Project association | Bypass? |
| --- | --- | --- | --- | --- | --- |
| Work tab | `ProjectsView.tsx` → preload → `douchat:start-coding-session` in `main/index.ts` | `CodingService.start` creates one hidden direct conversation and one `CodingSession` | `TaskRun`, final agent `ChatMessage`, Git state | `CodingService.execute` → repository session/event methods; `projectId` set once | No |
| Chat “Turn into work” | `ChatPane.tsx` creates only a draft; `TurnIntoWorkDialog.tsx` explicitly starts Work through the same IPC | Same as Work tab; it does not reuse the ordinary chat | Same | Same | No |
| Desktop Continue/Cancel/Checks | `CodingSessionPanel.tsx` and `ProjectsView.tsx` → their IPC handlers in `main/index.ts` | Existing `CodingSession`, same private conversation/topic/project/folder | New common run/reply, cancellation, or `CommandResult` | `CodingService.continue`, `cancel`, `runChecks` | No |
| Remote/AppPort | `main/appport/contract.ts` → `CodingApi` in `main/coding/api.ts` | Same `CodingSession` | Same | Same `CodingService`; API owns validation/views, not state | No |
| Hosted model | Runtime session/model stream in `main/runtime.ts`; built-in and configured providers use the common runtime model interface; optional fabric lives in `main/models/*` | The `CodingSession` created before invocation | Runtime persists the common run and reply | `CodingService.execute` reads them and finishes the same session | No |
| Local command-line agent | `runtime.ts` → `desktopAgentExecutor.ts` → `localAgentRuntime.ts`; built-ins are Codex, Claude, Gemini, Grok, Cursor, OpenCode, Kimi, OpenClaw, FastClaw, Hermes and oh-my-pi, plus configured custom local agents | Same | `LocalAgentReply` is converted by the runtime into the same run/reply records | Same | No |
| Compute-backed command-line agent | `CodingService` asks `EnvironmentService` for admission, creates a `LocalLauncher` in `compute/launcher.ts`, then invokes the same runtime | Same, with `execution.kind === 'compute'` | Same runtime records; Git is read through the Compute checkout | Same | No |
| Resume/retry | `CodingService.continue`; Codex/Claude may resume their native thread, other CLIs start a new provider conversation | Same session id, project id, Work conversation and topic | New run/reply | `resumeCodingSession`, then the normal finish path | No |
| Startup recovery | repository startup calls `recoverInterruptedCodingSessions` | Existing sessions left `running` by the prior process | No provider result | Repository changes only `running` → `interrupted` | Intentional lifecycle exception |

Background routines, messaging connectors, group/direct chat turns, Jev evaluations, and CI
all invoke agents or commands, but they do not create or update `CodingSession`. Routines and
chat create `TaskRun`/messages; Jev persists its own structured decisions; CI persists `CiRun`
and runs against an ephemeral Compute checkout. They are execution surfaces, not Project Work
ingress. Their separation is enforced rather than relabelled as Work.

There is no import/external-Work ingestion path and no separate Work CLI or server action.

## Provider convergence and model routing

Provider choice occurs inside `DouchatRuntime` (`src/main/runtime.ts`). The coding service
depends only on the small `CodingRuntime` interface and never switches on provider names.
Hosted streams and `LocalAgentReply` both finish as a `TaskRun` plus agent `ChatMessage`, which
is the only provider result shape `CodingService.execute` reads.

The model fabric remains optional. In `runtime.ts`, an agent's explicit model takes the direct
path unless the agent explicitly enables automatic selection, or it follows the default while
the global automatic policy is enabled. The regression is exercised in
`src/main/models/runtime.fabric.test.ts` and guarded structurally in
`src/main/authority.test.ts`; an explicitly selected Qwen/custom model is therefore not
silently replaced merely because global routing exists.

Compute is an execution substrate only. `compute/client.ts` speaks the Compute contract and
`compute/launcher.ts` launches/observes a process; neither imports Work persistence or writes a
Project. A hosted-model agent has no command-line process to place on a Compute Computer, so
`CodingService.start` rejects hosted + Compute before creating a conversation or session. Both
Work entry UIs now use `canRunWorkOnCompute` from `shared/coding.ts`, while the service remains
the authoritative validation boundary.

## Session, chat, and prompt separation

`DesktopRepository.createCodingConversation` creates a fresh `work-…` direct conversation for
every Work session. It is hidden, has one agent, carries the Project workspace, and is excluded
from ordinary Project chat lists. Continue reuses only that Work conversation and topic.

Normal chat calls `sendMessage` and can produce runtime messages/runs, but it cannot produce a
`CodingSession`. “Turn into work” is the explicit bridge and starts through the same canonical
service. The renderer also strips the internal `FOUNDRY-WORK-CONTEXT` suffix when displaying a
Work conversation. Thus runtime guidance is not shown as user-authored content and, because the
conversation is isolated, cannot appear in the agent's regular chat history.

## Mutation graph

```text
CodingService.start
  ├─ DesktopRepository.createCodingConversation
  └─ DesktopRepository.createCodingSession

CodingService.continue
  └─ DesktopRepository.resumeCodingSession

CodingService.execute / runCommand
  └─ DesktopRepository.updateCodingSession

CodingService.record
  └─ DesktopRepository.addCodingEvent

Desktop startup
  └─ DesktopRepository.recoverInterruptedCodingSessions  [recovery only]
```

The production call search finds no other caller of the four repository Work mutation methods.
`updateCodingSession` omits `projectId`, `id`, and `createdAt` from its patch type, so a result
cannot retarget Work to another Project.

Project-level writes that are not Work-result mutations are intentionally separate:

- `CodingService.addProject` registers a validated folder through `repository.addProject`;
  desktop folder selection and `CodingApi.addProject` call it.
- `main/index.ts` removes a registered Project and sets its owner-confirmed test command.
- `EnvironmentService` alone writes the Project → development-environment reference.
- `CodingService.gitStage`, `gitUnstage`, and `gitCommit` perform explicit owner Git actions and
  refuse to run while Work is active.
- project chat creation stores discussion metadata only; it creates no Work.
- `CiService` writes `CiRun`, not `CodingSession` or Project Work.

These are legitimate Project configuration/lifecycle operations, not competing paths for an
agent result to enter Project Work.

## Persistence and UI boundaries

`DesktopRepository` is the only production FeltDB application repository
(`main/desktopRepository.ts`; the in-memory repository is a test implementation). `Workspace`
rows represent registered Projects and `CodingSession` rows represent Work. Providers, Compute,
and renderer code do not import FeltDB or call Work repository mutations.

The renderer owns drafts and display state only. Its production Work mutations are the preload
methods `startCodingSession`, `continueCodingSession`, `cancelCodingSession`, and
`runCodingChecks`; IPC and AppPort both end at `CodingService`. Live activity is ephemeral and
never becomes a competing durable status store.

## Violations found and changes made

1. Work previously reused an agent's ordinary direct conversation. It now receives a private,
   hidden conversation from `createCodingConversation`, and Project chat queries exclude it.
2. A globally automatic model policy could override an explicitly selected agent model. The
   direct-model condition in `runtime.ts` now preserves explicit selection unless that agent
   opts into automatic routing/follow-default behavior.
3. Hosted + Compute was representable in both Work entry UIs even though the backend correctly
   refused it. `canRunWorkOnCompute` now supplies one UI rule, both entry surfaces disable
   Compute for hosted agents, and `CodingService` still fails closed.
4. Work screens mixed “This Computer”, “Compute environment”, and environment-detail language.
   Work execution is now labelled consistently as “Project folder on this computer” or
   “Compute · <environment>”; environment lifecycle detail stays on the Environment surface.
5. Work details exposed ordinary-chat affordances and could display the internal prompt suffix.
   Work now has its own focused continuation/result UI and removes the suffix from displayed
   messages.
6. Running the real integrations on macOS exposed two test/cleanup portability defects:
   `/private/tmp` is correctly forbidden as a Project workspace, so coding fixtures now use a
   user-owned checkout directory; and the Darwin process ledger no longer includes changing
   `ps` status flags in process identity. Its identity is the stable OS start time, as documented.

## Enforced tests

- `src/main/authority.test.ts`, “Work → Project authority”, enumerates every production caller
  of the mutation methods and Work ingress, rejects provider/Compute/renderer persistence, and
  verifies runtime-result convergence, isolated conversations, immutable Project identity, and
  hosted + Compute rejection.
- `src/main/coding/coding.test.ts` runs real local child-process agents through the service,
  proves isolated sessions, result/change persistence, resume, cancellation, and invalid
  combinations.
- `src/main/compute/compute.test.ts` and
  `src/main/environment/environment.dogfood.test.ts` run the same `CodingService` session on a
  real fixture Compute backend and prove the result returns to `CodingSession`.
- `src/main/models/runtime.fabric.test.ts` proves direct explicit-model routing and optional
  automatic routing with real provider-shaped streams.
- `src/main/runtimeWorkspace.test.ts` proves hosted workspace tool execution is jailed to the
  selected workspace and returns through the runtime.
- renderer tests cover both Work entry surfaces and Work detail isolation/terminology.

## Remaining intentional exceptions and risks

- Source mutation occurs during provider execution, before the final reply. The single path is
  a durable Work/Project boundary and source-accounting boundary, not a transactional patch
  application boundary. Concurrent human/tool edits cannot always be attributed perfectly,
  although baseline fingerprints distinguish most changes.
- `DesktopRepository` exposes mutation methods because it is the persistence abstraction;
  TypeScript cannot make methods callable by only one class. The source-enumeration guard is the
  enforcement mechanism.
- Startup recovery writes `interrupted` directly inside the repository because no live service
  or provider remains. It cannot attach a result or change Project identity.
- Project removal, test-command configuration, environment references, Git actions, chats, and
  CI are intentionally outside Work-result mutation, as classified above.
- The internal Work instruction suffix is still stored in the isolated Work message because it
  is model input; it is hidden from presentation, not removed from durable Work history.
