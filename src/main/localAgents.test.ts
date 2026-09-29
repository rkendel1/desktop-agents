import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addCustomLocalAgent, configureLocalAgentRegistry, detectLocalAgents, findDesktopApp, removeCustomLocalAgent, updateLocalAgent, validateLocalAgent } from './localAgents'
import { resolveExecutable } from './shellPath'
import { memoryRegistry } from './testSupport'
vi.mock('./shellPath', () => ({ resolveExecutable: vi.fn() }))
let registryDirectory = ''
let registry = memoryRegistry()
beforeEach(async () => {
  vi.mocked(resolveExecutable).mockReset()
  registryDirectory = await mkdtemp(join(tmpdir(), 'douchat-local-agents-'))
  registry = memoryRegistry()
  configureLocalAgentRegistry(registry)
})
afterEach(async () => {
  configureLocalAgentRegistry()
  await rm(registryDirectory, { recursive: true, force: true })
})
describe('local agent discovery', () => {
  it('lists the full catalog and supports every detected command', async () => {
    const agents = await detectLocalAgents({
      executable: async (command) => ['codex', 'grok', 'openclaw'].includes(command) ? `/local/bin/${command}` : undefined,
      desktopApp: async () => undefined,
      version: async (path) => path.endsWith('/codex') ? 'codex-cli 1.2.3' : undefined
    })
    expect(agents).toHaveLength(11)
    expect(agents.find((agent) => agent.id === 'codex')).toMatchObject({ installed: true, discovered: true, status: 'ready', chatSupported: true, path: '/local/bin/codex', version: 'codex-cli 1.2.3' })
    expect(agents.find((agent) => agent.id === 'grok')).toMatchObject({ installed: true, chatSupported: true, path: '/local/bin/grok' })
    expect(agents.find((agent) => agent.id === 'openclaw')).toMatchObject({ installed: true, chatSupported: true })
    expect(agents.find((agent) => agent.id === 'claude')?.installed).toBe(false)
    expect(agents.at(-1)?.id).toBe('fastclaw')
  })
  it('reports a desktop app separately instead of pretending it is a compatible CLI', async () => {
    const agents = await detectLocalAgents({
      executable: async () => undefined,
      desktopApp: async (names) => names.includes('Claude.app') ? '/Applications/Claude.app' : undefined
    })
    expect(agents.find((agent) => agent.id === 'claude')).toMatchObject({
      installed: false,
      discovered: true,
      status: 'desktop-only',
      desktopPath: '/Applications/Claude.app',
      authentication: 'unchecked'
    })
  })
  it('looks for macOS apps in each supplied application root', async () => {
    await expect(findDesktopApp(['Definitely Missing Douchat Fixture.app'], ['/missing/one', '/missing/two'])).resolves.toBeUndefined()
  })
  it('persists a custom command and discovers it without a shell', async () => {
    await addCustomLocalAgent({ name: 'My Agent', command: '/opt/tools/my-agent' })
    const agents = await detectLocalAgents({
      executable: async (command) => command === '/opt/tools/my-agent' ? command : undefined,
      desktopApp: async () => undefined
    })
    const custom = agents.find((agent) => agent.custom)
    expect(custom).toMatchObject({
      name: 'My Agent', command: '/opt/tools/my-agent', installed: true,
      status: 'ready', custom: true
    })
    await removeCustomLocalAgent(custom!.id)
    await expect(detectLocalAgents({ executable: async () => undefined, desktopApp: async () => undefined })).resolves.toHaveLength(11)
  })
  it('validates only the requested CLI instead of probing the whole catalog', async () => {
    vi.mocked(resolveExecutable).mockResolvedValue('/local/bin/codex')
    await validateLocalAgent('codex')
    expect(resolveExecutable).toHaveBeenCalledExactlyOnceWith('codex')
  })
  it('persists builtin overrides without duplicating or changing its adapter', async () => {
    await updateLocalAgent('codex', { name: 'Work Codex', command: '/tools/codex', args: ['--profile', 'work'], avatar: 'data:image/png;base64,YQ==' })
    configureLocalAgentRegistry(registry)
    vi.mocked(resolveExecutable).mockImplementation(async command => command)
    const agent = await validateLocalAgent('codex')
    expect(agent).toMatchObject({ id: 'codex', name: 'Work Codex', path: '/tools/codex', custom: undefined, args: ['--profile', 'work'], avatar: 'data:image/png;base64,YQ==' })
    const all = await detectLocalAgents({ executable: async () => undefined, desktopApp: async () => undefined })
    expect(all).toHaveLength(11)
    await expect(removeCustomLocalAgent('codex')).rejects.toThrow('Invalid custom')
  })
  it('edits a custom command in place and preserves simultaneous registry writes', async () => {
    await Promise.all([
      addCustomLocalAgent({ name: 'First', command: 'first' }),
      addCustomLocalAgent({ name: 'Second', command: 'second' })
    ])
    const scan = () => detectLocalAgents({ executable: async () => undefined, desktopApp: async () => undefined })
    const first = (await scan()).find(item => item.name === 'First')!
    await updateLocalAgent(first.id, { name: 'Renamed', command: '/new/path', args: ['--prompt', '{prompt}'] })
    const all = await scan()
    expect(all.filter(item => item.custom)).toHaveLength(2)
    expect(all.find(item => item.id === first.id)).toMatchObject({ name: 'Renamed', command: '/new/path', args: ['--prompt', '{prompt}'] })
    await expect(updateLocalAgent('unknown', { name: 'Bad', command: 'bad' })).rejects.toThrow('Unknown')
    await expect(updateLocalAgent(first.id, { name: 'Bad', command: 'bad', args: ['bad\0arg'] })).rejects.toThrow('arguments')
    await expect(updateLocalAgent(first.id, { name: 'Bad', command: 'bad', avatar: 'https://example.com/a.png' })).rejects.toThrow('avatar')
  })
  it('rejects stale installation state and unknown commands', async () => {
    await expect(validateLocalAgent('codex')).rejects.toThrow('not installed')
    vi.mocked(resolveExecutable).mockResolvedValue('/local/bin/openclaw')
    await expect(validateLocalAgent('openclaw')).resolves.toMatchObject({ id: 'openclaw', chatSupported: true })
    await expect(validateLocalAgent('arbitrary-shell-command')).rejects.toThrow('Unknown')
  })
})

it('returns installed agents even when their version command never settles', async () => {
  vi.useFakeTimers()
  try {
    const version = vi.fn(() => new Promise<string | undefined>(() => {}))
    const result = detectLocalAgents({ executable: async () => '/bin/tool', desktopApp: async () => undefined, version }, 'codex')
    await vi.waitFor(() => expect(version).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(8100)
    expect(await result).toMatchObject([{ id: 'codex', installed: true, version: undefined }])
  } finally { vi.useRealTimers() }
})
it('bounds an entire scan when executable discovery never settles', async () => {
  vi.useFakeTimers()
  try {
    const result = detectLocalAgents({ executable: () => new Promise(() => {}), desktopApp: async () => undefined }, 'codex')
    const assertion = expect(result).rejects.toThrow('Local agent detection timed out')
    await vi.advanceTimersByTimeAsync(15001)
    await assertion
  } finally { vi.useRealTimers() }
})
