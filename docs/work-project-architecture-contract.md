# Work → Project architecture contract

This is the concise ownership contract for Foundry Work. The source-grounded inventory and
exceptions are in [the 2026-10-01 audit](audit-2026-10-01-work-project-single-path.md).

```text
UI / AppPort
  → CodingService
  → isolated CodingSession
  → CodingRuntime
  → common TaskRun / ChatMessage / command result
  → CodingService
  → DesktopRepository
  → Project
```

- `CodingService` (`src/main/coding/service.ts`) owns the Work lifecycle: validation, start,
  continue, cancel, execution coordination, result/evidence/events, and the immutable Project
  association. It is the canonical durable Work mutation boundary.
- `CodingRuntime` executes and streams provider work. It produces the common runtime records;
  it does not persist `CodingSession` or Project state.
- `DesktopRepository` persists durable FeltDB state and enforces persistence invariants. It does
  not choose providers, decide Compute behavior, or orchestrate Work.
- Providers execute and return through the runtime. They do not know how Project Work is stored.
- Compute provides environments and process execution. It has no Foundry Work model and cannot
  create, retarget, or update Project Work.
- The renderer displays Work, collects intent, and invokes desktop IPC. AppPort invokes the same
  `CodingService` through `CodingApi`. Neither persists Work directly.

The four durable Work operations—`createCodingSession`, `resumeCodingSession`,
`updateCodingSession`, and `addCodingEvent`—are production-called only by `CodingService`.
`recoverInterruptedCodingSessions` is the sole intentional direct lifecycle exception: at
startup it changes existing `running` sessions to `interrupted`; it creates no Work, attaches no
provider result, and preserves Project identity.

Source authority and durable state authority are deliberately different:

- Filesystem/Git is authoritative for source. Edits happen during execution in the pinned local
  folder or Compute checkout and are accounted for through Git.
- FeltDB through `DesktopRepository` is authoritative for durable Work and Project state.

Foundry is not a patch-application system. Provider-specific execution may differ, but every
durable Work result converges at `CodingService`. `src/main/authority.test.ts` enumerates the
production callers and rejects new provider, runtime, Compute, or renderer bypasses.
