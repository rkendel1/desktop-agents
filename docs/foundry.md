# Foundry

**Foundry is the developer workbench where agents build software.** You give an agent software work in a project,
and you inspect and control what it does: the approvals it asks for, the files it changes, the checks it runs, the
history of the session and its result. It is not a chat application — conversations still exist underneath (an
agent's coding session runs on one, and the agents can talk to each other), but the thing you work with is a
*project*, a *coding session*, a *task*, an *approval*, a *run* and a *result*.

## What Foundry is, and what it works with

```text
Foundry        developer workbench / control surface
AppPort        capability protocol
@appport/github  GitHub capability
FeltDB         durable state authority
PAX            portable execution/environment contract
Compute        portable execution fabric
AuthBoundry    authority boundary when authority/agency is required
```

| | Role | In Foundry today |
| --- | --- | --- |
| **Foundry** | The workbench: projects, coding sessions, approvals, changed files, checks, history. | This application. |
| **AppPort** | The capability protocol. Foundry's coding surface is exposed as an AppPort capability that calls the same `CodingService` the desktop uses. | Implemented ([appport-coding.md](appport-coding.md)). |
| **`@appport/github`** | The GitHub capability: repository metadata, and later branches, issues and pull requests. Foundry has no GitHub code of its own for these. | Consumed for repository metadata. |
| **FeltDB** | The durable authority for application and session state, in one shared `.flow` that Foundry, AppPort Services and `@appport/github` each own collections in. Git and the filesystem own source state; OS processes are ephemeral. | Implemented ([feltdb-architecture.md](feltdb-architecture.md)). |
| **PAX** | The portable execution / environment contract: what a project is and what its own tools run. | Consumed for coding sessions on Compute ([compute-integration.md](compute-integration.md)). |
| **Compute** | The portable execution fabric: where an agent's process can run other than this computer. | Consumed: a coding session can run on a Computer from the installed Compute Configured ([compute-integration.md](compute-integration.md)). |
| **AuthBoundry** | The authority boundary, when authority or agency is required. | **Not required by Foundry.** It runs locally with a stand-in owner authority; a real AuthBoundry replaces that stand-in when a deployment needs one. |

Foundry does not require AuthBoundry, PAX or Compute to work: a session runs locally unless Compute is chosen, and
then it never falls back to running locally.

## The workbench

Foundry is the developer workbench where agents build software. The daily loop — project home, start coding, approvals, activity, changed
files and diffs, checks, Continue, Git, history — and the authority behind each part are described in [workbench.md](workbench.md).

## Where the old name still appears

Foundry was previously named Douchat. The rename is of the product a person sees; identifiers that would need a
data migration or that are part of a technical contract keep their original spelling, and each one is listed in
[foundry-identifiers.md](foundry-identifiers.md).
