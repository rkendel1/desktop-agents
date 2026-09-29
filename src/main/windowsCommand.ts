import { readFile, access } from 'node:fs/promises'
import { win32 } from 'node:path'
import { resolveExecutable } from './shellPath'

/** Run npm's Windows shim through Node without passing user prompts to cmd.exe. */
export async function executableCommand(file: string, platform = process.platform): Promise<{ file: string; prefix: string[] }> {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(file)) return { file, prefix: [] }
  const source = await readFile(file, 'utf8')
  const script = npmShimScript(source, file)
  if (!script) throw new Error('This Windows .cmd launcher is not a supported npm shim. Configure the agent’s executable (.exe) instead.')
  await access(script)
  const node = await resolveExecutable('node.exe')
  if (!node) throw new Error('Node.js is required to run this Windows local agent. Install Node.js and restart Foundry.')
  return { file: node, prefix: [script] }
}

export function npmShimScript(source: string, file: string): string | undefined {
  const match = source.match(/"%(?:dp0|~dp0)%?[\\/]([^"\r\n]+\.(?:[cm]?js))"/i)
  return match ? win32.resolve(win32.dirname(file), match[1]) : undefined
}
