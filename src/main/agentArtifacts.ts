import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, lstat, realpath, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, isAbsolute, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { Type, type Static } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { isSafeSkillPath, validateAgentSkills, type AgentSkill } from '../shared/agentCustomization'
import { spawnEnvironment } from './shellPath'
import { killLocalProcess } from './localAgentConnection'

const MAX_FILE = 20 * 1024 * 1024
export interface ArtifactHost {
  skills(): AgentSkill[] | Promise<AgentSkill[]>
  authorize(details: string, signal?: AbortSignal): Promise<void>
  save(name: string, data: Uint8Array, signal?: AbortSignal): Promise<string>
}
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: {} })
function safePath(path: string) { if (typeof path !== 'string' || !isSafeSkillPath(path)) throw new Error('Use a safe relative file path') }
export async function runPackagedScript(skill: AgentSkill, path: string, args: string[], inputs: { path: string; content: string }[], outputs: string[], signal?: AbortSignal) {
  safePath(path)
  const extension = extname(path)
  if (!['.py', '.js', '.mjs', '.cjs'].includes(extension)) throw new Error('Only Python and JavaScript skill scripts are supported')
  const files = new Map([['SKILL.md', Buffer.from(skill.content)], ...(skill.files ?? []).map(f => [f.path, Buffer.from(f.data, 'base64')] as [string, Buffer])])
  if (!files.has(path)) throw new Error('Script not found in enabled skill package')
  let total = 0
  for (const input of inputs) {
    safePath(input.path)
    if (files.has(input.path) || [...files.keys()].some(p => p.toLowerCase() === input.path.toLowerCase())) throw new Error('Input cannot overwrite packaged files')
    const bytes = Buffer.from(input.content); total += bytes.length
    if (total > MAX_FILE) throw new Error('Inputs exceed 20 MB')
    files.set(input.path, bytes)
  }
  for (const path of outputs) safePath(path)
  const cwd = await mkdtemp(join(tmpdir(), 'douchat-skill-run-'))
  try {
    for (const [path, bytes] of files) { safePath(path); await mkdir(dirname(join(cwd, path)), { recursive: true }); await writeFile(join(cwd, path), bytes, { flag: 'wx', mode: 0o600 }) }
    signal?.throwIfAborted()
    const sourceEnv = await spawnEnvironment()
    // Do not pass API keys, provider tokens or app secrets to package scripts.
    const env: NodeJS.ProcessEnv = {}
    for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']) if (sourceEnv[key]) env[key] = sourceEnv[key]
    if (extension !== '.py') env.ELECTRON_RUN_AS_NODE = '1'
    const log = await new Promise<string>((resolve, reject) => {
      const child = spawn(extension === '.py' ? 'python3' : process.execPath, [join(cwd, path), ...args], { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
      child.stdin.end()
      let output = '', failure: Error | undefined
      const stop = (error: Error) => { failure ??= error; killLocalProcess(child) }
      const abort = () => stop(new Error('Script execution cancelled'))
      const timer = setTimeout(() => stop(new Error('Script exceeded 120 seconds')), 120000)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      const collect = (data: Buffer) => { output = (output + data.toString()).slice(-16000) }
      child.stdout.on('data', collect); child.stderr.on('data', collect)
      child.once('error', error => { failure = error })
      child.once('close', code => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort)
        if (failure) reject(failure)
        else if (code !== 0) reject(new Error(`Script exited ${code}: ${output}`))
        else resolve(output)
      })
    })
    const generated: { name: string; data: Buffer }[] = []
    let outputBytes = 0
    const root = await realpath(cwd)
    for (const path of outputs) {
      signal?.throwIfAborted()
      const file = join(cwd, path), stat = await lstat(file), resolved = await realpath(file), rel = relative(root, resolved)
      if (stat.isSymbolicLink() || !stat.isFile() || rel.startsWith('..') || isAbsolute(rel) || stat.size > MAX_FILE) throw new Error('Invalid output file or output exceeds 20 MB')
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const data = Buffer.alloc(stat.size + 1)
        let offset = 0
        while (offset < data.length) { const { bytesRead } = await handle.read(data, offset, data.length - offset, offset); if (!bytesRead) break; offset += bytesRead }
        outputBytes += offset
        if (offset > stat.size || outputBytes > MAX_FILE) throw new Error('Outputs changed or exceed 20 MB')
        generated.push({ name: path.split('/').at(-1)!, data: data.subarray(0, offset) })
      } finally { await handle.close() }
    }
    return { log, files: generated }
  } finally { await rm(cwd, { recursive: true, force: true }) }
}
export function createArtifactTools(host: ArtifactHost): AgentTool[] {
  const fileParameters = Type.Object({ name: Type.String({ description: 'File name with extension, e.g. presentation.html.' }), content: Type.String({ description: 'Complete UTF-8 file content, not a summary. Maximum 4 MB.' }) })
  const runParameters = Type.Object({ skillId: Type.String(), path: Type.String({ description: 'Exact packaged .py/.js/.mjs/.cjs script path.' }), args: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })), inputs: Type.Optional(Type.Array(Type.Object({ path: Type.String(), content: Type.String() }), { maxItems: 100 })), outputs: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }) })
  return [
    { name: 'create_file', label: 'Create deliverable', description: 'Create a downloadable UTF-8 deliverable such as an HTML slide deck, Markdown, CSV, JSON or source file. Saves to app-owned storage and returns a clickable file card link; does not overwrite personal files or execute content. Use this to deliver your own work instead of delegating just to save a file.', parameters: fileParameters, execute: async (_id: string, args: Static<typeof fileParameters>, signal?: AbortSignal) => {
      if (typeof args.name !== 'string' || args.name.includes('/') || args.name.includes('\\')) throw new Error('Use a file name, not a path')
      safePath(args.name)
      const data = Buffer.from(args.content)
      if (!data.length || data.length > 4 * 1024 * 1024) throw new Error('File must contain 1 byte to 4 MB of UTF-8 text')
      return result({ file: await host.save(args.name, data, signal), bytes: data.length })
    } },
    { name: 'run_skill_script', label: 'Run skill script', description: 'Run an enabled skill’s packaged Python or JavaScript script on this computer AFTER explicit owner approval. This is NOT an OS sandbox: the script runs with the app user’s access. It receives a temporary copy of the skill and optional text inputs, without inherited API secrets. No shell command interpolation or automatic dependency installation. Maximum 120 seconds; return named relative output files (20 MB combined) as downloadable deliverables. Read the script and relevant instructions first. For plain HTML generation prefer create_file, which needs no script execution.', parameters: runParameters, execute: async (_id: string, args: Static<typeof runParameters>, signal?: AbortSignal) => {
      const raw = (await host.skills()).find(s => s.id === args.skillId && s.enabled)
      if (!raw) throw new Error('Enabled skill not found')
      const skill = validateAgentSkills([raw])[0]
      safePath(args.path)
      if (!['.py', '.js', '.mjs', '.cjs'].includes(extname(args.path)) || !skill.files?.some(f => f.path === args.path)) throw new Error('Packaged Python or JavaScript script not found')
      const fingerprint = JSON.stringify(skill)
      await host.authorize(JSON.stringify({ execution: '本机运行，非操作系统沙箱 / Local execution, not an OS sandbox', skill: skill.name, path: args.path, args: args.args ?? [], inputs: args.inputs ?? [], outputs: args.outputs, sha256: createHash('sha256').update(fingerprint).digest('hex'), script: Buffer.from(skill.files.find(f => f.path === args.path)!.data, 'base64').toString('utf8') }, null, 2), signal)
      signal?.throwIfAborted()
      const current = (await host.skills()).find(s => s.id === args.skillId && s.enabled)
      if (!current || JSON.stringify(validateAgentSkills([current])[0]) !== fingerprint) throw new Error('Skill changed during approval; retry with current files')
      const outcome = await runPackagedScript(skill, args.path, args.args ?? [], args.inputs ?? [], args.outputs, signal)
      const links: string[] = []
      for (const file of outcome.files) links.push(await host.save(file.name, file.data, signal))
      return result({ files: links, log: outcome.log, executed: true })
    } }
  ] as AgentTool[]
}
export const artifactPrompt = 'You can produce deliverables yourself: use create_file to save complete HTML slide decks, documents, CSV, JSON and source text as downloadable file cards. For an applicable skill, read its relevant resources and follow its workflow first. Use run_skill_script only when actual script execution is needed, with owner approval. Installing a skill does not execute it or install dependencies. Do not delegate merely because a task asks for a file or code: use your own available tools first. Delegate only if an essential capability is missing, explain the concrete limitation, and never claim a file exists before a successful tool receipt.'
