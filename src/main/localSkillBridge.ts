import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { validateToolArguments } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'

/** Per-turn localhost capability: no public listener, no general IPC, no persistent token. */
export async function openLocalSkillBridge(tools: AgentTool[], signal: AbortSignal) {
  const token = randomBytes(32).toString('hex')
  const lifetime = new AbortController()
  const active = AbortSignal.any([signal, lifetime.signal])
  let busy = false
  const server = createServer(async (req, res) => {
    const send = (code: number, value: unknown) => { if (!res.destroyed) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) } }
    if (req.headers.origin || req.method !== 'POST' || req.url !== '/tools' || req.headers.authorization !== `Bearer ${token}` || active.aborted) { send(403, { error: 'Unauthorized' }); return }
    if (busy) { send(409, { error: 'A skill operation is already pending' }); return }
    busy = true
    const disconnect = new AbortController()
    res.on('close', () => { if (!res.writableEnded) disconnect.abort() })
    try {
      let size = 0; const chunks: Buffer[] = []
      for await (const part of req) {
        size += part.length
        if (size > 3_000_000) throw new Error('Skill request exceeds 3 MB')
        chunks.push(Buffer.from(part))
      }
      const call = JSON.parse(Buffer.concat(chunks).toString())
      const tool = tools.find(tool => tool.name === call.tool)
      if (!tool) throw new Error('Unknown skill tool')
      const args = validateToolArguments(tool, { type: 'toolCall', id: 'local-skill', name: tool.name, arguments: call.arguments ?? {} })
      const operationSignal = AbortSignal.any([active, disconnect.signal])
      operationSignal.throwIfAborted()
      const output = await tool.execute('local-skill', args, operationSignal)
      send(200, output)
    } catch (error) { send(400, { error: error instanceof Error ? error.message : String(error) }) }
    finally { busy = false }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not open local skill bridge')
  const close = () => { lifetime.abort(); server.closeAllConnections(); server.close(); signal.removeEventListener('abort', close) }
  signal.addEventListener('abort', close, { once: true })
  if (signal.aborted) { close(); signal.throwIfAborted() }
  return { close, prompt: [
    'Foundry skill tools for THIS TURN ONLY: use your native shell/HTTP tool to POST JSON {"tool":"tool_name","arguments":{...}} to the loopback endpoint below. This is the supported way to install skills into Foundry, including another owned agent. Do not write its database. Keep this private token out of replies and files; discard older endpoints from history. Wait for the response (owner approval can take several minutes). If your native shell needs permission, request it normally.',
    `Endpoint: http://127.0.0.1:${address.port}/tools`, `Authorization: Bearer ${token}`,
    'Send Content-Type: application/json. Prefer stdin/heredoc JSON rather than interpolating commands or file contents into shell strings.',
    JSON.stringify(tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })))
  ].join('\n') }
}
