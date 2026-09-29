import { randomUUID } from 'node:crypto'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServices, type AppPortServices, type ServiceAuthorizationDecision, type ServiceAuthorizationRequest, type ServiceAuthorizer } from '@appport/services'
import type { Authenticate } from '@appport/server'
import { ALL_PERMISSIONS, APPLICATION } from './contract'

/**
 * Douchat consumes AppPort Services from the same FeltDB flow it stores its own state in.
 *
 * `createServices` is given the directory of Douchat's flow, and FeltDB resolves that to the one store
 * (`desktop.flow` declares Douchat's collections and the Services collections it uses). There is no
 * second database, no second path and no copy of Services state on the Douchat side: Douchat holds
 * no API-key data, it asks the Services capability.
 */
export const LOCAL_TENANT = 'local'
const OWNER = { principalId: 'local-owner', principalType: 'user', tenantId: LOCAL_TENANT, applicationId: APPLICATION.id, verifiedBy: 'douchat-host' } as const

/**
 * The authority for API-key management on this computer.
 *
 * AppPort Services never decides who may cause an effect; a host-supplied authorizer (AuthBoundry, when one is
 * connected) does, and without one every service effect fails closed. Douchat has no AuthBoundry yet, so this
 * stand-in permits exactly one thing: the local owner, identified by Douchat's own main process, managing
 * this application's API keys. It authorizes nothing else, for anyone else. It is replaced, not extended,
 * when a real authority is connected.
 */
export function localOwnerAuthorizer(): ServiceAuthorizer {
  return {
    async authorize(request: ServiceAuthorizationRequest): Promise<ServiceAuthorizationDecision> {
      const allowed = request.subject.id === OWNER.principalId && request.tenant_id === LOCAL_TENANT && request.application_id === APPLICATION.id && request.capability.startsWith('apikeys.')
      return { decision_id: randomUUID(), allowed, capability: request.capability, tenant_id: request.tenant_id, application_id: request.application_id, subject: request.subject,
        resource: request.resource, reason: allowed ? 'local owner managing this application’s API keys' : 'not permitted by the local owner authority', policy_version: 'douchat-local-owner-1', evaluated_at: Date.now() }
    }
  }
}

/** AppPort Services over Douchat's flow directory (`databaseDirectory` of the desktop). */
export function openDesktopServices(flowDirectory: string): AppPortServices {
  return createServices({ mode: 'local', path: flowDirectory, namespace: 'desktop', application: APPLICATION.id, authorizer: localOwnerAuthorizer() })
}

/**
 * The key a local client presents. It is created through the Services capability (hashed, audited, revocable
 * in the shared flow) and its plaintext exists only in this owner-readable file. If the file's key still
 * authenticates it is reused; otherwise a new one is issued.
 */
export async function ensureClientApiKey(services: AppPortServices, directory: string): Promise<{ secret: string; file: string }> {
  const file = join(directory, 'appport-api-key')
  const existing = (await readFile(file, 'utf8').catch(() => '')).trim()
  if (existing && (await services.apiKeys.authenticateApiKey(existing))) return { secret: existing, file }
  const owner = services.identify(OWNER)
  if (!owner) throw new Error('The local owner could not be identified.')
  const created = await services.apiKeys.createApiKey({ name: 'Douchat local client', tenantId: LOCAL_TENANT }, owner)
  await writeFile(file, `${created.secret}\n`, { mode: 0o600 })
  await chmod(file, 0o600).catch(() => undefined)
  return { secret: created.secret, file }
}

/**
 * AppPort does not authenticate; it represents an identity. Here the identity is whoever holds a valid,
 * unrevoked Douchat API key. A key identifies a caller and carries no scopes, so what a Douchat caller may do is
 * Douchat's decision (its coding permissions), stated in one place: this function.
 */
export function apiKeyAuthenticator(services: AppPortServices): Authenticate {
  return async ({ headers }) => {
    const header = headers?.authorization ?? headers?.Authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return {}
    const principal = await services.apiKeys.authenticateApiKey(header.slice(7).trim()).catch(() => null)
    if (!principal || principal.applicationId !== APPLICATION.id) return {}
    const identity = { id: principal.principalId, type: 'application' as const, displayName: 'Douchat API key' }
    return { principal: identity, session: { id: principal.credentialId ?? principal.principalId, applicationId: APPLICATION.id, createdAt: new Date().toISOString(), permissions: ALL_PERMISSIONS, principal: identity } }
  }
}
