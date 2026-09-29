import { createGitHubIntegration, type GitHubIntegration } from '@appport/github'
import type { CredentialVault } from '../credentialVault'
import { LOCAL_TENANT } from './services'
import { APPLICATION } from './contract'

/**
 * Douchat consumes `@appport/github` as a capability. There is no GitHub API code in Douchat: repository
 * metadata, branches, issues and pull requests are the capability's operations, and everything it stores
 * (connections, normalized repositories, operations, evidence, webhook deliveries) lives in its own collections
 * of the one shared flow — `felt.path` is the directory of Douchat's flow, so FeltDB resolves it to the same store.
 *
 * Git remains the authority for the local working tree; this is the remote service capability.
 */
export const GITHUB_CONNECTION = 'douchat-github'

/** Capabilities the local owner may exercise. Nothing else is granted, to anyone. */
const OWNER_CAPABILITIES = ['github.organization.read', 'github.repository.read', 'github.branch.read', 'github.commit.read', 'github.issue.read', 'github.pull_request.read']

interface AuthorityBoundaryLike { session(): Promise<never>; authorize(capability: string): Promise<boolean> }

/**
 * The AuthBoundry-compatible boundary for this computer's owner. `@appport/github` takes identity and tenant from the
 * boundary and ignores what a caller claims. A real AuthBoundry client replaces this; until then the local owner
 * may read (never mutate) through the capability, which is all Douchat asks of it today.
 */
export function localOwnerGitHubAuthority(): AuthorityBoundaryLike {
  const session = async (): Promise<never> => ({
    authenticated: true, principal: { id: 'local-owner', kind: 'user' }, tenant: { id: LOCAL_TENANT }, claims: {}, capabilities: OWNER_CAPABILITIES, session: { id: 'douchat-local' }, delegation: null
  }) as never
  return { session, authorize: async capability => OWNER_CAPABILITIES.includes(capability) }
}

const secretName = (secretId: string): string => `github:${secretId}`

export function openDesktopGitHub(flowDirectory: string, vault: Pick<CredentialVault, 'get'>): GitHubIntegration {
  return createGitHubIntegration({
    authority: localOwnerGitHubAuthority() as never,
    felt: { mode: 'local', namespace: 'desktop', path: flowDirectory },
    configuration: {
      // Secret values come from Douchat's credential vault (encrypted by the operating system), by reference. FeltDB holds the reference only.
      resolveGitHubToken: async connection => {
        const reference = connection.credentialReference
        const token = reference ? vault.get(secretName(reference.secretId)) : undefined
        if (!token) throw new Error('No GitHub credential is available for this connection.')
        return token
      }
    }
  })
}

/** Connect Douchat to GitHub. `token` (a personal access token) is kept in the vault; the connection records only its reference. */
export async function connectGitHub(github: GitHubIntegration, vault: Pick<CredentialVault, 'set'>, token?: string): Promise<void> {
  const now = new Date().toISOString()
  if (token) vault.set(secretName('douchat-github-token'), token)
  await github.upsertConnection({
    id: GITHUB_CONNECTION, tenantId: LOCAL_TENANT, applicationId: APPLICATION.id, environment: 'local', provider: 'github',
    authMechanism: token ? 'personal_access_token' : 'public', status: 'configured',
    ...(token ? { credentialReference: { secretId: 'douchat-github-token', tenantId: LOCAL_TENANT, provider: 'github' } } : {}),
    capabilities: [], createdAt: now, updatedAt: now
  } as never)
}

/** `owner/repo` from a GitHub remote URL (https or ssh), else undefined. Pure parsing of what Git reports. */
export function parseGitHubRemote(url: string): { owner: string; repository: string } | undefined {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())
  return match ? { owner: match[1], repository: match[2] } : undefined
}

export interface ProjectRemoteView {
  projectId: string
  /** What Git says about the working tree — the authority for local source state. */
  local: { path: string; remoteUrl?: string }
  /** What the GitHub capability says about the remote; absent when the project's remote is not on GitHub. */
  github?: { owner: string; repository: string; fullName: string; defaultBranch?: string; private: boolean; archived: boolean; url?: string }
}

/**
 * Project → Repository → GitHub capability. The local remote URL is read from Git (the working tree is authoritative
 * for that); the repository's metadata is asked of `@appport/github`, through its normalized operation.
 */
export async function projectRemote(github: GitHubIntegration, project: { id: string; path: string }, remoteUrl: string | undefined): Promise<ProjectRemoteView> {
  const view: ProjectRemoteView = { projectId: project.id, local: { path: project.path, ...(remoteUrl ? { remoteUrl } : {}) } }
  const parsed = remoteUrl ? parseGitHubRemote(remoteUrl) : undefined
  if (!parsed) return view
  const repository = await github.repositories.get({ connectionId: GITHUB_CONNECTION, owner: parsed.owner, repository: parsed.repository }, { applicationId: APPLICATION.id })
  return { ...view, github: { owner: repository.owner, repository: repository.name, fullName: repository.fullName, private: repository.private, archived: repository.archived,
    ...(repository.defaultBranch ? { defaultBranch: repository.defaultBranch } : {}), ...(repository.url ? { url: repository.url } : {}) } }
}
