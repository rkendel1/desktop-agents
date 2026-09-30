# The Foundry model fabric

> Use the best AI currently available to me, automatically. And with the default policy: keep it free — never spend money without my permission.

Foundry's model fabric sits underneath the existing inference path. It discovers which models the connected providers offer *now*, works out from evidence why each may or may not be used, and — when automatic selection is on — picks the best eligible one for each request, moving on to the next when a model reaches its limit.

```text
                    Foundry agent turn
                          │
                    Model Router          ← policy · capability · availability · observed results
              ┌───────────┼───────────┐
          Registry     Health      Quotas          (registry: settings · health: this process)
              └───────────┼───────────┘
                    Candidate pool
              ┌───────────┼───────────┐
          Provider A  Provider B  Provider C       (adapters over Foundry's existing providers)
```

Nothing in the router names a provider or a model. Which models exist is whatever discovery finds today.

## What is in this PR

| Piece | Where |
| --- | --- |
| Vocabulary: `ModelCandidate`, `ModelAccess`, `PricingClass`, `ModelCapabilities`, `ModelRequirements`, `ModelPolicy`, `ModelBudget`, `ModelDecision`, `RetryReason` … | `src/shared/modelFabric.ts` |
| Access classification and the cost gate | `src/main/models/access.ts` |
| Health ledger: cooldown, exponential backoff, latency percentiles, counts | `src/main/models/health.ts` |
| Router: `planRoute` (stages 1–7), error classification, invocation guard, cycling | `src/main/models/router.ts` |
| Fabric service: discovery, registry, policy, `route`, `complete`, `status` | `src/main/models/fabric.ts` |
| Provider contract (`discover` / `health` / `invoke`) | `src/main/models/provider.ts` |
| Adapters over the existing custom providers (OpenAI-compatible, Anthropic-compatible, Ollama) | `src/main/models/adapters.ts` |
| Streaming bridge: cycles before any output, passes through after | `src/main/models/stream.ts` |
| Settings-backed persistence | `src/main/models/store.ts` |
| CLI (`Foundry model …`) | `src/main/models/cli.ts` |
| Runtime hook (the Agent's `streamFn`) and the Activity note | `src/main/runtime.ts` (`modelCall`) |
| Models screen | `src/renderer/src/components/ModelFabricPanel.tsx` (Settings → Models) |

## Access: why a model is eligible

`ModelAccess` is `local | free | beta | trial | user-authorized | paid | unknown`. It is *derived*:

```text
where it runs  +  what the provider's catalog says it costs  +  what the person explicitly configured   →  ModelAccess
```

* **Local** is only Ollama's own service (not its `-cloud` models). A loopback address is *not* evidence: an OpenAI-compatible server on localhost is often a gateway to paid providers, so it is classified from its catalog like any other.
* **Catalog pricing**: an OpenAI-compatible `/models` entry is `free` only if every price it states is zero; a missing or unparseable price is `unknown`, never free. Modalities and supported parameters give the capabilities; `coding` is *inferred* (tool use, reasoning, or a coder's name) because no catalog states it.
* **Explicit entry**: where a provider has no catalog (or does not price), the person can say what they know in **Settings → Models → Pricing** (`free`, `beta-free`, `trial`). A configuration never overrides a catalog that says *paid*.
* No evidence at all is `unknown`.

`PricingClass` (`free | beta-free | trial | paid | unknown`) is what discovery learned; routing uses `ModelAccess`.

## The cost invariant

Under **free-only**, only `local`, `free`, `beta` and `trial` candidates whose classification is still fresh are eligible. `paid`, `user-authorized`, `unknown`, disabled and **stale** candidates are not. Every entry has `observedAt`/`expiresAt` (default 6 h): after expiry a free classification is not assumed to still hold, and the model is rediscovered, not trusted.

The invariant is enforced twice, by the same function (`budgetRejection`):

1. **Planning** removes forbidden candidates (stage 1).
2. **`guardInvocation`** re-runs the policy on the candidate in hand immediately before `invoke`, and throws `CostPolicyViolation` — nothing is sent — if it fails. It does not trust the plan.

Tests prove it with a fake paid provider that fails the test if it is ever invoked, through discovery, routing, cycling and exhaustion, and end to end against a real HTTP server whose paid endpoint answers "PAID MODEL WAS CALLED". Anything the router does not understand (an unknown budget) fails closed; the persisted budget can only be `free-only` (a stored `unrestricted` is ignored on load, and the setter cannot change it). `unrestricted` exists in the router contract only so the future budgets have a place; no UI or setting offers it.

**"Free" is not "unlimited".** The UI says: *Free under each provider's current free/beta access terms.* Foundry does not measure spend; it guarantees that no candidate that isn't classified zero-cost ever reaches a provider.

## Routing (`planRoute`)

Deterministic for the same candidates, request, policy and ledger signals (ties end at the model id).

1. **Policy** — remove paid, unknown, user-authorized, stale, disabled (and beta if beta is off).
2. **Capability** — coding, reasoning, vision, tools, structured output, context. A model that does not state its context window is not assumed to have enough.
3. **Availability** — provider-reported quota exhausted / unavailable / not connected.
4. **Health** — cooldown or unavailable in the ledger.
5. **Quality history** — smoothed observed success, plus tool-call and structured-output success when the request needs them.
6. **Task affinity** — success on this class of task (first sort key).
7. **Latency** — tie-breaker only (50 ms buckets), then id.

Every request produces a `ModelDecision`: request id, task class, requirements, policy, candidates considered, every rejection with its stage and reason, the ranking, every attempt (outcome, latency, retry reason), the selection time and the outcome.

## Cycling

A failure moves the request to the next eligible model **only** if it is transient (`RetryReason`: `rate-limited`, `capacity-unavailable`, `timeout`, `temporary-provider-error`). Authentication, invalid requests, policy violations (402), unsupported capability (context too long) and malformed tool calls are final — unless the provider's adapter says the error is transient. The failed model enters **cooldown** (30 s for rate limits/capacity, 15 s for timeouts/5xx, doubling per consecutive failure up to 15 min, honouring `retry-after`); five consecutive failures make it `unavailable`; a success clears it. A credential failure pauses the model for 10 minutes instead of retrying it.

For streams (`stream.ts`), events are held until the model produces its first content: a rate limit, timeout or capacity failure *before any output* cycles to the next model and the caller sees one uninterrupted stream. Once output has started it is passed through, and a later failure is reported as it happened — output cannot be unsaid.

When nothing eligible is left, the request fails with: *Foundry couldn't complete this request. All currently available free models are unavailable or rate limited. No paid model was used. Try again shortly.* — it never widens the policy.

## State

| | Where | Note |
| --- | --- | --- |
| Policy (`automatic`, `failover`, `useBeta`; budget is always free-only) and disabled-model list | Foundry settings (`Setting: modelFabric`) | The existing mechanism; no new collection |
| Last discovery (candidates, freshness, provider errors) | the same setting | No credentials — the audit checks the types and code have no key field |
| Provider credentials | the OS credential vault, via Settings → Models | Unchanged; adapters receive them in memory |
| Health, counters, cooldowns, recent decisions | a `HealthLedger`/`ModelFabric` instance the app owns | Operational, not authority; lost on quit. Injected, never a global |

`authority.test.ts › Model fabric authority` fails the build if the fabric gains a database, cache, module-level state, a vendor/model name in its routing code, a credential field, or a provider call outside the guarded path.

## UI

**Settings → Models** shows: Free AI, cost `$0.00` (free only — a paid model can never be called), available models and providers, the current model and *why*, automatic selection / free-only (locked on) / fail over / use beta switches, *View available models* (with status: Ready, Cooling down, Unavailable, Not free…), a per-model detail (capabilities, context, access and its basis, and **Foundry observed** latency/success/requests, labelled as not vendor claims; *Use automatically*), providers (connected or not — keys are managed under Custom models), and recent decisions. A model switch is a note in the run's **Activity** ("Model switched — Model X reached its current limit. Foundry continued with Model Y. No action required. Cost policy: Free only") and never an interruption; only a request that cannot continue is worded as a problem.

## CLI

`Foundry model` runs the app headless (no window) against the same data and settings:

```text
Foundry model                      the policy, pool, current pick, fallbacks, cost
Foundry model list [--free]        the pool (--free: free, beta, trial and local models)
Foundry model discover             ask the connected providers what they offer now
Foundry model status               counts, current and fallbacks
Foundry model current              as `model`
Foundry model test                 send a one-line request through the router and print the decision
                --json             machine-readable
```

If Foundry is already running it owns the data; the command says so and exits (use the Models screen).

## Compatibility

Automatic selection is **off by default**. With it off, every agent uses its own model exactly as before (tested: even a paid one). With it on, custom-provider agents route through the fabric; agents backed by a local CLI, and the built-in cloud models, are unaffected. Turning it off returns agents to their own model on the very next call.

## Evidence and limits, stated plainly

* Tested: unit (policy, capability, quota/cooldown, cycling, error classification, ranking, determinism), integration with fake providers (A 429 → B timeout → C success; paid never called; all-exhausted → clean failure), an HTTP server speaking the OpenAI-compatible protocol (catalog discovery, streaming, cycling), the Agent's own `streamFn` through the runtime, the CLI, the Models screen, and the architecture audit.
* **No live free-tier provider was called.** The sandbox has no provider keys and the tests never use a real one; behaviour against a real provider's catalog rests on the documented `/models` shape (OpenRouter-style pricing, `supported_parameters`, `architecture.input_modalities`).
* `coding` capability is inferred, not stated by any catalog. Discovered catalog models have `toolUse` only if the catalog says so.
* Only the custom providers (Settings → Models) are adapters. The built-in cloud catalog (whose prices Foundry does not treat as evidence, because unset prices read as zero) is not in the pool.
* Budgets other than free-only (`Up to $1/month`, …) are not implemented.
* Health is per app run; nothing learned survives a restart except the registry.
* `Foundry model` needs the app not to be running; it was exercised through `runModelCli`, not by launching Electron.
