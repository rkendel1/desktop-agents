# Foundry Environments: a client of Compute

Foundry's **Environment** surface makes Compute controllable and observable from inside Foundry, for the one thing a developer needs it for:

```text
Project → Environment → Computer → Bootstrap → Readiness → Workload
```

> Foundry's Environment UI is a client of Compute, not an alternative implementation of Compute.

| | Owns | Foundry's part |
| --- | --- | --- |
| **Foundry** | the developer experience: Project Home, the Environment section, the session UI, orchestration | Creates, shows and controls the project's environment *through Compute*; keeps one **reference** (project → Compute environment name and id) |
| **PAX** | project/tooling reality: what the project is, its package manager, drift | Consumed as before; nothing here changes it |
| **Compute** | execution reality: recipes and their versions/digests, resolution, placement, the Computer, bootstrap, readiness, lifecycle, workloads, errors | Asked every time; never copied, cached or second-guessed |
| **AppPort** | the service/control boundary | `douchat.environment.*` call the same `EnvironmentService` as the desktop |

**Foundry does not own Compute state.** The only thing it persists is `DevelopmentEnvironment` in `desktop.flow`: `id`, `workspaceId`, `environment`, `environmentId`, the requested `recipe` (a request, not provenance) and `createdAt`. A mechanical audit (`authority.test.ts › Compute authority`) fails the build if that collection gains a status, readiness, digest or error.

## 1. Audit

**Foundry.** The smallest existing boundary is `ComputeClient` (`src/main/compute/client.ts`): one documented Compute CLI call per method, through the no-shell command runner. It was extended; no second client exists. Project Home is `ProjectsView`; sessions are `CodingService`; persistence is FeltDB through `DesktopRepository`; AppPort is `CodingApi` + `appport/contract.ts`. Confirmation dialogs live in the main process (`index.ts`).

**Compute (main, `c389fcc`; `compute 0.1.5` — the version string does not distinguish it from the Homebrew release).** Read from `docs/recipes.md`, `bootstrap.md`, `readiness.md`, `lifecycle.md` and the code, then checked by running it:

| Need | Compute contract used |
| --- | --- |
| Recipes | `recipe list --json`; each version has `name`, `version`, `digest` |
| Resolution | `recipe resolve NAME [--version N] --json`: `verdict` (`satisfiable` / `unsatisfied` / `invalid`), `resolved.computer`, placement's per-target `reasons` |
| Create | `environment create NAME --recipe NAME@VERSION --json` (returns when recorded, not when ready) |
| Inspect | `environment inspect NAME --json`: `recipe` provenance, `computer.reality`, `computer.bootstrap`, `computer.readiness` (`state`, `class`, `conditions`, `unsatisfied`, `explanation`), `computer.failure` |
| Lifecycle | `environment start | stop | restart`, `environment reconcile` (retry), `environment destroy` (waits for the target's confirmation) |
| Workload | `environment exec` / process / agent verbs (as before); Compute refuses them unless the environment is `ready` or `degraded` |

Installed Compute Configured 0.1.5 has none of the recipe/bootstrap/readiness contract.

## 2. Version handling

`ComputeClient.environmentContract()` asks the installed binary whether it declares the contract (`recipe --help`, `environment create --help` has `--recipe`) and whether the daemon answers. If not:

> **Compute update required.** This version of Foundry requires Compute with Environment Recipes, Bootstrap, Readiness and lifecycle support. Installed: Compute Configured 0.1.5.

Nothing is emulated: no recipes, bootstrap or readiness are inferred for an older Compute, and workloads are refused.

## 3. States: Compute's words, translated

`src/main/environment/presentation.ts` is a table, not a state machine. Every output is a function of fields in one Compute answer.

| Foundry shows | Compute said |
| --- | --- |
| Creating | readiness `created`, or `starting` with bootstrap not running |
| Configuring | readiness `starting`, bootstrap `running` |
| **Ready** | **readiness `ready`** (and the Computer not stopped/ending) |
| Degraded | readiness `degraded` (Compute admits workloads) |
| Not ready | readiness `unavailable` (unreachable, lost, target no longer satisfies) |
| Failed | readiness `failed` |
| Stopping / Stopped / Destroying / Destroyed | the Computer's observed lifecycle |
| Unavailable | Compute has no such environment, or a different one under that name |
| Compute unavailable | not installed, daemon not answering, or too old for the contract |
| Unknown | anything else: **never treated as ready** |

`presentation.test.ts` enumerates every combination of Compute's statuses × lifecycles × readiness × bootstrap and asserts that `ready` is reachable only from `readiness.state === 'ready'`, and that no control is offered for an ended Computer.

Errors keep Compute's category (`requirements_unsatisfied`, `configuration_failed`, `provider_failed`, `runtime_failed`, `bootstrap_cancelled`, `destruction_failed`) beside a human sentence, and placement's reasons (`runtime_unavailable` …) are listed as Compute gave them.

## 4. What Foundry does

* **Recipe creation** — when Compute has no stored recipes, Foundry asks the owner to choose a Compute recipe JSON file and invokes `compute-configured recipe create NAME --file FILE` through `ComputeClient`. Foundry does not seed, parse or store it, and never treats a starter example as installed.
* **Create environment** — the person chooses a recipe Compute has; Compute resolves it (shown: requirements, target, satisfiable or not); Foundry writes the reference *before* asking Compute, then `environment create`; the view follows Compute (Creating → Configuring → Ready). An unsatisfiable recipe is never created.
* **Controls** — Restart, Stop, Start, Retry (`reconcile`), Destroy. An action waits (bounded) for Compute's confirmation and returns what Compute then says: a stop that Compute has not confirmed is *Stopping*. Destroy asks the owner in the main process and clears the reference only after Compute reports `destroyed`.
* **Workloads** — `EnvironmentService.admit` asks: is there a reference; can Compute be reached; does the environment exist; is it the referenced one (`environmentId`); does Compute say it admits workloads. Otherwise the session refuses with the reason: `Compute was selected, so nothing was started on this computer. …`. It is asked again before every turn. Compute also refuses on its side.
* **Recovery** — nothing is remembered but the reference. Reload, Foundry restart, Compute/controller restart, a lost environment, an interrupted create (the reference exists but Compute has no record → *Unavailable*, "creating it was interrupted"; Compute has it but Foundry lacks the id → adopted) all reduce to "read the reference, ask Compute".
* **Lost environments** are never silently replaced: *Unavailable — the Compute environment associated with this project no longer exists*, with *Create developer environment*.

## 5. UI

Project Home has an **Environment** section (state, recipe · version, Computer, configuration, readiness, controls, progress while creating, the reason on failure) and a compact **Work** list. *Open* shows an inspection detail read from `environment inspect` (recipe version and digest, Computer, Certified/Preview only when `compute-configured-verify` says so, configuration, readiness, lifecycle, workloads, created, last transition; conditions and machine under *Advanced*). The start form's *Environment* option runs on the project's environment; sessions show "Environment developer · Linux x86_64 · Ready". There is no provider, target, capacity, certification or policy administration here: those are Compute's.

## 6. Tests

| Layer | Where | Runs |
| --- | --- | --- |
| Translation | `presentation.test.ts` | always |
| Contract, one suite × two implementations | `environment.contract.test.ts`: the **contract fixture** (a `compute` command whose JSON is derived from recordings of real Compute main, `fixtures/compute-main/`) and **real Compute main** | fixture always; real when a build exists (`FOUNDRY_COMPUTE_MAIN`, `COMPUTE_MAIN_REPO`, or a checkout next to this one) |
| Failure semantics | `environment.fixture.test.ts` (failed bootstrap + retry, unmet requirements, lost, degraded, unknown state, placement failure, Compute 0.1.5, non-optimistic stop/destroy, daemon down) | always |
| AppPort | `environment.appport.test.ts` | both backends |
| Renderer | `EnvironmentPanel.test.tsx`, `ProjectHome.test.tsx`, `CodingSessionPanel.test.tsx` | always |
| Real dogfood | `environment.dogfood.test.ts` | real Compute main only |
| Architecture | `authority.test.ts › Compute authority` | always |

The dogfood test runs the whole flow on real Foundry and real Compute main: create → recipe resolves → Computer → bootstrap → Ready → a real agent process on the Computer runs the project's tests and edits a file → Stop (refused while stopped) → Start (readiness re-established) → workload again → Compute unavailable (refused, explicit) → Destroy. The only substitution is Compute's own documented `COMPUTE_RUNTIME_CATALOG` mechanism, which points the *shell runtime's artifact* at the host `/bin/sh` because this environment cannot download it.

### Evidence, stated plainly

* Executed on **Linux x86_64** against Compute main built from `rkendel1/compute` `c389fcc`. macOS was not run.
* **Homebrew Compute Configured 0.1.5 is intentionally unsupported** here (update-required). **Dogfood against a published Homebrew release with this contract is still owed** before shipping.
* The real-Compute tests of the older coding-session suite (`compute.test.ts`) need PAX and `compute-configured`; neither is installed here, so they were adapted (they register the project's environment and wait for readiness) but not run.

## 7. Findings about Compute (not changed here)

* On a host that cannot fetch the shell runtime, an environment stays `starting`/`provisioning` while `computer.failure` records `placement / target_incompatible … runtime_unavailable` (retryable). Foundry shows *Creating* (Compute's readiness) with the failure as the reason.
* Declaring new contents (a repository, an agent) returns the environment to `starting` for a moment, and `environment exec` is refused ("is starting, not ready for workloads") until Compute re-verifies. `ComputeClient.exec` waits (bounded, 60 s) for *that* refusal only and then asks again; any other refusal is final.
* `environment stop` / `restart` answer with the pre-action view; the outcome must be read back.
* Destroyed environments keep their record (and name), so Foundry names every environment uniquely.
* The stock `dev` recipe asks for `terminal`, which the `this-machine` target does not offer: correctly `unsatisfied` here.

## 8. Not done

Provider/target administration, capacity, inventory, certification, publishing, policy (Compute's); package management, secrets, source-checkout redesign, migration, CI redesign, deployment, scheduling, Compute API changes.
