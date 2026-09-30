import { AppPortError } from '@appport/protocol'
import { defineCapability, defineEvent, type AnyCapability, type AnyEvent } from '@appport/core'
import { s } from '@appport/schema'
import { PRODUCT_NAME } from '../../shared/brand'
import { PAX_INSPECTIONS } from '../compute/pax'
import { CODING_EVENT_NAMES } from '../../shared/codingApi'
import { CodingApiError, type CodingApi } from '../coding/api'

/**
 * Foundry's coding capability surface.
 *
 * A contract, not a database proxy: every operation is a thing a person does in the Projects
 * screen — look at projects, start / continue / cancel a coding session, read where it stands, and
 * answer the approval it is waiting for. There is deliberately no operation that reads or writes a
 * file, runs a command, or changes a session's folder: the client controls a coding session, not
 * the machine.
 */
/** `id` is the contract's identity and stays as published; `name` is the product. */
export const APPLICATION = { id: 'ai.douchat.desktop', name: PRODUCT_NAME, version: '1.0.0' } as const

/** Permissions, one per kind of authority. Holding one does not imply another. */
export const PERMISSIONS = {
  projectsRead: 'douchat.projects.read',
  projectsWrite: 'douchat.projects.write',
  codingRead: 'douchat.coding.read',
  codingControl: 'douchat.coding.control',
  approvalsRead: 'douchat.approvals.read',
  approvalsResolve: 'douchat.approvals.resolve'
} as const
export const ALL_PERMISSIONS: readonly string[] = Object.values(PERMISSIONS)

const project = s.object({
  id: s.string(), name: s.string(), path: s.string(), isGit: s.boolean(), checkCommand: s.optional(s.array(s.string()))
})
const change = s.object({ path: s.string(), code: s.string(), from: s.optional(s.string()) })
const gitState = s.object({ projectId: s.string(), branch: s.optional(s.string()), head: s.optional(s.string()), changes: s.array(change) })
const origin = s.enum(['agent', 'douchat', 'unknown'] as const)
const approval = s.object({
  id: s.string(), sessionId: s.string(), projectId: s.string(), projectName: s.string(), agentId: s.string(), agentName: s.string(),
  workingDirectory: s.string(), action: s.object({ verb: s.string(), target: s.string() }), requestedAt: s.number()
})
const ciOperation = s.object({
  operation: s.string(), kind: s.enum(['prepare', 'check'] as const), tool: s.optional(s.string()), command: s.array(s.string()),
  status: s.enum(['passed', 'failed', 'cancelled', 'timed-out', 'interrupted'] as const), exitCode: s.nullable(s.number()), startedAt: s.number(), durationMs: s.number(),
  stdout: s.string(), stderr: s.string(), truncated: s.boolean()
})
const ciSource = s.object({ repository: s.string(), revision: s.string(), branch: s.optional(s.string()), workspaceSource: s.enum(['committed-revision'] as const) })
const ciPlatform = s.object({ platform: s.string(), status: s.enum(['certified', 'preview', 'unverified'] as const), label: s.string(), computeVersion: s.optional(s.string()), evidence: s.string() })
const ciPlanBody = s.object({
  operations: s.array(s.object({ operation: s.string(), supported: s.boolean(), tool: s.optional(s.string()), command: s.optional(s.array(s.string())), selectionReason: s.optional(s.string()), evidence: s.optional(s.array(s.string())), reason: s.optional(s.string()) })),
  tool: s.optional(s.string()), ambiguous: s.boolean(), drift: s.boolean(), note: s.optional(s.string())
})
const ciRun = s.object({
  id: s.string(), projectId: s.string(), number: s.number(),
  status: s.enum(['running', 'passed', 'failed', 'cancelled', 'interrupted', 'blocked'] as const),
  phase: s.enum(['planning', 'acquiring', 'preparing', 'executing', 'capturing', 'releasing', 'done'] as const),
  createdAt: s.number(), startedAt: s.optional(s.number()), finishedAt: s.optional(s.number()),
  source: ciSource, platform: s.optional(ciPlatform),
  computer: s.optional(s.object({ environment: s.string(), environmentId: s.optional(s.string()), target: s.optional(s.string()), lifecycle: s.enum(['ephemeral'] as const), ttlSeconds: s.number(), repository: s.optional(s.string()), released: s.boolean(), releasedAt: s.optional(s.number()), releaseNote: s.optional(s.string()) })),
  plan: s.optional(ciPlanBody), operations: s.array(ciOperation),
  failure: s.optional(s.object({ kind: s.enum(['operation', 'timeout', 'plan', 'ambiguous', 'drift', 'source', 'compute', 'interrupted', 'cancelled'] as const), message: s.string(), operation: s.optional(s.string()) })),
  events: s.array(s.object({ at: s.number(), label: s.string(), detail: s.optional(s.string()) }))
})
const ciPlan = s.object({
  projectId: s.string(), projectName: s.string(), ready: s.boolean(), blockers: s.array(s.string()), source: s.optional(ciSource), platform: s.optional(ciPlatform), plan: s.optional(ciPlanBody),
  computer: s.object({ lifecycle: s.enum(['ephemeral'] as const) })
})
const session = s.object({
  id: s.string(),
  project: s.object({ id: s.string(), name: s.string(), path: s.string(), isGit: s.boolean(), branch: s.optional(s.string()) }),
  agent: s.object({ id: s.string(), name: s.string() }),
  task: s.string(),
  status: s.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const),
  workingDirectory: s.string(),
  createdAt: s.number(), startedAt: s.optional(s.number()), finishedAt: s.optional(s.number()),
  result: s.optional(s.string()), error: s.optional(s.string()),
  activity: s.optional(s.object({ label: s.string(), origin, since: s.number() })),
  pendingApproval: s.optional(approval),
  execution: s.optional(s.object({ kind: s.enum(['local', 'compute'] as const), environment: s.optional(s.string()), repository: s.optional(s.string()) })),
  changedFiles: s.array(s.object({ path: s.string(), code: s.string(), from: s.optional(s.string()), origin: s.optional(s.enum(['before', 'session'] as const)) })),
  cleanedFiles: s.array(s.string()),
  headAtStart: s.optional(s.string()), headAtEnd: s.optional(s.string()),
  checks: s.array(s.object({
    argv: s.array(s.string()), exitCode: s.nullable(s.number()), signal: s.optional(s.string()), cancelled: s.optional(s.boolean()), timedOut: s.optional(s.boolean()),
    startedAt: s.number(), durationMs: s.number(), output: s.string()
  })),
  history: s.array(s.object({ at: s.number(), kind: s.string(), label: s.string(), detail: s.optional(s.string()) }))
})

/** A refusal from the coding service becomes the protocol's own error code, so clients can tell what to do next. */
async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try { return await work() } catch (error) {
    if (error instanceof CodingApiError) throw new AppPortError(error.code === 'not-found' ? 'NOT_FOUND' : error.code === 'conflict' ? 'CONFLICT' : 'INVALID_INPUT', error.message)
    throw error
  }
}

export interface RemoteLookup { (projectId: string): Promise<{ projectId: string; local: { path: string; remoteUrl?: string }; github?: { owner: string; repository: string; fullName: string; defaultBranch?: string; private: boolean; archived: boolean; url?: string } }> }

export function codingCapabilities(api: CodingApi, remote?: RemoteLookup): AnyCapability[] {
  const idInput = s.object({ id: s.string() })
  return [
    defineCapability({ name: 'douchat.projects.list', version: 1, description: 'The projects (folders agents may work in).', effect: 'observation', authorization: [PERMISSIONS.projectsRead],
      input: s.empty(), output: s.object({ projects: s.array(project) }), handler: () => mapped(async () => ({ projects: await api.listProjects() })) }),
    defineCapability({ name: 'douchat.projects.get', version: 1, description: 'One project.', effect: 'observation', authorization: [PERMISSIONS.projectsRead],
      input: idInput, output: project, handler: input => mapped(() => api.getProject(input.id)) }),
    defineCapability({ name: 'douchat.projects.gitstate', version: 1, description: 'The project’s branch, commit and changed files, read from Git now.', effect: 'observation', authorization: [PERMISSIONS.projectsRead],
      input: idInput, output: gitState, handler: input => mapped(() => api.gitState(input.id)) }),
    ...(remote ? [defineCapability({ name: 'douchat.projects.remote', version: 1, description: 'The project’s remote repository: its origin URL from Git, and its metadata from the @appport/github capability.', effect: 'observation', authorization: [PERMISSIONS.projectsRead],
      input: idInput, output: s.object({
        projectId: s.string(), local: s.object({ path: s.string(), remoteUrl: s.optional(s.string()) }),
        github: s.optional(s.object({ owner: s.string(), repository: s.string(), fullName: s.string(), defaultBranch: s.optional(s.string()), private: s.boolean(), archived: s.boolean(), url: s.optional(s.string()) }))
      }), handler: input => mapped(() => remote(input.id)) })] : []),
    defineCapability({ name: 'douchat.projects.add', version: 1, description: 'Register a folder on the machine running Foundry as a project. The folder must pass the same checks as adding it in the app.', effect: 'consequential', authorization: [PERMISSIONS.projectsWrite],
      input: s.object({ path: s.string({ minLength: 1, maxLength: 4096 }), name: s.optional(s.string({ maxLength: 200 })) }), output: project, handler: input => mapped(() => api.addProject(input.path, input.name)) }),

    defineCapability({ name: 'douchat.coding.agents.list', version: 1, description: 'The agents a coding session can be started with (id and name only).', effect: 'observation', authorization: [PERMISSIONS.codingRead],
      input: s.empty(), output: s.object({ agents: s.array(s.object({ id: s.string(), name: s.string(), local: s.boolean() })) }), handler: () => mapped(async () => ({ agents: await api.listAgents() })) }),
    defineCapability({ name: 'douchat.coding.sessions.list', version: 1, description: 'Coding sessions, newest first.', effect: 'observation', authorization: [PERMISSIONS.codingRead],
      input: s.object({ projectId: s.optional(s.string()), status: s.optional(s.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const)) }),
      output: s.object({ sessions: s.array(session) }), handler: input => mapped(async () => ({ sessions: await api.listSessions(input) })) }),
    defineCapability({ name: 'douchat.coding.sessions.get', version: 1, description: 'One coding session: state, task, agent, changes, checks and history. Reconnecting reads this; it never starts anything.', effect: 'observation', authorization: [PERMISSIONS.codingRead],
      input: idInput, output: session, handler: input => mapped(() => api.getSession(input.id)) }),
    defineCapability({ name: 'douchat.coding.sessions.start', version: 1, description: 'Start an agent on a project. Returns as soon as the session exists.', effect: 'consequential', authorization: [PERMISSIONS.codingControl],
      input: s.object({ projectId: s.string(), agentId: s.string(), task: s.string({ minLength: 1, maxLength: 20000 }), execution: s.optional(s.object({ kind: s.enum(['local', 'compute'] as const), environment: s.optional(s.string()) })) }), output: session, handler: input => mapped(() => api.startSession(input)) }),
    defineCapability({ name: 'douchat.coding.sessions.continue', version: 1, description: 'Another turn in a finished or interrupted session. A new agent process starts; the old one is never resumed.', effect: 'consequential', authorization: [PERMISSIONS.codingControl],
      input: s.object({ id: s.string(), text: s.optional(s.string({ maxLength: 20000 })) }), output: session, handler: input => mapped(() => api.continueSession(input.id, input.text)) }),
    defineCapability({ name: 'douchat.coding.sessions.cancel', version: 1, description: 'Stop a running session. This is the only way a client ends one; disconnecting does not.', effect: 'consequential', authorization: [PERMISSIONS.codingControl],
      input: idInput, output: session, handler: input => mapped(() => api.cancelSession(input.id)) }),

    defineCapability({ name: 'douchat.coding.compute.inventory', version: 1, description: 'What Compute reports: the installed product’s platform (Certified or Preview, as Compute states it) and the Computers a session can run on. Read from Compute each time.', effect: 'observation', authorization: [PERMISSIONS.codingRead],
      input: s.empty(), output: s.object({
        available: s.boolean(), reason: s.optional(s.string()), uiUrl: s.optional(s.string()),
        installation: s.optional(s.object({ binary: s.string(), version: s.string(), configured: s.boolean() })),
        platform: s.optional(s.object({ platform: s.string(), status: s.enum(['certified', 'preview', 'unverified'] as const), label: s.string(), computeVersion: s.optional(s.string()), evidence: s.string() })),
        daemon: s.object({ endpoint: s.string(), reachable: s.boolean() }),
        environments: s.array(s.object({ name: s.string(), environmentId: s.string(), observed: s.string(), explanation: s.optional(s.string()), target: s.optional(s.string()) }))
      }), handler: () => mapped(() => api.computeInventory()) }),
    defineCapability({ name: 'douchat.coding.sessions.pax', version: 1, description: 'A read-only PAX inspection (info, doctor, deps, scripts, workspaces, lock, graph, reality, drift) of the session’s project, run where the session runs. PAX’s own answer, including ambiguity and drift, unchanged. Delegated operations (build, test, …) are not offered here.', effect: 'observation', authorization: [PERMISSIONS.codingRead],
      input: s.object({ id: s.string(), command: s.enum(PAX_INSPECTIONS) }),
      output: s.object({ command: s.string(), argv: s.array(s.string()), exitCode: s.nullable(s.number()), json: s.optional(s.unknown()), stdout: s.string(), stderr: s.string(), findings: s.object({ ambiguous: s.boolean(), drift: s.boolean(), failedClosed: s.boolean() }) }),
      handler: input => mapped(() => api.pax(input.id, input.command)) }),
    defineCapability({ name: 'douchat.ci.plan', version: 1, description: 'What Run CI would do for a project, before it does anything: the committed revision, the platform Compute states (Certified or Preview) and PAX’s plan of operations. Blockers say why it cannot run (uncommitted changes, PAX ambiguity, Compute unavailable).', effect: 'observation', authorization: [PERMISSIONS.codingRead],
      input: s.object({ projectId: s.string(), tool: s.optional(s.string()) }), output: ciPlan, handler: input => mapped(() => api.ciPlan(input.projectId, input.tool)) }),
    defineCapability({ name: 'douchat.ci.runs.start', version: 1, description: 'Run a project’s CI on an ephemeral Compute Computer: PAX plans, Compute acquires and configures the Computer, the committed revision is checked out, PAX’s operations run there, evidence is kept and the Computer is released. Returns as soon as the run exists.', effect: 'consequential', authorization: [PERMISSIONS.codingControl],
      input: s.object({ projectId: s.string(), tool: s.optional(s.string()) }), output: ciRun, handler: input => mapped(() => api.startCi(input)) }),
    defineCapability({ name: 'douchat.ci.runs.get', version: 1, description: 'One CI run: revision, PAX plan, each operation with its bounded output, failure, and whether the Computer was released. Readable after the Computer is gone.', effect: 'observation', authorization: [PERMISSIONS.codingRead],
      input: idInput, output: ciRun, handler: input => mapped(() => api.getCi(input.id)) }),
    defineCapability({ name: 'douchat.ci.runs.list', version: 1, description: 'CI runs, newest first.', effect: 'observation', authorization: [PERMISSIONS.codingRead],
      input: s.object({ projectId: s.optional(s.string()), status: s.optional(s.enum(['running', 'passed', 'failed', 'cancelled', 'interrupted', 'blocked'] as const)) }),
      output: s.object({ runs: s.array(ciRun) }), handler: input => mapped(async () => ({ runs: await api.listCi(input) })) }),
    defineCapability({ name: 'douchat.ci.runs.cancel', version: 1, description: 'Stop a running CI workload on its Computer, keep the evidence and release the Computer. Returns the run once it has ended.', effect: 'consequential', authorization: [PERMISSIONS.codingControl],
      input: idInput, output: ciRun, handler: input => mapped(() => api.cancelCi(input.id)) }),
    defineCapability({ name: 'douchat.coding.approvals.list', version: 1, description: 'Approvals waiting for an answer now, each with its agent, project, session and folder.', effect: 'observation', authorization: [PERMISSIONS.approvalsRead],
      input: s.object({ sessionId: s.optional(s.string()) }), output: s.object({ approvals: s.array(approval) }), handler: input => mapped(async () => ({ approvals: await api.pendingApprovals(input.sessionId) })) }),
    defineCapability({ name: 'douchat.coding.approvals.resolve', version: 1, description: 'Approve or deny one pending approval, once. It must belong to the named session and still be pending.', effect: 'consequential', authorization: [PERMISSIONS.approvalsResolve],
      input: s.object({ approvalId: s.string(), sessionId: s.string(), decision: s.enum(['approve', 'deny'] as const) }), output: s.object({ approvalId: s.string(), decision: s.enum(['approve', 'deny'] as const) }),
      handler: input => mapped(() => api.resolveApproval(input)) })
  ]
}

export function codingEvents(): AnyEvent[] {
  const payload = s.object({
    name: s.string(), sessionId: s.string(), projectId: s.string(), at: s.number(), origin,
    payload: s.record(s.unknown())
  })
  return CODING_EVENT_NAMES.map(name => defineEvent({ name, version: 1, description: `Coding notice: ${name}. Live only — the durable record is the session history.`, authorization: [PERMISSIONS.codingRead], payload }))
}
