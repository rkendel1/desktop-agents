import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { authorizeOpenAI, discoverOpenAIModels, refreshOpenAI, type OpenAICredential } from './openaiAuth'

const encoded = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

describe('official OpenAI connection', () => {
  it('uses loopback PKCE, validates identity, and never returns credentials through the browser callback', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const jwk = publicKey.export({ format: 'jwk' })
    const request = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input)
      if (url.endsWith('/.well-known/openid-configuration')) return Response.json({ jwks_uri: 'https://auth.openai.com/.well-known/jwks.json' })
      if (url.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] })
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'access-secret', refresh_token: 'refresh-secret', id_token: currentToken, expires_in: 3600, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' })
      throw new Error(`Unexpected URL ${url}`)
    }) as unknown as typeof fetch
    let currentToken = ''
    let opened = ''
    let finish!: (url: URL) => void
    const listen = async () => ({ server: { close: vi.fn() }, redirectUri: 'http://127.0.0.1:1455/auth/callback', callback: new Promise<URL>(resolve => { finish = resolve }) })
    const credential = await authorizeOpenAI(async value => {
      opened = value
      const auth = new URL(value)
      const claims = { iss: 'https://auth.openai.com', aud: 'oaiapp_foundry', exp: Math.floor(Date.now() / 1000) + 300, nonce: auth.searchParams.get('nonce'), sub: 'account-123', email: 'person@example.com' }
      const unsigned = `${encoded({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })}.${encoded(claims)}`
      currentToken = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`
      const callback = new URL(auth.searchParams.get('redirect_uri')!)
      callback.searchParams.set('code', 'one-use-code'); callback.searchParams.set('state', auth.searchParams.get('state')!); callback.searchParams.set('client_id', 'oaiapp_foundry')
      finish(callback)
    }, new AbortController().signal, { hostId: 'urn:uuid:test-host', request, listen })
    const authorization = new URL(opened)
    expect(authorization.origin + authorization.pathname).toBe('https://auth.openai.com/api/accounts/authorize')
    expect(authorization.searchParams.get('client_id')).toBe('dynamic_agent_client')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
    expect(credential).toMatchObject({ email: 'person@example.com', subject: 'account-123', clientId: 'oaiapp_foundry', hostId: 'urn:uuid:test-host', accessToken: 'access-secret', refreshToken: 'refresh-secret' })
  })

  it('rejects a callback with the wrong state before exchanging a code', async () => {
    const request = vi.fn() as unknown as typeof fetch
    let finish!: (url: URL) => void
    const listen = async () => ({ server: { close: vi.fn() }, redirectUri: 'http://127.0.0.1:1455/auth/callback', callback: new Promise<URL>(resolve => { finish = resolve }) })
    await expect(authorizeOpenAI(async value => {
      const auth = new URL(value), callback = new URL(auth.searchParams.get('redirect_uri')!)
      callback.searchParams.set('code', 'code'); callback.searchParams.set('state', 'attacker'); callback.searchParams.set('client_id', 'oaiapp_foundry')
      finish(callback)
    }, new AbortController().signal, { request, listen })).rejects.toThrow('state validation')
    expect(request).not.toHaveBeenCalled()
  })

  it('checkpoints a new registration before a failed one-time code exchange', async () => {
    const events: string[] = []
    const request = vi.fn(async () => {
      events.push('exchange')
      return Response.json({ error: 'invalid_grant' }, { status: 400 })
    }) as unknown as typeof fetch
    let finish!: (url: URL) => void
    const listen = async () => ({ server: { close: vi.fn() }, redirectUri: 'http://127.0.0.1:1455/auth/callback', callback: new Promise<URL>(resolve => { finish = resolve }) })
    await expect(authorizeOpenAI(async value => {
      const auth = new URL(value), callback = new URL(auth.searchParams.get('redirect_uri')!)
      callback.searchParams.set('code', 'one-use-code'); callback.searchParams.set('state', auth.searchParams.get('state')!); callback.searchParams.set('client_id', 'oaiapp_foundry')
      finish(callback)
    }, new AbortController().signal, {
      request,
      listen,
      onRegistration: clientId => { events.push(`registered:${clientId}`) }
    })).rejects.toThrow('Select Continue with ChatGPT again')
    expect(events).toEqual(['registered:oaiapp_foundry', 'exchange'])
  })

  it('reuses a checkpointed registration when the callback omits its client ID', async () => {
    let opened = ''
    let exchange = ''
    const request = vi.fn(async (_input, init) => {
      exchange = String(init?.body)
      return Response.json({ error: 'invalid_grant' }, { status: 400 })
    }) as unknown as typeof fetch
    let finish!: (url: URL) => void
    const listen = async () => ({ server: { close: vi.fn() }, redirectUri: 'http://127.0.0.1:1455/auth/callback', callback: new Promise<URL>(resolve => { finish = resolve }) })
    await expect(authorizeOpenAI(async value => {
      opened = value
      const auth = new URL(value), callback = new URL(auth.searchParams.get('redirect_uri')!)
      callback.searchParams.set('code', 'fresh-code'); callback.searchParams.set('state', auth.searchParams.get('state')!)
      finish(callback)
    }, new AbortController().signal, { registeredClientId: 'oaiapp_foundry', request, listen })).rejects.toThrow('one-time authorization code')
    expect(new URL(opened).searchParams.get('client_id')).toBe('oaiapp_foundry')
    expect(new URL(opened).searchParams.has('agent_name_hint')).toBe(false)
    expect(exchange).toContain('client_id=oaiapp_foundry')
  })

  it('discovers only listed models and preserves only provider-reported reasoning levels', async () => {
    const request = vi.fn(async (_input, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access-secret')
      return Response.json({ models: [
        { slug: 'reasoner', display_name: 'Reasoner', visibility: 'list', supported_reasoning_efforts: ['low', 'high', 'invented'] },
        { slug: 'hidden', visibility: 'hidden' }, { slug: 'plain', visibility: 'list' }
      ] })
    }) as unknown as typeof fetch
    await expect(discoverOpenAIModels('access-secret', request)).resolves.toEqual({ models: ['reasoner', 'plain'], labels: { reasoner: 'Reasoner' }, thinkingLevels: { reasoner: ['low', 'high'] } })
  })

  it('atomically replaces rotating refresh credentials in the returned record', async () => {
    const old: OpenAICredential = { issuer: 'https://auth.openai.com', subject: 'account', clientId: 'client', hostId: 'host', idToken: 'id', accessToken: 'old-access', refreshToken: 'old-refresh', scopes: ['chatgpt.tokens.use.direct'], expiresAt: 0 }
    const request = vi.fn(async (_input, init) => {
      expect(String(init?.body)).toContain('refresh_token=old-refresh')
      return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' })
    }) as unknown as typeof fetch
    await expect(refreshOpenAI(old, request)).resolves.toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh' })
  })
})
