import { spawnSync } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { maintenancePlan } from './localAgentMaintenance'
import { npmShimScript } from './windowsCommand'
import { maintenanceShellBody, openMaintenanceTerminal } from './terminalLauncher'
import type { LocalAgent } from '../shared/types'
const agent = (id: string, path?: string) => ({ id, path, installed: Boolean(path), name: id } as LocalAgent)
describe('local agent maintenance', () => {
  it.each([['codex', '@openai/codex'], ['gemini', '@google/gemini-cli'], ['claude', '@anthropic-ai/claude-code']])('updates the existing Windows npm prefix for %s', (id, pkg) => {
    const prefix = "C:\\Users\\小明 O'Brien\\AppData\\Roaming\\npm"
    const launcher = `${prefix}\\${id}.cmd`
    const target = npmShimScript(`"%_prog%" "%dp0%\\node_modules\\${pkg.replaceAll('/', '\\')}\\bin\\cli.js" %*`, launcher)
    expect(target).toBeTruthy()
    expect(maintenancePlan(agent(id, launcher), 'win32', target).command).toBe(`npm.cmd install --global --prefix '${prefix.replaceAll("'", "''")}' ${pkg}@latest`)
    expect(maintenancePlan(agent(id), 'win32').command).not.toMatch(/^npm /)
  })
  it('updates native Windows Claude and preserves WinGet installations', () => {
    expect(maintenancePlan(agent('claude', 'C:\\Users\\A B\\.local\\bin\\claude.exe'), 'win32').command).toBe("& 'C:\\Users\\A B\\.local\\bin\\claude.exe' update")
    expect(maintenancePlan(agent('claude', 'C:\\bin\\claude.exe'), 'win32', 'C:\\Users\\A\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_test\\claude.exe').command).toBe('winget upgrade --id Anthropic.ClaudeCode --exact')
    expect(maintenancePlan(agent('codex', 'C:\\unknown\\codex.cmd'), 'win32').command).toBeUndefined()
  })
  it.each(['darwin', 'linux', 'win32'] as const)('provides terminal commands for the remaining catalog on %s', (platform) => {
    for (const id of ['grok', 'openclaw', 'hermes', 'opencode', 'cursor', 'kimi', 'omp', 'fastclaw']) {
      expect(maintenancePlan(agent(id), platform).command, `${id} install`).toBeTruthy()
      const path = platform === 'win32' ? `C:\\Users\\Test User\\bin\\${id}.exe` : `/tmp/Test User/bin/${id}`
      expect(maintenancePlan(agent(id, path), platform).command, `${id} update`).toBeTruthy()
    }
    const path = platform === 'win32' ? 'C:\\Users\\Test User\\kimi.exe' : '/tmp/Test User/kimi'
    expect(maintenancePlan(agent('kimi', path), platform).command).toBe(`${platform === 'win32' ? '& ' : ''}'${path}' upgrade`)
  })
  it('selects official platform installers and does not guess unknown update channels', () => {
    expect(maintenancePlan(agent('claude'), 'win32').command).toContain('install.ps1')
    expect(maintenancePlan(agent('claude'), 'darwin').command).toContain('install.sh')
    expect(maintenancePlan(agent('gemini'), 'linux').command).toBe('npm install -g @google/gemini-cli@latest')
    expect(maintenancePlan(agent('codex', '/usr/bin/codex'), 'linux').command).toBeUndefined()
    expect(maintenancePlan({ ...agent('custom:a'), custom: true }, 'linux')).toEqual({})
  })
  it('updates through the detected package manager and quotes executable paths', () => {
    expect(maintenancePlan(agent('codex', '/opt/homebrew/bin/codex'), 'darwin', '/opt/homebrew/Caskroom/codex/1/codex').command).toBe("'/opt/homebrew/bin/brew' upgrade codex")
    expect(maintenancePlan(agent('codex', "/tmp/a'b/bin/codex"), 'linux', '/tmp/lib/node_modules/@openai/codex/bin/codex.js').command).toBe("npm install --global --prefix '/tmp/a'\\''b' @openai/codex@latest")
  })
  it('launches visible system terminals with intact command text', async () => {
    let script = ''
    const execute = vi.fn(async (_file: string, args: string[]) => {
      script = await readFile(args[2], 'utf8')
      await rm(dirname(args[2]), { recursive: true, force: true })
    })
    const spawnDetached = vi.fn().mockResolvedValue(undefined)
    const command = 'npm install -g @openai/codex@latest'
    await openMaintenanceTerminal(command, { platform: 'darwin', execute })
    expect(execute.mock.calls[0][0]).toBe('/usr/bin/open')
    expect(execute.mock.calls[0][1].slice(0, 2)).toEqual(['-a', 'Terminal'])
    expect(script).toContain(command)
    expect(script).toContain('trap ')
    await openMaintenanceTerminal(command, { platform: 'win32', spawnDetached })
    const args = spawnDetached.mock.calls[0][1]
    expect(args).toContain('-NoExit')
    expect(Buffer.from(args.at(-1), 'base64').toString('utf16le')).toContain(command)
    expect(Buffer.from(args.at(-1), 'base64').toString('utf16le')).toContain("GetEnvironmentVariable('Path', 'User')")
    await openMaintenanceTerminal(command, { platform: 'linux', spawnDetached, resolveCommand: async (name) => name === 'xterm' ? '/usr/bin/xterm' : undefined })
    expect(spawnDetached.mock.calls[1][1]).toContain(maintenanceShellBody(command))
  })
})

it.skipIf(process.platform === 'win32')('prints the approved command literally and preserves failure status', () => {
  const command = "printf '%s' 'literal $(echo NOT_EXECUTED)' ; false"
  const result = spawnSync('/bin/bash', ['-c', maintenanceShellBody(command)], { input: '\n', encoding: 'utf8' })
  expect(result.stdout).toContain(command)
  expect(result.stdout).toContain('literal $(echo NOT_EXECUTED)')
  expect(result.stdout).toContain('Installation failed (exit code 1)')
  expect(result.status).toBe(1)
})
