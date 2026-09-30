import { createHash, createPublicKey, randomBytes, randomUUID, verify, type JsonWebKey as CryptoJsonWebKey } from 'node:crypto'
import { createServer, type Server } from 'node:http'

const AUTHORIZE = 'https://auth.openai.com/api/accounts/authorize'
const TOKEN = 'https://auth.openai.com/api/accounts/oauth/token'
const RESOURCE = 'https://api.openai.com/v1'
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'

export interface OpenAICredential {
  email?: string
  issuer: string
  subject: string
  clientId: string
  hostId: string
  idToken: string
  accessToken: string
  refreshToken: string
  scopes: string[]
  expiresAt: number
}

interface TokenResponse { access_token?: unknown; refresh_token?: unknown; id_token?: unknown; expires_in?: unknown; scope?: unknown }

export class OpenAIAuthError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(message)
    this.name = 'OpenAIAuthError'
  }
}

const base64url = (value: Uint8Array): string => Buffer.from(value).toString('base64url')
const random = (bytes = 32): string => base64url(randomBytes(bytes))

function tokenPart<T>(token: string, index: number): T {
  const part = token.split('.')[index]
  if (!part) throw new Error('OpenAI returned an invalid identity token.')
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T }
  catch { throw new Error('OpenAI returned an invalid identity token.') }
}

async function validateIdToken(token: string, clientId: string, nonce: string, request: typeof fetch): Promise<{ sub: string; email?: string; iss: string }> {
  const header = tokenPart<{ alg?: string; kid?: string }>(token, 0)
  const claims = tokenPart<{ iss?: string; aud?: string | string[]; exp?: number; nonce?: string; sub?: string; email?: string }>(token, 1)
  if (header.alg !== 'RS256' || !header.kid) throw new Error('OpenAI returned an identity token with an unsupported signature.')
  if (claims.iss !== 'https://auth.openai.com' || !claims.sub || claims.nonce !== nonce || !claims.exp || claims.exp * 1000 <= Date.now()) throw new Error('OpenAI identity validation failed.')
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audiences.includes(clientId)) throw new Error('OpenAI identity validation failed.')
  const discovery = await request('https://auth.openai.com/.well-known/openid-configuration', { signal: AbortSignal.timeout(15000) })
  if (!discovery.ok) throw new Error('Could not validate the OpenAI identity.')
  const { jwks_uri: jwksUri } = await discovery.json() as { jwks_uri?: unknown }
  if (typeof jwksUri !== 'string' || new URL(jwksUri).origin !== 'https://auth.openai.com') throw new Error('OpenAI identity validation is unavailable.')
  const response = await request(jwksUri, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error('Could not validate the OpenAI identity.')
  const { keys } = await response.json() as { keys?: Array<CryptoJsonWebKey & { kid?: string }> }
  const jwk = keys?.find(key => key.kid === header.kid && key.kty === 'RSA')
  if (!jwk) throw new Error('OpenAI identity signing key was not found.')
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.')
  const valid = verify('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedPayload}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(encodedSignature, 'base64url'))
  if (!valid) throw new Error('OpenAI identity validation failed.')
  return { sub: claims.sub, ...(typeof claims.email === 'string' ? { email: claims.email } : {}), iss: claims.iss }
}

interface CallbackListener { server: Pick<Server, 'close'>; redirectUri: string; callback: Promise<URL> }
async function listen(signal: AbortSignal): Promise<CallbackListener> {
  let settle!: (url: URL) => void, reject!: (error: Error) => void
  const callback = new Promise<URL>((resolve, fail) => { settle = resolve; reject = fail })
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/auth/callback') { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end('<!doctype html><title>Foundry connected</title><p>You can return to Foundry.</p>')
    settle(url)
  })
  await new Promise<void>((resolve, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not start the OpenAI sign-in callback.')
  const abort = () => reject(new Error('OpenAI sign-in was cancelled.'))
  signal.addEventListener('abort', abort, { once: true })
  callback.finally(() => signal.removeEventListener('abort', abort)).catch(() => {})
  return { server, redirectUri: `http://127.0.0.1:${address.port}/auth/callback`, callback }
}

function parseTokenResponse(value: TokenResponse): { accessToken: string; refreshToken: string; idToken: string; expiresIn: number; scopes: string[] } {
  if (typeof value.access_token !== 'string' || typeof value.refresh_token !== 'string' || typeof value.id_token !== 'string') throw new Error('OpenAI did not return complete credentials.')
  const expiresIn = typeof value.expires_in === 'number' && value.expires_in > 0 ? value.expires_in : 3600
  const scopes = typeof value.scope === 'string' ? value.scope.split(/\s+/).filter(Boolean) : []
  if (!scopes.includes('chatgpt.tokens.use.direct')) throw new Error('ChatGPT plan access was not granted for Foundry.')
  return { accessToken: value.access_token, refreshToken: value.refresh_token, idToken: value.id_token, expiresIn, scopes }
}

async function tokenFailure(response: Response): Promise<OpenAIAuthError> {
  let code = 'token_exchange_failed'
  try {
    const value = await response.json() as { error?: unknown; code?: unknown }
    const candidate = typeof value.error === 'string' ? value.error : typeof value.code === 'string' ? value.code : ''
    if (/^[a-zA-Z0-9_.:-]{1,100}$/.test(candidate)) code = candidate
  } catch { /* OAuth servers may return an empty or non-JSON error body. */ }
  if (code === 'invalid_grant') return new OpenAIAuthError(code, 'ChatGPT did not accept the one-time authorization code. Select Continue with ChatGPT again to finish connecting.', response.status)
  if (code === 'invalid_client') return new OpenAIAuthError(code, 'ChatGPT rejected the saved app registration. Select Continue with ChatGPT again to create a fresh connection.', response.status)
  if (code === 'access_denied') return new OpenAIAuthError(code, 'ChatGPT plan access was not granted. Select Continue with ChatGPT and approve plan usage.', response.status)
  return new OpenAIAuthError(code, `OpenAI token exchange failed (HTTP ${response.status}, ${code}).`, response.status)
}

export async function authorizeOpenAI(openExternal: (url: string) => Promise<unknown>, signal: AbortSignal, options: { previous?: OpenAICredential; registeredClientId?: string; hostId?: string; request?: typeof fetch; listen?: (signal: AbortSignal) => Promise<CallbackListener>; onRegistration?: (clientId: string) => Promise<void> | void } = {}): Promise<OpenAICredential> {
  const request = options.request ?? fetch
  const state = random(), nonce = random(), verifier = random(48)
  const { server, redirectUri, callback } = await (options.listen ?? listen)(signal)
  try {
    const previous = options.previous
    const clientId = previous?.clientId ?? options.registeredClientId ?? 'dynamic_agent_client'
    const url = new URL(AUTHORIZE)
    const params: Record<string, string> = { client_id: clientId, ext_agent_host_id: previous?.hostId ?? options.hostId ?? `urn:uuid:${randomUUID()}`, response_type: 'code', redirect_uri: redirectUri, scope: SCOPES, resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: base64url(createHash('sha256').update(verifier).digest()) }
    if (previous) { params.id_token_hint = previous.idToken; if (previous.email) params.login_hint = previous.email }
    else if (clientId === 'dynamic_agent_client') params.agent_name_hint = 'Foundry'
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    await openExternal(url.toString())
    const result = await callback
    if (result.searchParams.get('state') !== state) throw new Error('OpenAI sign-in state validation failed.')
    if (result.searchParams.get('error')) throw new Error(result.searchParams.get('error_description') || 'OpenAI sign-in was denied.')
    const code = result.searchParams.get('code')
    const returnedClientId = result.searchParams.get('client_id')
    const issued = returnedClientId ?? clientId
    if (!code || !/^[a-zA-Z0-9_-]{1,200}$/.test(issued) || issued === 'dynamic_agent_client' || (clientId !== 'dynamic_agent_client' && returnedClientId !== null && issued !== clientId)) throw new Error('OpenAI registration did not complete.')
    // Registration succeeds before the one-time code exchange. Persist the
    // issued ID first so an expired/rejected code can retry without creating
    // another ChatGPT app registration.
    await options.onRegistration?.(issued)
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: issued, code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE })
    const response = await request(TOKEN, { method: 'POST', redirect: 'error', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal })
    if (!response.ok) throw await tokenFailure(response)
    const token = parseTokenResponse(await response.json() as TokenResponse)
    const identity = await validateIdToken(token.idToken, issued, nonce, request)
    if (previous && identity.sub !== previous.subject) throw new Error('OpenAI returned a different account than the selected connection.')
    return { email: identity.email, issuer: identity.iss, subject: identity.sub, clientId: issued, hostId: params.ext_agent_host_id, idToken: token.idToken, accessToken: token.accessToken, refreshToken: token.refreshToken, scopes: token.scopes, expiresAt: Date.now() + token.expiresIn * 1000 }
  } finally { server.close() }
}

export async function refreshOpenAI(credential: OpenAICredential, request: typeof fetch = fetch): Promise<OpenAICredential> {
  const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: credential.clientId, refresh_token: credential.refreshToken, resource: RESOURCE })
  const response = await request(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw new Error(`OpenAI authentication expired (HTTP ${response.status}). Reconnect OpenAI.`)
  const value = await response.json() as TokenResponse
  if (typeof value.access_token !== 'string' || typeof value.refresh_token !== 'string') throw new Error('OpenAI returned incomplete refreshed credentials.')
  const scopes = typeof value.scope === 'string' ? value.scope.split(/\s+/).filter(Boolean) : credential.scopes
  if (!scopes.includes('chatgpt.tokens.use.direct')) throw new Error('ChatGPT plan access is no longer authorized. Reconnect OpenAI.')
  return { ...credential, accessToken: value.access_token, refreshToken: value.refresh_token, scopes, expiresAt: Date.now() + (typeof value.expires_in === 'number' ? value.expires_in : 3600) * 1000 }
}

export async function discoverOpenAIModels(accessToken: string, request: typeof fetch = fetch): Promise<{ models: string[]; labels: Record<string, string>; thinkingLevels: Record<string, Array<'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>> }> {
  const response = await request(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw new Error(`OpenAI model discovery failed (HTTP ${response.status}).`)
  const data = await response.json() as { models?: unknown[]; data?: unknown[] }
  const rows = Array.isArray(data.models) ? data.models : Array.isArray(data.data) ? data.data : []
  const allowed = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  const models: string[] = [], labels: Record<string, string> = {}, thinkingLevels: Record<string, Array<'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>> = {}
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    if (row.visibility !== undefined && row.visibility !== 'list') continue
    const id = typeof row.slug === 'string' ? row.slug : typeof row.id === 'string' ? row.id : ''
    if (!id || id.length > 200 || models.includes(id)) continue
    models.push(id)
    if (typeof row.display_name === 'string' && row.display_name.trim()) labels[id] = row.display_name.trim().slice(0, 200)
    const efforts = Array.isArray(row.supported_reasoning_efforts) ? row.supported_reasoning_efforts.filter((value): value is 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' => typeof value === 'string' && allowed.has(value)) : []
    if (efforts.length) thinkingLevels[id] = [...new Set(efforts)]
  }
  if (!models.length) throw new Error('No OpenAI models are available to this account.')
  return { models: models.slice(0, 100), labels, thinkingLevels }
}
