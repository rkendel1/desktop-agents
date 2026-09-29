import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

/** A desktop-only PKCE flow. Neither the verifier nor exchange errors reach a URL/log. */
export function authorizeTokenDance(openExternal: (url: string) => Promise<unknown>, signal: AbortSignal, request: typeof fetch = fetch): Promise<string> {
  return new Promise((resolve, reject) => {
    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(32).toString('base64url')
    const exchange = new AbortController()
    let settled = false
    let exchanging = false
    const finish = (error?: Error, key?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      exchange.abort()
      server.close()
      server.closeAllConnections()
      if (error) reject(error)
      else resolve(key!)
    }
    const cancel = () => finish(new Error('TokenDance authorization cancelled.'))
    const server = createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (req.method !== 'GET' || url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
        res.writeHead(404).end('Not found'); return
      }
      const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
      if (url.searchParams.has('error')) {
        res.writeHead(200, headers).end('Authorization declined. Return to Foundry.')
        finish(new Error('TokenDance authorization declined.')); return
      }
      const code = url.searchParams.get('code')
      if (!code || code.length > 4096 || exchanging) { res.writeHead(400, headers).end('Invalid callback'); return }
      exchanging = true
      try {
        const response = await request('https://tokendance.space/portal/api/v1/auth/keys', {
          method: 'POST', redirect: 'error', signal: AbortSignal.any([exchange.signal, AbortSignal.timeout(30000)]),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' })
        })
        if (!response.ok) throw new Error('exchange failed')
        const data = await response.json() as { key?: unknown }
        if (typeof data.key !== 'string' || !data.key.trim()) throw new Error('invalid key')
        res.writeHead(200, headers).end('TokenDance authorized. Return to Foundry and save the provider. / 授权成功，请返回 Foundry 保存服务商。')
        finish(undefined, data.key)
      } catch {
        res.writeHead(502, headers).end('Authorization failed. Return to Foundry and try again.')
        finish(new Error('TokenDance authorization failed. Please try again.'))
      }
    })
    const timer = setTimeout(() => finish(new Error('TokenDance authorization timed out. Please try again.')), 10 * 60 * 1000)
    timer.unref()
    server.on('error', () => finish(new Error('Could not start TokenDance authorization.')))
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) { cancel(); return }
    server.listen(0, '127.0.0.1', () => {
      if (settled) { server.close(); return }
      const address = server.address()
      if (!address || typeof address === 'string') { finish(new Error('Could not start TokenDance authorization.')); return }
      const url = new URL('https://tokendance.space/auth')
      url.search = new URLSearchParams({
        callback_url: `http://127.0.0.1:${address.port}/callback?state=${state}`,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256', app_url: 'https://douchat.ai', key_name: 'Foundry'
      }).toString()
      void openExternal(url.toString()).catch(() => finish(new Error('Could not open the authorization page.')))
    })
  })
}
