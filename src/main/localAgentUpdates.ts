import type { LocalAgent } from '../shared/types'

const packages: Record<string, string> = {
  claude: '@anthropic-ai/claude-code', codex: '@openai/codex', gemini: '@google/gemini-cli',
  opencode: 'opencode-ai', openclaw: 'openclaw', omp: '@oh-my-pi/pi-coding-agent'
}
const repositories: Record<string, string> = { hermes: 'NousResearch/hermes-agent', fastclaw: 'fastclaw-ai/fastclaw' }

// Compare numeric components, then SemVer prerelease identifiers. Unknown
// formats must never be reported as current. Build metadata is not a version.
export function compareAgentVersions(current: string, latest: string): number | undefined {
  const parse = (value: string) => value.match(/(?:^|[^0-9A-Za-z])v?(\d+(?:\.\d+){1,3})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?/)
  const a = parse(current), b = parse(latest)
  if (!a || !b) return undefined
  const left = a[1].split('.').map(Number), right = b[1].split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference) return Math.sign(difference)
  }
  if (a[2] === b[2]) return 0
  if (!a[2]) return 1
  if (!b[2]) return -1
  const x = a[2].split('.'), y = b[2].split('.')
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue
    if (x[i] === undefined) return -1
    if (y[i] === undefined) return 1
    const nx = /^\d+$/.test(x[i]), ny = /^\d+$/.test(y[i])
    if (nx && ny) return Math.sign(Number(x[i]) - Number(y[i]))
    if (nx !== ny) return nx ? -1 : 1
    return x[i] < y[i] ? -1 : 1
  }
  return 0
}

export async function latestAgentVersion(id: string): Promise<string | undefined> {
  const url = packages[id] ? `https://registry.npmjs.org/${encodeURIComponent(packages[id])}/latest`
    : repositories[id] ? `https://api.github.com/repos/${repositories[id]}/releases/latest`
      : id === 'kimi' ? 'https://pypi.org/pypi/kimi-cli/json'
        : id === 'grok' ? 'https://x.ai/cli/stable'
          : id === 'cursor' ? 'https://cursor.com/install' : undefined
  if (!url) return undefined
  const response = await fetch(url, { signal: AbortSignal.timeout(3500), headers: { 'User-Agent': 'Foundry' } })
  if (!response.ok) return undefined
  if (id === 'grok') return (await response.text()).trim()
  // Read the official installer as text only; never execute it to check updates.
  if (id === 'cursor') return (await response.text()).match(/FINAL_DIR="[^"\n]*\/versions\/([^"/]+)"/)?.[1]
  const data = await response.json() as { version?: string; tag_name?: string; info?: { version?: string } }
  const version = packages[id] ? data.version : id === 'kimi' ? data.info?.version : data.tag_name
  return typeof version === 'string' ? version : undefined
}

export async function checkLocalAgentUpdates(agents: LocalAgent[], latest = latestAgentVersion): Promise<LocalAgent[]> {
  return Promise.all(agents.map(async agent => {
    if (!agent.installed || agent.custom) return agent
    const latestVersion = await latest(agent.id).catch(() => undefined)
    const comparison = agent.version && latestVersion ? compareAgentVersions(agent.version, latestVersion) : undefined
    // Cursor uses date + commit hash rather than SemVer. Different builds on
    // the same day have no reliable ordering, so leave their status unknown.
    const ambiguousCursor = agent.id === 'cursor' && comparison !== 0
      && agent.version?.match(/\d+\.\d+\.\d+/)?.[0] === latestVersion?.match(/\d+\.\d+\.\d+/)?.[0]
    return { ...agent, latestVersion, updateStatus: comparison === undefined || ambiguousCursor ? 'unknown' as const
      : comparison < 0 ? 'available' as const : 'current' as const }
  }))
}
