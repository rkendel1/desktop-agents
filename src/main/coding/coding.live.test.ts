import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { ComputerProvider } from '../computer'
import { startDesktop, stopDesktop } from '../desktop'
import type { SecretCodec } from '../credentialVault'
import { DouchatRuntime } from '../runtime'
import { CodingService } from './service'

/**
 * Opt-in: drives a real, installed agent CLI (and so a real model) through the
 * same path as the deterministic tests. Run it with
 *   DOUCHAT_LIVE_CODING=claude npx vitest run src/main/coding/coding.live.test.ts
 * (or `codex`). It is skipped otherwise, because it needs a logged-in CLI, the
 * network and a model that may spend credits.
 */
const cli = process.env.DOUCHAT_LIVE_CODING
const codec: SecretCodec = { available: () => true, encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() }
const idleComputer = { snapshots: () => [], start: async () => undefined, stop: async () => undefined, show: async () => undefined, createTools: () => [], dispose: () => undefined } as unknown as ComputerProvider
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'Edit', 'MultiEdit', 'Write'])
const SAFE_COMMAND = /^(npm test( 2>&1)?( \| (head|tail)( -n? ?\d+)?)?|git (status|diff)( .*)?|ls( .*)?|cat [\w./-]+)$/

it.skipIf(!cli)('a real agent CLI fixes a bug in a real repository through Foundry', async () => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'coding-live-repo-'))); directories.push(path)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'coding-live-desktop-'))); directories.push(root)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf8' })
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T')
  mkdirSync(join(path, 'src'))
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node test.js' } }))
  writeFileSync(join(path, 'src', 'math.js'), 'function add(a, b) {\n  return a - b\n}\nmodule.exports = { add }\n')
  writeFileSync(join(path, 'test.js'), "const { add } = require('./src/math')\nif (add(2, 3) !== 5) { console.error('add(2, 3) should be 5'); process.exit(1) }\nconsole.log('ok')\n")
  git('add', '-A'); git('commit', '-q', '-m', 'initial')

  const desktop = await startDesktop({ userData: root, codec })
  const runtime = new DouchatRuntime(desktop.repository, idleComputer, () => undefined)
  const coding = new CodingService(desktop.repository, runtime)
  try {
    const agent = await desktop.repository.createAgent({ name: `Live ${cli}`, role: 'Engineer', instructions: '', color: '#0b5cff', localAgentId: cli!, provider: 'local', model: 'default' })
    const project = await coding.addProject(path, 'Live fixture')
    const session = await coding.start({ projectId: project.id, agentId: agent.id, task: 'The test in this repository (npm test) fails. Fix the bug in src/math.js so it passes. Change only that file. Reply with one sentence.' })
    const approvals: string[] = []
    const answering = (async () => {
      for (;;) {
        if ((await desktop.repository.codingSession(session.id))?.status !== 'running') return
        for (const request of runtime.ephemeralState().permissionRequests) {
          const details = (() => { try { return JSON.parse(request.details ?? '{}') as { tool?: string; input?: { command?: string } } } catch { return {} } })()
          const allowed = READ_ONLY_TOOLS.has(details.tool ?? '') || (details.tool === 'Bash' && SAFE_COMMAND.test(details.input?.command?.trim() ?? ''))
          approvals.push(`${allowed ? 'allow' : 'deny'} ${details.tool} ${details.input?.command ?? ''}`.trim())
          runtime.resolveAgentPermission(request.id, allowed)
        }
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    })()
    const finished = (await coding.settled(session.id))!
    await answering
    console.log('LIVE', JSON.stringify({ status: finished.status, error: finished.error, result: finished.result?.slice(0, 300), changes: finished.changes, approvals }))
    expect(finished.status).toBe('succeeded')
    expect(readFileSync(join(path, 'src', 'math.js'), 'utf8')).toContain('a + b')
  } finally {
    runtime.stopAccepting(); await coding.cancelAll(); runtime.cancelAll(); await coding.idle(); await runtime.idle(); await stopDesktop(desktop)
  }
}, 240_000)
