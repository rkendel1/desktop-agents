# Jev structured decisioning

Jev is Foundry's constrained structured-decision capability. It is not an autonomous agent, a chat interface, or an authority over the systems it evaluates.

The invariant is:

> Jev does not discover reality. Jev evaluates structured representations of reality.

A caller—an agent, PAX integration, or another Foundry service—collects facts and supplies a `JevQuestion`. Jev validates the question, evaluates deterministic rules in code, sends only explicitly semantic rules to the local structured-decision runtime, validates that typed result, persists the Evidence/Evaluation/Decision records through `DesktopRepository`, and returns a `JevResult`.

Jev cannot read files, inspect Git, run commands, browse, contact accounts, invoke another agent, or mutate source. Those capabilities are deliberately absent from `JevService` and are enforced by `authority.test.ts`.

## Contract

```ts
type JevQuestion = {
  id: string
  subject: { kind: string; id?: string }
  question: string
  inputs: Array<{ id: string; name: string; value: JsonValue }>
  rules: Array<{ id: string; expression: string }>
  requestedDecision: 'pass-fail-review'
}
```

The supported deterministic rule grammar is intentionally small:

- `exists(input)`
- `equals(input, value)` or `equals(input, otherInput)`
- `contains(input, value)`
- `notEmpty(input)`
- `exactlyOne(input)`

`semantic(input, "criterion")` is the only model-requiring rule. It runs only when that input is present and known. Unknown or conflicting evidence is never sent to the model as an invitation to guess.

Questions fail closed on missing fields, extra schema fields, invalid JSON values, duplicate identifiers, unknown functions, malformed expressions, unsupported decision kinds, excessive sizes, or unvalidated model output. Validation errors use `JEV_QUESTION_INVALID`; runtime failures become structured uncertainty such as `MODEL_UNAVAILABLE`, `MODEL_TIMEOUT`, `MODEL_CANCELLED`, `MODEL_FAILURE`, or `MODEL_OUTPUT_INVALID`.

## Results and evidence safety

A result contains the decision, one result per rule, each input's relevant rule IDs, uncertainty, timing, and provenance. Provenance binds the answer to the Jev version, runtime, runtime version, model, artifact hash, question, source agent/session/project/invariant, and timestamp.

- Any deterministic false rule produces `FAIL`.
- Missing or unknown required evidence produces `UNKNOWN`.
- Explicitly conflicting evidence produces `REVIEW`.
- All true rules produce `PASS`.
- A model response cannot add evidence. It can only return typed results for the exact semantic rule IDs Jev requested.

For example, this never becomes a model conversation:

```ts
{
  id: 'tests',
  subject: { kind: 'implementation', id: 'change-42' },
  question: 'Did the supplied checks pass?',
  inputs: [{ id: 'tests', name: 'testsPassed', value: { status: 'unknown' } }],
  rules: [{ id: 'checks', expression: 'equals(testsPassed, true)' }],
  requestedDecision: 'pass-fail-review'
}
// => UNKNOWN
```

Conflicting evidence is explicit:

```ts
{ id: 'git', name: 'gitStatus', value: { status: 'conflicting', values: ['clean', 'dirty'] } }
// => REVIEW
```

An unsupported `browse(repository)` rule is rejected as invalid input; Jev does not reinterpret it.

## Architecture invariants

The invariant defines the rule; the caller supplies observations:

```ts
const invariant = {
  id: 'single-durable-authority',
  subject: { kind: 'architecture', id: 'foundry' },
  question: 'Is there exactly one durable application-state authority?',
  rules: [{ id: 'single-store', expression: 'exactlyOne(durableStores)' }]
}

const question = architectureInvariantQuestion(invariant, [
  { id: 'stores', name: 'durableStores', value: ['FeltDB'] }
])
// => PASS
```

`['FeltDB', 'SQLite']` fails. `{ status: 'unknown' }` is unknown. Jev never scans the repository to populate the list.

## PAX and agents

`paxEvidence(run)` projects PAX's already-authoritative response into Jev inputs. PAX still owns project tooling detection, planning, native command delegation, drift, and reality. It does not transfer those responsibilities to Jev.

Hosted Foundry agents receive `evaluate_structured_evidence`. The tool accepts only a complete `JevQuestion`; it has no discovery or mutation operations. The calling agent gathers evidence, calls Jev, and decides what to do next. The same service boundary can be used by ChatGPT or other future agents without making Jev impersonate a general reasoning agent.

An implementation review can therefore combine explicit inputs such as `checksPassed`, `changedFiles`, and `requirementsMet` with deterministic and semantic rules. If `checksPassed` is absent, Jev reports `UNKNOWN` instead of claiming success.

## Local model execution

`RustStructuredDecisionModel` implements the only model boundary:

```ts
interface StructuredDecisionModel {
  evaluate(question: JevQuestion, signal: AbortSignal): Promise<unknown>
}
```

It uses the public `@rust-ml-runtime/node` package in process. The runtime chooses its backend from verified model capabilities; on macOS ARM64 the installed Laya package can use Core ML. Foundry does not implement backend policy, spawn a CLI, use Python, add Ollama, or call a remote API. The adapter uses `LocalML.decideAsync`, a `DecisionCancellation`, typed `noul` decisions, confidence-based uncertainty, and the runtime's model/backend/artifact provenance.

Install and verify the model with the runtime's own tooling before semantic evaluation:

```sh
ml-runtime model install laya
ml-runtime model doctor laya
```

Deterministic questions do not load the native runtime or model at all. A missing or invalid local model affects only semantic rules and returns `UNKNOWN / MODEL_UNAVAILABLE`.

## Persistence and inspection

FeltDB remains the only durable authority. `DesktopRepository.saveJevEvaluation` atomically writes the existing domain concepts `Evidence`, `Evaluation`, and `Decision` in the shared `desktop.flow`. There is no Jev database, JSON file, SQLite file, in-memory result cache, event bus, or hidden model store. `jevEvaluation(id)` and `jevEvaluations(projectId)` return the inspectable question, evidence references, decision, uncertainty, metrics, and provenance after restart.

The source system remains authoritative: Git/filesystem for source, PAX for project-tooling facts, Compute for Computers, and FeltDB for Foundry application/session/evaluation state. A persisted Jev result is an evaluation of supplied evidence, not a replacement for that evidence's authority.

## Repository dogfood

`jevDogfood.test.ts` constructs evidence from the real Foundry package manifest, production imports, `desktop.flow`, and `authority.test.ts`. It evaluates the single-durable-authority invariant with six deterministic rules. The checked run on 2026-09-30 passed with no model inference.

The native Node runtime also loaded successfully on `darwin-arm64`. The machine's existing Laya installation failed the runtime's integrity check because its registered `platforms` metadata was missing or incorrect. No model output was accepted, and semantic evaluation correctly fails closed as `MODEL_UNAVAILABLE`. Reinstalling that external model with the runtime CLI is an operator action, not a hidden Foundry fallback.
