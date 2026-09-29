import { executableCommand } from './windowsCommand'
import { changedLocalAgentSettings } from './localAgentSettingsVersion'
import type { CustomLocalAgentInput, LocalAgent } from '../shared/types'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { resolveExecutable, executableEnvironment } from './shellPath'

const execFileAsync = promisify(execFile)
/** Where the owner's custom agents are kept: the desktop's FeltDB, through the repository. */
export interface LocalAgentRegistry {
  localAgentDefinitions(): Promise<{ id: string; name: string; command: string; args?: string[]; avatar?: string }[]>
  replaceLocalAgentDefinitions(definitions: { id: string; name: string; command: string; args?: string[]; avatar?: string }[]): Promise<void>
}
let registry: LocalAgentRegistry | undefined

interface CustomLocalAgentDefinition extends CustomLocalAgentInput { id: string }

const CUSTOM_ID = /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function configureLocalAgentRegistry(source?: LocalAgentRegistry): void {
  registry = source
}

export function customDefinition(value: unknown): CustomLocalAgentDefinition | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Record<string, unknown>
  const id = String(input.id ?? '').trim()
  if (!CUSTOM_ID.test(id) && !localAgentCatalog.some(item => item[0] === id)) return undefined
  try { return { id, ...validateLocalAgentInput(input as unknown as CustomLocalAgentInput) } }
  catch { return undefined }
}

async function customDefinitions(): Promise<CustomLocalAgentDefinition[]> {
  if (!registry) return []
  return (await registry.localAgentDefinitions()).map(customDefinition).filter((item): item is CustomLocalAgentDefinition => Boolean(item)).slice(0, 75)
}

async function writeCustomDefinitions(definitions: CustomLocalAgentDefinition[]): Promise<void> {
  if (!registry) throw new Error('Local agent registry is unavailable')
  await registry.replaceLocalAgentDefinitions(definitions)
}

export function validateLocalAgentInput(input: CustomLocalAgentInput): CustomLocalAgentInput {
  const name = String(input?.name ?? '').trim()
  const command = String(input?.command ?? '').trim()
  if (!name || name.length > 80) throw new Error('Enter a local agent name of 80 characters or fewer.')
  if (!command || command.length > 2_048 || /[\0\r\n]/.test(command)) throw new Error('Enter a valid executable command or absolute path.')
  if (!/[\\/]/.test(command) && /\s/.test(command)) throw new Error('A command name cannot contain spaces. Use an absolute path instead.')
  const args = input.args ?? []
  if (!Array.isArray(args) || args.length > 128 || args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || JSON.stringify(args).length > 16384) throw new Error('Enter valid startup arguments.')
  const avatar = input.avatar || undefined
  if (avatar && (typeof avatar !== 'string' || avatar.length > 512_000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar))) throw new Error('Choose a PNG, JPEG or WebP avatar.')
  return { name, command, args, avatar }
}

// Serialize read/modify/write operations so simultaneous settings windows cannot lose edits.
let registryWrite: Promise<unknown> = Promise.resolve()
function mutateRegistry(action: (definitions: CustomLocalAgentDefinition[]) => void): Promise<void> {
  const work = registryWrite.catch(() => {}).then(async () => {
    const definitions = await customDefinitions()
    action(definitions)
    await writeCustomDefinitions(definitions)
  })
  registryWrite = work
  return work
}
export async function addCustomLocalAgent(input: CustomLocalAgentInput): Promise<void> {
  const value = validateLocalAgentInput(input)
  await mutateRegistry(definitions => {
    if (definitions.filter(item => CUSTOM_ID.test(item.id)).length >= 64) throw new Error('Up to 64 custom local agents can be registered.')
    definitions.push({ id: `custom:${randomUUID()}`, ...value })
  })
}
export async function updateLocalAgent(id: string, input: CustomLocalAgentInput): Promise<void> {
  const value = validateLocalAgentInput(input)
  await mutateRegistry(definitions => {
    const index = definitions.findIndex(item => item.id === id)
    if (index < 0 && !localAgentCatalog.some(item => item[0] === id)) throw new Error('Unknown local agent')
    if (index < 0) definitions.push({ id, ...value })
    else definitions[index] = { id, ...value }
  })
  changedLocalAgentSettings(id)
}
export async function removeCustomLocalAgent(id: string): Promise<void> {
  if (!CUSTOM_ID.test(id)) throw new Error('Invalid custom local agent')
  await mutateRegistry(definitions => {
    const index = definitions.findIndex(item => item.id === id)
    if (index < 0) throw new Error('Custom local agent not found')
    definitions.splice(index, 1)
  })
}

/** Resolve a draft without changing the registry or any existing conversation. */
export async function resolveLocalAgentDraft(id: string | undefined, input: CustomLocalAgentInput): Promise<LocalAgent> {
  const value = validateLocalAgentInput(input)
  const existing = id ? (await detectLocalAgents({ version: async () => undefined }, id))[0] : undefined
  if (id && !existing) throw new Error('Unknown local agent')
  const path = await resolveExecutable(value.command)
  if (!path) throw new Error('Executable not found. Check the path and executable permissions.')
  return { id: id ?? `custom:${randomUUID()}`, ...value, path, installed: true, discovered: true,
    chatSupported: true, status: 'ready', authentication: 'unchecked', custom: existing?.custom ?? !id }
}

// Keep the local CLI catalog aligned with Termany. Every catalog entry has a
// one-shot chat adapter in localAgentRuntime, so any detected executable can
// be selected when creating an agent.
export const localAgentCatalog = [
  ['claude', 'Claude Code', 'claude', ['Claude.app']],
  ['codex', 'Codex', 'codex', []],
  ['gemini', 'Gemini', 'gemini', []],
  ['grok', 'Grok Build', 'grok', ['Grok Bot.app']],
  ['openclaw', 'OpenClaw', 'openclaw', ['OpenClaw.app']],
  ['hermes', 'Hermes', 'hermes', ['Hermes.app']],
  ['opencode', 'OpenCode', 'opencode', ['OpenCode.app']],
  ['cursor', 'Cursor', 'cursor-agent', ['Cursor.app']],
  ['kimi', 'Kimi', 'kimi', ['Kimi.app']],
  ['omp', 'OMP', 'omp', []],
  ['fastclaw', 'FastClaw', 'fastclaw', []]
] as const

export async function findDesktopApp(names: readonly string[], roots = [
  '/Applications',
  '/System/Applications',
  join(homedir(), 'Applications')
]): Promise<string | undefined> {
  if (process.platform !== 'darwin' || !names.length) return undefined
  for (const root of roots) {
    for (const name of names) {
      const candidate = join(root, name)
      try {
        await access(candidate, constants.F_OK)
        return candidate
      } catch { /* Try the next conventional application location. */ }
    }
  }
  return undefined
}

export async function executableVersion(path: string): Promise<string | undefined> {
  try {
    const command = await executableCommand(path)
    const { stdout, stderr } = await execFileAsync(command.file, [...command.prefix, '--version'], {
      env: await executableEnvironment(),
      // Node-based CLIs can take several seconds to load even for --version.
      timeout: 6_000,
      killSignal: 'SIGKILL',
      maxBuffer: 256 * 1024,
      windowsHide: true
    })
    const line = `${stdout}\n${stderr}`.split(/\r?\n/).map((item) => item.trim()).find(Boolean)
    return line?.slice(0, 160)
  } catch {
    // A runnable CLI may not implement --version. Launch compatibility is
    // still established by its known adapter and executable bit.
    return undefined
  }
}

interface DetectionDependencies {
  executable?: (command: string) => Promise<string | undefined>
  desktopApp?: (names: readonly string[]) => Promise<string | undefined>
  version?: (path: string) => Promise<string | undefined>
}

async function detectionDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Local agent detection timed out. Check your shell startup configuration and try again.')), ms)
    })])
  } finally { clearTimeout(timer) }
}

export function detectLocalAgents(dependencies: DetectionDependencies = {}, onlyId?: string): Promise<LocalAgent[]> {
  return detectionDeadline(detectLocalAgentsInternal(dependencies, onlyId), 15000)
}

async function detectLocalAgentsInternal(dependencies: DetectionDependencies = {}, onlyId?: string): Promise<LocalAgent[]> {
  const resolveCommand = dependencies.executable ?? resolveExecutable
  const resolveApp = dependencies.desktopApp ?? findDesktopApp
  const readVersion = dependencies.version ?? executableVersion
  const custom = await customDefinitions()
  const definitions: ReadonlyArray<readonly [string, string, string, readonly string[], boolean]> = [
    ...localAgentCatalog.map(([id, name, command, appNames]) => [id, name, command, appNames, false] as const),
    ...custom.filter(item => CUSTOM_ID.test(item.id)).map(({ id, name, command }) => [id, name, command, [], true] as const)
  ]
  return Promise.all(definitions.filter(([id]) => !onlyId || id === onlyId).map(async ([id, name, command, appNames, isCustom]) => {
    const override = custom.find(item => item.id === id)
    name = override?.name ?? name
    command = override?.command ?? command
    const [path, desktopPath] = await Promise.all([resolveCommand(command), resolveApp(appNames)])
    const version = path ? await detectionDeadline(readVersion(path), 8000).catch(() => undefined) : undefined
    const status = path ? 'ready' : desktopPath ? 'desktop-only' : 'not-found'
    return {
      id,
      name,
      command,
      args: override?.args,
      avatar: override?.avatar,
      installed: Boolean(path),
      discovered: Boolean(path || desktopPath),
      path,
      desktopPath,
      version,
      chatSupported: true,
      status,
      authentication: 'unchecked',
      custom: isCustom || undefined
    }
  }))
}

export async function validateLocalAgent(id: string): Promise<LocalAgent> {
  const agent = (await detectLocalAgents({ version: async () => undefined }, id)).find((item) => item.id === id)
  if (!agent) throw new Error('Unknown local agent')
  if (!agent.installed) throw new Error(`${agent.name} is not installed. Refresh Agents in Settings after installing it.`)
  return agent
}
