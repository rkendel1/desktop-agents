import { managedSearchPaths } from './managedNode'
import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { findDesktopApp, validateLocalAgent } from './localAgents'
import { resolveExecutable } from './shellPath'

const execFileAsync = promisify(execFile)

export interface TerminalLaunchResult {
  terminal: 'termany' | 'system'
}

interface TerminalLauncherDependencies {
  platform?: NodeJS.Platform
  validateAgent?: typeof validateLocalAgent
  findApp?: typeof findDesktopApp
  resolveCommand?: typeof resolveExecutable
  execute?: (file: string, args: string[]) => Promise<void>
  spawnDetached?: (file: string, args: string[]) => Promise<void>
  wait?: (milliseconds: number) => Promise<void>
  termanyAutomationAllowed?: boolean
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function defaultExecute(file: string, args: string[]): Promise<void> {
  return execFileAsync(file, args, { timeout: 4_000, windowsHide: true }).then(() => undefined)
}

function defaultSpawnDetached(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

async function openMacSystemTerminal(executable: string, execute: TerminalLauncherDependencies['execute']): Promise<void> {
  const command = shellQuote(executable)
  const script = [
    'tell application "Terminal"',
    'activate',
    `do script ${appleScriptString(command)}`,
    'end tell'
  ].join('\n')
  await execute!('/usr/bin/osascript', ['-e', script])
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Claude's installer uses ~/.local/bin on macOS and Linux. Checking the
 * conventional path first avoids launching every configured login-shell hook
 * just to open a recovery terminal. */
async function resolveClaudeExecutable(
  dependencies: TerminalLauncherDependencies,
  resolveCommand: typeof resolveExecutable
): Promise<string | undefined> {
  if (dependencies.validateAgent) return (await dependencies.validateAgent('claude')).path
  if (dependencies.resolveCommand) {
    return withTimeout(resolveCommand('claude'), 5_000, 'Timed out while locating Claude Code.')
  }

  if ((dependencies.platform ?? process.platform) !== 'win32') {
    const conventionalPath = join(homedir(), '.local', 'bin', 'claude')
    try {
      await access(conventionalPath, constants.X_OK)
      return conventionalPath
    } catch { /* Fall through to the repaired login-shell PATH. */ }
  }

  return withTimeout(resolveCommand('claude'), 5_000, 'Timed out while locating Claude Code.')
}

/** Open a known local agent in an interactive terminal. The renderer supplies
 * only a catalog id; executable resolution and the fixed command stay in the
 * trusted main process so this cannot become an arbitrary shell endpoint. */
export async function openLocalAgentTerminal(
  id: string,
  dependencies: TerminalLauncherDependencies = {}
): Promise<TerminalLaunchResult> {
  if (id !== 'claude') throw new Error('This local agent cannot be opened from an error message.')
  const platform = dependencies.platform ?? process.platform
  const findApp = dependencies.findApp ?? findDesktopApp
  const resolveCommand = dependencies.resolveCommand ?? resolveExecutable
  const execute = dependencies.execute ?? defaultExecute
  const spawnDetached = dependencies.spawnDetached ?? defaultSpawnDetached
  const wait = dependencies.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const executable = await resolveClaudeExecutable(dependencies, resolveCommand)
  if (!executable) throw new Error('Claude Code is not installed.')

  if (platform === 'darwin') {
    // Termany does not currently expose a command/deep-link API, so opening a
    // tab requires macOS Accessibility keyboard automation. Skip that attempt
    // entirely when the app is not trusted; waiting for a doomed osascript
    // request makes the recovery action appear frozen.
    const termany = dependencies.termanyAutomationAllowed === false
      ? undefined
      : await findApp(['Termany.app'])
    if (termany) {
      try {
        await withTimeout(execute('/usr/bin/open', [termany]), 4_500, 'Termany did not open.')
        await wait(550)
        const script = [
          'tell application id "ai.termany.desktop" to activate',
          'delay 0.15',
          'tell application "System Events"',
          'set termanyProcess to first application process whose bundle identifier is "ai.termany.desktop"',
          'set frontmost of termanyProcess to true',
          'tell termanyProcess',
          'keystroke "t" using command down',
          'delay 0.35',
          `keystroke ${appleScriptString(shellQuote(executable))}`,
          'key code 36',
          'end tell',
          'end tell'
        ].join('\n')
        await withTimeout(
          execute('/usr/bin/osascript', ['-e', script]),
          4_500,
          'Termany did not accept the command.'
        )
        return { terminal: 'termany' }
      } catch {
        // Termany may be installed without macOS Automation permission. A
        // working system Terminal is more useful than leaving the click inert.
      }
    }
    await withTimeout(
      openMacSystemTerminal(executable, execute),
      4_500,
      'Terminal did not accept the command.'
    )
    return { terminal: 'system' }
  }

  if (platform === 'win32') {
    const powershell = await resolveCommand('powershell.exe') ?? 'powershell.exe'
    await spawnDetached(powershell, ['-NoExit', '-Command', `& ${powershellQuote(executable)}`])
    return { terminal: 'system' }
  }

  const candidates: Array<[string, string[]]> = [
    ['x-terminal-emulator', ['-e', executable]],
    ['gnome-terminal', ['--', executable]],
    ['konsole', ['-e', executable]],
    ['xterm', ['-e', executable]]
  ]
  for (const [command, args] of candidates) {
    const terminal = await resolveCommand(command)
    if (!terminal) continue
    await spawnDetached(terminal, args)
    return { terminal: 'system' }
  }
  throw new Error('No terminal application was found.')
}

/** Show the exact approved command as data; never evaluate it while printing. */
export function maintenanceShellBody(command: string): string {
  return [
    ...(managedSearchPaths().length ? [`export PATH=${shellQuote(managedSearchPaths().join(':'))}:\"$PATH\"`] : []),
    "printf '\x1b[2J\x1b[H'",
    "printf '%s\n' '本地智能体安装与更新' '即将执行（与确认窗口一致）：'",
    `printf '\n  %s\n\n' ${shellQuote(command)}`,
    command,
    'result=$?',
    'if [ "$result" -eq 0 ]; then',
    "  printf '\n%s\n' '命令执行成功。返回 Foundry 后会重新检测版本。'",
    'else',
    "  printf '\n执行未成功（退出码 %s），请查看上方工具输出。\n' \"$result\"",
    'fi',
    "printf '%s' '按回车关闭此窗口…'",
    'read -r _',
    'exit "$result"'
  ].join('\n')
}

/** Only call with a trusted maintenance command constructed in the main process. */
export async function openMaintenanceTerminal(command: string, dependencies: TerminalLauncherDependencies = {}): Promise<void> {
  const platform = dependencies.platform ?? process.platform
  const execute = dependencies.execute ?? defaultExecute
  const launch = dependencies.spawnDetached ?? defaultSpawnDetached
  if (platform === 'darwin') {
    // Open a private .command file via Launch Services; no Apple Events automation permission.
    const directory = await mkdtemp(join(tmpdir(), 'douchat-maintenance-'))
    const script = join(directory, 'Foundry-Agent-Maintenance.command')
    try {
      await writeFile(script, `#!/bin/bash\ntrap ${shellQuote(`/bin/rm -rf -- ${shellQuote(directory)}`)} EXIT\n${maintenanceShellBody(command)}\n`, { mode: 0o700 })
      await execute('/usr/bin/open', ['-a', 'Terminal', script])
    } catch {
      await rm(directory, { recursive: true, force: true }).catch(() => {})
      throw new Error("Could not open the system terminal. Open Terminal and try again, or copy and run the command from the confirmation dialog.")
    }
    return
  }
  if (platform === 'win32') {
    await launch('powershell.exe', ['-NoProfile', '-NoExit', '-EncodedCommand', Buffer.from(`$env:Path = ${powershellQuote(managedSearchPaths().join(';') + ';')} + [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path\nClear-Host\nWrite-Host '本地智能体安装与更新'\nWrite-Host '即将执行（与确认窗口一致）：'\nWrite-Host ${powershellQuote(command)}\n$global:LASTEXITCODE = 0\n${command}\n$douchatSucceeded = $?\nif ($douchatSucceeded -and $LASTEXITCODE -eq 0) { Write-Host '命令执行成功。返回 Foundry 后会重新检测版本。' } else { Write-Host '执行未成功，请查看上方工具输出。' }`, 'utf16le').toString('base64')])
    return
  }
  for (const name of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) {
    const executable = await (dependencies.resolveCommand ?? resolveExecutable)(name)
    if (!executable) continue
    await launch(executable, [name === 'gnome-terminal' ? '--' : '-e', 'bash', '-lc', maintenanceShellBody(command)])
    return
  }
  throw new Error('No terminal application was found.')
}
