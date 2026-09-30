import { readFile, realpath } from 'node:fs/promises'
import { dirname, win32 } from 'node:path'
import { managedNodePaths, selectNodeEnvironment } from './managedNode'
import { resolveExecutable } from './shellPath'
import { npmShimScript } from './windowsCommand'
import type { LocalAgent } from '../shared/types'

const guides: Record<string, string> = {
  claude: 'https://code.claude.com/docs/en/setup', codex: 'https://github.com/openai/codex',
  gemini: 'https://geminicli.com/docs/get-started/installation/', opencode: 'https://opencode.ai/docs/',
  grok: 'https://github.com/xai-org/grok-build', openclaw: 'https://docs.openclaw.ai/install',
  hermes: 'https://hermes-agent.nousresearch.com/docs/getting-started/quickstart',
  cursor: 'https://docs.cursor.com/en/cli/installation', kimi: 'https://github.com/MoonshotAI/kimi-cli',
  fastclaw: 'https://github.com/fastclaw-ai/fastclaw'
}
const packages: Record<string, string> = { codex: '@openai/codex', gemini: '@google/gemini-cli', opencode: 'opencode-ai', claude: '@anthropic-ai/claude-code', openclaw: 'openclaw' }
// Official installers also replace an existing standalone installation.
function installer(id: string, platform: NodeJS.Platform): string | undefined {
  const windows = platform === 'win32'
  const scripts: Record<string, [string, string]> = {
    grok: ['https://x.ai/cli/install.sh', 'https://x.ai/cli/install.ps1'],
    hermes: ['https://hermes-agent.nousresearch.com/install.sh', 'https://hermes-agent.nousresearch.com/install.ps1'],
    kimi: ['https://code.kimi.com/kimi-code/install.sh', 'https://code.kimi.com/kimi-code/install.ps1'],
    fastclaw: ['https://raw.githubusercontent.com/fastclaw-ai/fastclaw/main/install.sh', 'https://raw.githubusercontent.com/fastclaw-ai/fastclaw/main/install.ps1'],
    omp: ['https://omp.sh/install', 'https://omp.sh/install.ps1'],
    cursor: ['https://cursor.com/install', 'https://cursor.com/install?win32=true']
  }
  if (id === 'openclaw') return `${windows ? 'npm.cmd' : 'npm'} install -g openclaw@latest`
  const script = scripts[id]
  if (!script) return undefined
  return windows ? `irm '${script[1]}' | iex` : `curl -fsSL ${script[0]} | ${id === 'omp' ? 'sh' : 'bash'}`
}
export interface MaintenancePlan { command?: string; guide?: string; npmPackage?: string; npmPrefix?: string }
export function maintenancePlan(agent: LocalAgent, platform: NodeJS.Platform, resolvedPath = agent.path ?? ''): MaintenancePlan {
  if (agent.custom) return {}
  const guide = guides[agent.id]
  const quote = (s: string) => platform === 'win32' ? `'${s.replaceAll("'", "''")}'` : `'${s.replaceAll("'", "'\\''")}'`
  const invoke = (s: string) => `${platform === 'win32' ? '& ' : ''}${quote(s)}`
  if (!agent.installed) {
    if (agent.id === 'claude') return { guide, command: platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash' }
    if (packages[agent.id]) return { guide, npmPackage: packages[agent.id], command: `${platform === 'win32' ? 'npm.cmd' : 'npm'} install -g ${packages[agent.id]}@latest` }
    return { guide, npmPackage: agent.id === 'openclaw' ? 'openclaw' : undefined, command: installer(agent.id, platform) }
  }
  const normalized = resolvedPath.replaceAll('\\', '/')
  if (platform === 'win32' && agent.id === 'claude' && /\/Microsoft\/WinGet\/Packages\/Anthropic\.ClaudeCode_/i.test(normalized)) {
    return { guide, command: 'winget upgrade --id Anthropic.ClaudeCode --exact' }
  }
  const brew = normalized.match(/^(.*)\/(?:Cellar|Caskroom)\/(codex|gemini-cli|claude-code(?:@latest)?|opencode|openclaw|omp)\//)
  if (brew) return { guide, command: `${invoke(`${brew[1]}/bin/brew`)} upgrade ${brew[2]}` }
  if (packages[agent.id] && normalized.includes(`/node_modules/${packages[agent.id]}/`) && agent.path) {
    // Custom npm global prefixes often contain CLI links but no npm executable.
    // Explicitly target the existing prefix instead of npm's current global default.
    const prefix = platform === 'win32' ? win32.dirname(agent.path) : dirname(dirname(agent.path))
    return { guide, npmPackage: packages[agent.id], npmPrefix: prefix, command: `${platform === 'win32' ? 'npm.cmd' : 'npm'} install --global --prefix ${quote(prefix)} ${packages[agent.id]}@latest` }
  }
  if (agent.id === 'claude' && agent.path && (/\/\.local\/share\/claude\/versions\//.test(normalized) || (platform === 'win32' && /\.exe$/i.test(agent.path)))) return { guide, command: `${invoke(agent.path)} update` }
  const updates: Record<string, string> = { openclaw: 'update', hermes: 'update', opencode: 'upgrade', cursor: 'update', kimi: 'upgrade' }
  if (agent.path && updates[agent.id]) return { guide, command: `${invoke(agent.path)} ${updates[agent.id]}` }
  if (agent.id === 'omp' && normalized.includes('/node_modules/@oh-my-pi/pi-coding-agent/')) return { guide, command: 'bun install -g @oh-my-pi/pi-coding-agent@latest' }
  return { guide, command: installer(agent.id, platform) }
}
export async function resolveMaintenancePlan(agent: LocalAgent, platform = process.platform): Promise<MaintenancePlan> {
  let resolved = agent.path ? await realpath(agent.path).catch(() => agent.path!) : ''
  // Windows npm launchers are files, not symlinks. Inspect their target without executing them.
  if (platform === 'win32' && agent.path && /\.(cmd|bat)$/i.test(agent.path)) {
    const source = await readFile(agent.path, 'utf8').catch(() => '')
    resolved = npmShimScript(source, agent.path) ?? resolved
  }
  return maintenancePlan(agent, platform, resolved)
}

/** Select paths before confirmation so the displayed command is the command executed. */
export async function prepareNpmMaintenance(plan: MaintenancePlan): Promise<MaintenancePlan & { needsDownload?: boolean }> {
  if (!plan.npmPackage) return plan
  const environment = await selectNodeEnvironment(resolveExecutable)
  const paths = managedNodePaths()
  const prefix = plan.npmPrefix ?? paths.prefix
  const windows = process.platform === 'win32'
  const quote = (value: string) => windows ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`
  const bin = windows ? win32.dirname(environment.node) : dirname(environment.node)
  const pathSetup = windows ? `$env:Path = ${quote(bin + ';')} + $env:Path` : `export PATH=${quote(bin)}:"$PATH"`
  const command = `${pathSetup}\n${windows ? '& ' : ''}${quote(environment.node)} ${quote(environment.npm)} install --global --prefix ${quote(prefix)} ${plan.npmPackage}@latest`
  return { ...plan, command, npmPrefix: prefix, needsDownload: environment.needsDownload }
}
