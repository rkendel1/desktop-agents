import { spawn } from 'node:child_process'
import type { CommandResult } from '../../shared/types'
import { executableCommand } from '../windowsCommand'
import { killLocalProcess } from '../localAgentConnection'
import { spawnEnvironment } from '../shellPath'

export interface RunCommandOptions {
  /** The explicit working directory. There is no default. */
  cwd: string
  signal?: AbortSignal
  timeoutMs?: number
  /** Extra variables on top of the login-shell environment. */
  env?: NodeJS.ProcessEnv
  /** How much of the end of each stream to keep. */
  maxOutput?: number
}

const tail = (text: string, limit: number): string => text.length > limit ? `…${text.slice(-limit)}` : text

/**
 * Run one program in a directory and report what happened.
 *
 * The program is started directly from an argument vector — there is no shell to
 * interpret the arguments. It leads its own process group, and the whole group is
 * killed when the run is cancelled, times out, or finishes: nothing it started
 * can outlive the result. A non-zero exit is a result, not an exception; an
 * exception means the program could not be started at all.
 */
export async function runCommand(argv: string[], options: RunCommandOptions): Promise<CommandResult> {
  if (!argv.length || argv.some(part => typeof part !== 'string' || part.includes('\0')) || !argv[0].trim()) throw new Error('A command needs a program to run.')
  if (!options.cwd) throw new Error('A command needs an explicit working directory.')
  const limit = options.maxOutput ?? 64 * 1024
  const startedAt = Date.now()
  options.signal?.throwIfAborted()
  const environment = { ...await spawnEnvironment(), ...options.env }
  const command = await executableCommand(argv[0])
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command.file, [...command.prefix, ...argv.slice(1)], {
      cwd: options.cwd, env: environment, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = '', stderr = '', cancelled = false, timedOut = false, settled = false
    const stop = (): void => killLocalProcess(child as never)
    const abort = (): void => { cancelled = true; stop() }
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; stop() }, options.timeoutMs) : undefined
    const finish = (result: () => CommandResult | Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      // Whatever the program left running goes with it.
      stop()
      const value = result()
      if (value instanceof Error) reject(value)
      else resolve(value)
    }
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout = tail(stdout + chunk, limit * 2) })
    child.stderr.on('data', (chunk: string) => { stderr = tail(stderr + chunk, limit * 2) })
    child.once('error', error => finish(() => error))
    child.once('close', (exitCode, signal) => finish(() => ({
      argv, exitCode, ...(signal ? { signal } : {}), ...(cancelled ? { cancelled } : {}), ...(timedOut ? { timedOut } : {}),
      startedAt, durationMs: Date.now() - startedAt, stdout: tail(stdout, limit), stderr: tail(stderr, limit)
    })))
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
  })
}
