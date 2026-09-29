# Local group collaboration

New desktop workflows route a leading, unambiguous human `@member` directly to
that member, without a planning call, group-wide health probes or a dispatch
notice. Their public/private handoffs execute directly and stop once settled.
The account's saved decision mode handles other initial requests (including
attendance and multiple mentions), their follow-up handoffs and failure recovery.
The selected policy elects `leaderMemberId` using the task,
member profiles, shared context, health and latency. A healthy existing leader
can retain ownership on contextual continuations. The runtime executes validated
plans and does not replace the policy with a keyword route or speed-only election.

- Greetings and ambiguous requests default to one short leader response. The
  controller marks `waitForHuman`, which enforces a single reply and ends the
  scheduling round without handoffs or another coordination pass. Clarification
  questions are valid stopping points until the human replies.
- Hosted activities use `leaderFirst`: only the leader opens the activity;
  other participants run after concrete public handoffs or private deliveries.
  Eventual participation alone does not schedule a reply.
- Contextual references use `addressedMemberId`: the resolved addressee owns
  the initial turn without an inserted leader or automatic follow-up dispatch.
  A third party named as a delivery target runs only after a real handoff.
  Resolution is model-driven; new tasks are not automatically assigned to the
  previous speaker.
- For an unmentioned follow-up, the policy receives `conversationContinuity`:
  the sole speaker from the preceding human turn, with that request and recent
  reply bubbles. It classifies personal questions, corrections, elaborations and
  acceptance of that speaker's offer as a continuation. Chat models return
  `continueConversation=true`; System One uses `route=followup`. The runtime binds
  these replies to that member without a leader handoff notice or summary.
  Explicit addresses, fresh topics, multiple prior speakers, unavailable members,
  and pending group-task checkpoints do not inherit this route. Clearly new tasks
  still get a new worker selection. Fallback planning prefers the conversational
  partner, while the group's elected leader remains a separate role.
- A leading single @mention goes directly to its recipient, who interprets the
  request and retains normal tools. For an explicit no-reply instruction, the
  recipient returns `[[douchat_silent]]`; the runtime emits no public message.
  Quoted mentions, references in prose, unknown/multiple recipients and
  agent-posted requests retain policy routing. Workflows awaiting clarification
  retain their full task context. Journals before scheduling version 4 replay
  their original policy route to avoid repeating completed work.
- The controller chooses ordered execution for dependent work, including requests
  addressed to multiple members or @all. Workers see earlier results and private
  handoff triggers. There is no automatically inserted leader opening. The policy
  can explicitly schedule hosting or final consolidation when needed.
- Independent requests such as “大家每人讲个笑话” start the requested members in
  parallel, including the leader. There is no extra leader acknowledgement turn.
  Replies appear as each finishes and activity tracks the remaining members.
- For policy-planned tasks, public @mentions and private deliveries become inputs to the next policy
  decision. Handoffs to members already in a declared plan retain their message
  triggers; additional recipients require a new policy decision. A bounded turn limit and cancellation prevent
  unbounded exchanges.

All agents can send `[[private:MEMBER_ID]]...[[/private]]` or
`[[private:human]]...[[/private]]` during a group turn. The runtime strips these
blocks from public text, persists private messages, and supplies bodies only to
the sender and recipient. The controller sees envelopes only. Group receipts
show delivery status without expandable bodies. Human deliveries restore the
sender's direct conversation if necessary and add an unread notification; replies
in that conversation include the private context.

`[[private-info:MEMBER_ID]]...[[/private]]` delivers information without waking the
recipient. Independent batches run at most four agents at once. Structured plans
can attach `assignments`, retain supervision, and require final leader consolidation.
The runtime records `running`, `waiting`, `completed`, `paused`, or `cancelled`
workflows. A human clarification retains the earlier task and requested contributors.

## Member health and task ownership

Health is persisted per account and group, with a fingerprint of member/model and
provider configuration. New or changed members are probed; healthy results default
to a 300-second cache. **群成员健康探测周期（秒）** in decision settings accepts
30–3600 seconds. Failed/unknown members may be rechecked on a new task after 30
seconds. No background polling runs when the group is idle.

Probes request only `PONG`, without conversation history. Up to eight run together
within a six-second total dispatch budget. A first slow cold start remains unknown,
not conclusively offline; a timed-out retry never revives a previously failed
member. Timed-out work is cancelled and late probe results are ignored. Cloud
probes have no tools; local probes use an isolated CLI run with a no-tools prompt.
Local CLI installed tools remain governed by that adapter's own restrictions.

Runtime results update cached availability and latency. Ranking determines the
order of candidate controller calls when using the default policy or its fallback;
it does not elect the actual leader. The returned decision elects the leader,
which is persisted with the task journal. The desktop targets a single process,
not distributed leader election.

Attendance such as `先来报个数` uses the same configured policy. The policy returns
an ordered plan with `participationOnly=true` and individual assignments. There
is no extra opening or summary. A failed slot invokes the same policy with a
`recovery` context: it chooses `skip`, `replace` or `pause`, plus an available leader.
Required deliverables cannot be skipped, and personal participation cannot be
replaced by impersonation. Completed steps and the remaining plan are preserved.
Private triggers cannot be reassigned to a member who cannot access them.

Cloud attendance uses separate sessions without tools and a 15-second reply
budget. Cloud decision planning has a shared 40-second budget across schema correction,
local member-controller planning has 20 seconds, ordinary replies have
120 seconds, and reply queue admission is bounded by the requested reply timeout.
The complete decision/fallback chain has a shared 120-second deadline. Expired queued work cannot run
later. These execution limits and authorization checks apply to every policy.
Authentication/startup failures can be reassigned; an interrupted local operation
with unknown external effects pauses for review instead of repeating the operation.

## Decision models

Settings → Scheduling（调度）→ 群决策服务 offers two account-scoped modes:

- **默认** asks a group member's isolated controller to elect a leader, plan the
  work and decide recovery. It needs no separate decision model configuration.
- **决策模型** uses Foundry Cloud's published Jev model and charges the displayed
  credits per successful call; no separate API key is entered in the desktop UI.
  The runtime also retains ordinary custom-model and System One adapters for
  compatibility and tests. Legacy self-funded settings are not silently converted
  into paid cloud usage.

See [routing profiles and task graphs](group-scheduling-improvements.md) for
agent-file visibility, typed worker selection, catalog caching, task evidence,
DAG execution, recovery and monitoring boundaries.

Jev's uncertain or multi-stage decisions escalate to an isolated member controller;
a confident Jev leader choice is preferred as the fallback controller. The
validated fallback plan makes the final election, so its leader and work plan
remain consistent. Unavailable decision
services also fall back automatically. `Decision requested`, `Decision fallback`
and `Decision applied` run events expose the selected configuration, phase,
fallback reason and final plan. There is no fallback checkbox. A task snapshots
its decision settings, including across recovery; edits apply to the next task.

Members continue using their own reply models. Jev is neither a player nor a
judge and receives no game identities or private-message bodies. Credentials stay
in the main process. Transport errors have bounded deadlines and a circuit breaker.
Compatible OpenRouter models use roster-constrained JSON Schema; unsupported
endpoints fall back to validated JSON. Format correction never dispatches work. An initial cloud LLM no-reply result is
checked by the same model against the unanswered request before being accepted.
Conflicting personal-participation/hosting flags are rejected instead of silently
truncating the roster.
OpenRouter model metadata controls optional reasoning for bounded decision calls;
mandatory reasoning models retain low reasoning. Streamed replies preserve their
authorized tool configuration.

Human checkpoints require an actual clarification question, then persist a waiting
state. Cloud clarification turns have no tools. Requested public deliverables are
checked before committing; a private-only response may be repaired once using only
public context and no tools. The policy explicitly lists `publicDeliverables`; no privacy keyword matching is used to infer this requirement. An omitted list does not force a private-only response into public text. Members follow the language requested by the human, independent of internal English protocol instructions.
An unsuccessful repair pauses the task instead of claiming completion.

## Game test scenarios

Undercover and Werewolf are automated acceptance scenarios for group coordination.
They are exercised by `scripts/group-scenarios.ts`; there is no game launcher,
player selector, or game panel in the group chat interface. The internal test
runtime retains game state, actions and controls for reproducible tests. It is started explicitly through `runtime.games.start` by the test script; there is no renderer game API and ordinary messages (including “来玩谁是卧底”) always use the configured group policy.

- Undercover: 4–8 players, one undercover, no blank card or word-guess comeback.
  Everyone describes in seat order, votes privately, and sees the results together.
  Ties get one defense/revote, followed by a persisted random draw if still tied.
  Eliminating the undercover wins for civilians; two survivors with the undercover
  still alive wins for the undercover.
- Werewolf: exactly six players, two wolves, one seer, three civilians. Night has
  private wolf discussion/votes and private seer inspection, then simultaneous
  resolution. Day has ordered speeches and voting. No wolves means good wins;
  wolves at least equal to surviving good players means wolves win.

The deterministic judge is separate from all players, so the group leader may
play. Player calls have no tools or reusable cross-game memory. Local CLI agents
cannot participate. A human's test view includes only their own identity,
authorized private messages, and current legal actions. Public @mentions cannot
steal a game slot. Scripted human input uses the runtime action API; human slots
wait indefinitely until submitted. Pause/resume/cancel remain available to tests.

Two completed but invalid model outputs for a slot cause a declared speech skip
or abstention. Three consecutive invalid slots, or three unsuccessful service
attempts for one slot, pause instead of fabricating a win. Human actions are never
automatically skipped. Repeated or stale action IDs cannot submit twice.

## Recovery and scope

Game state and public events commit in one SQLite transaction with revision checks.
The acceptance harness may explicitly recover running games from their saved slot, preserving roles,
votes and committed random choices. Paused test games use the harness resume API. Normal app startup does not resume test games. The desktop
must be running to make progress; there is no unattended server execution while
the app is closed.

Ordinary collaboration journals completed decisions/replies and replays those
results without invoking the model or tools again. An interrupted reply may have
already caused external effects, so it is paused for review. Changed membership
or externally changed leadership, or a task requiring image attachments, also
requires a fresh explicit instruction after restart. Policy-elected leadership is
recorded and accepted during journal replay. A healthy replacement leader is persisted during normal failover; recovered old leaders do
not automatically take ownership back.

The implementation intentionally targets one account, its own agents, and at most
one human player. This is not a distributed leader-election implementation. Local
game secrecy protects model/renderer views, not against an administrator reading
the local database.

Automated coverage includes deterministic seeded games, protocol/failure tests,
renderer interaction tests, and opt-in real OpenRouter scenarios. See
[validation](group-orchestration-validation.md) for measured results and limitations.
The latest [configuration-driven policy validation](group-policy-validation.md)
covers mode selection across election, dispatch and recovery.
The preceding [mixed-group health validation](group-health-validation.md) covers
local CLI members, cached probes, task ownership and failure replacement.

To run paid real-model QA on a configured macOS development install:

```sh
npx esbuild scripts/group-scenarios.ts --bundle --platform=node --format=esm --packages=external --outfile=out/group-scenarios.mjs
DOUCHAT_LIVE_SCENARIOS=1 DOUCHAT_GAME_TRIALS=5 node_modules/.bin/electron out/group-scenarios.mjs
```

The runner reads the development OpenRouter credential in memory, creates six
synthetic agents and fresh groups in a separate database, and writes reports/public
transcripts under `out/group-scenarios`. It uses the real runtime and provider.
`--games`, `--projects`, and `--probe` select narrower runs. Combine `--projects`
with `--humans-only` for the three human-checkpoint cases or `--jev-human` for just
that mode. QA databases and helper bundles are excluded from packaged builds. Human responses are
scripted through the same action/message APIs used by the UI; no real person is
contacted. It never modifies existing contacts or copies credentials into reports.

For mixed local CLI/cloud health and failure QA, bundle and run
`scripts/group-health-scenarios.ts` with the same `DOUCHAT_LIVE_SCENARIOS=1` opt-in.
It copies selected development contact configurations into an isolated database,
checks cold/cached attendance and injects a post-probe leader failure. It also
exercises a required deliverable after a stale OpenClaw health result. Existing
contacts and conversations are not modified.

Provider references: [Jev System One](https://openrouter.ai/docs/guides/community/typesafe-sdk),
[OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs).

This scheduler applies to desktop-local groups. Remote multi-account shared rooms
use the separate task-claim protocol described in `social-chat.md`.

For the configuration-driven policy matrix (default, ordinary LLM and Jev;
attendance/leader failure, explicit-task replacement and scripted human checkpoint):

```sh
npx esbuild scripts/group-policy-scenarios.ts --bundle --platform=node --format=esm --packages=external --outfile=out/group-policy-scenarios.mjs
NODE_USE_ENV_PROXY=1 DOUCHAT_LIVE_SCENARIOS=1 node_modules/.bin/electron out/group-policy-scenarios.mjs
```

Use `NODE_USE_ENV_PROXY=1` when this environment requires its configured HTTP proxy.
The reports record real provider calls separately from injected failures and
scripted human responses. Existing groups and saved model settings are unchanged.

### 2026-09-23：连续跳过与新一轮报数

- 协调请求失败与成员执行失败分别记录。JSON 规划失败只禁用该任务中的备用协调尝试，不把成员写成无法发言，也不从参与名单中删除。
- 生产调度不再使用报数／游戏专用协议。通用计划使用 `participationOnly` 和 `participantScope` 表示成员各自参与及参与范围。顺序任务给成员提供 `progress.completedContributions` 和当前成功结果的 `publicMessageIds`；执行器不生成数字或替模型作答。失败／缺席不推进进度，成员根据用户要求和真实前序结果继续。
- Jev 使用通用 `ordered` 分类处理无需准备的全员顺序参与；低置信度或复杂请求仍回退成员规划，没有按场景关键词绕过决策配置。
- 旧日志中的 `rollCall` 仅在读取时迁移：清除旧的预分配答案，转成全员参与范围；新提示词和 schema 不再输出此字段。
- 每个新请求的 requestMessageId/currentRequest 与历史记录分开，旧轮次不算当前任务的完成记录。
- 跳过通知不再承诺“其他成员继续”。个人参与轮结束时显示实际回复人数、跳过人数与成员名称；恢复日志不会重复该通知。

### 2026-09-23：规划等待与可见身份

- 健康探测显示群调度头像和“检查群成员状态”；外部模型决策显示供应商 / 模型名称；成员生成计划时显示实际联系人头像。规划、选负责人和故障处理分别标记，不再统一显示“正在协调群聊”。
- 默认使用云端决策模型，失败或需要复核后才使用成员规划。已保存的调度选择继续保留，也可手动选择成员规划。
- 成员规划按候选排序逐个尝试，同一时间只接受一名成员的计划。每名候选最多 40 秒（包括排队及一次格式纠正；成员会话每次请求最多 20 秒）；失败或超时自动切换下一位，不再限制为两名，也不再在 3 秒后并行启动备用请求。
- 切换前取消旧请求并丢弃迟到结果，规划请求禁用宿主工具。规划失败只取消该成员当前任务的规划资格，不直接认定其无法执行后续工作。切换时在聊天中显示居中系统提示。
- 整个成员规划阶段最多 120 秒；候选全部失败或总时间耗尽时明确暂停并显示原因。这个窗口不包括健康探测、配置模型请求或实际工作。用户主动停止会立即终止接力；失败接力同样适用于决策模型回退和执行故障后的重新规划。

### 2026-09-23：不可用成员跨任务隔离

- 执行失败在当前群内标记成员不可用，群详情显示“暂不可用”。普通任务计划不得分配给这些成员；默认和模型模式均受校验约束，不影响成员在其他群的独立状态。
- 明确要求个人参与的计划仍可保留缺席席位，但已缓存的不可用成员直接通报缺席，不调用成员、不重复请求故障决策。本轮新发生的失败仍由配置的决策服务处理。
- 健康和不可用状态按用户配置周期（默认 300 秒）缓存，在下一条任务到来且周期到期时复查；仅未知状态最早 30 秒复查。没有后台持续付费轮询。
- 只有成功的健康探测恢复不可用成员。超时、无结论和取消均不能证明恢复；配置变更会立即重新探测，但不会仅凭配置变化解除不可用状态。
- 派发通知只展示当前可用的执行成员；个人参与计划内部保留完整名单，用于逐人通报缺席。中途失败后按配置决策模式处理，顺序参与跳过故障成员，下一人依据已成功提交的结果继续，必需交付则可选择替补。

### 2026-09-23：语言与硬编码检查

调度设置和新系统通知接入中英文翻译；通知持久化模板与参数以支持切换语言。公开交付约束改为模型返回的结构化字段，能力辅助排序使用 Unicode 分词，配置式调度不再经过旧中英文静默关键词判断。详细修复、自动化覆盖与未覆盖范围见 [语言检查记录](group-language-audit.md)。

### 2026-09-24：默认云端决策与回复恢复

- 未保存调度配置时默认使用云端决策模型；保留已有明确配置。
- 澄清续接结合上一条问题和原始任务理解 yes、好等短回答，已回答的问题不重复追问；简单文本任务优先使用合理的上下文假设。
- 云端及自定义模型缺少必需的提问或公开交付物时，使用无工具请求补答一次；仍不满足要求时交由调度选择替补。已产生操作记录、附件或本地代理执行的结果继续保留原有保护，避免重复执行。
