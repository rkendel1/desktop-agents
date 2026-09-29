/** Per-agent reasoning depth. `undefined` means "use the default":
 * Foundry's own agents think at `low`; local CLIs keep their own configuration. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = typeof THINKING_LEVELS[number]
export const DEFAULT_CLOUD_THINKING_LEVEL: ThinkingLevel = 'low'

export function thinkingLevel(value?: string | null): ThinkingLevel | undefined {
  if (value === undefined || value === null || value === '' || value === 'default') return undefined
  if (!(THINKING_LEVELS as readonly string[]).includes(value)) throw new Error('Invalid thinking level')
  return value as ThinkingLevel
}

/** Levels each local CLI accepts. Reasoning is mandatory for these tools, so none offers `off`. */
export const LOCAL_THINKING_LEVELS: Record<string, readonly ThinkingLevel[]> = {
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max']
}

export function localThinkingLevels(id?: string): readonly ThinkingLevel[] {
  return (id && LOCAL_THINKING_LEVELS[id]) || []
}

/** Nearest supported level, preferring the next deeper one (mirrors pi-ai clamping). */
export function clampThinking(level: ThinkingLevel, supported: readonly ThinkingLevel[]): ThinkingLevel | undefined {
  if (!supported.length) return undefined
  if (supported.includes(level)) return level
  const index = THINKING_LEVELS.indexOf(level)
  for (let i = index + 1; i < THINKING_LEVELS.length; i++) if (supported.includes(THINKING_LEVELS[i])) return THINKING_LEVELS[i]
  for (let i = index - 1; i >= 0; i--) if (supported.includes(THINKING_LEVELS[i])) return THINKING_LEVELS[i]
  return supported[0]
}

/** CLI arguments for the one-shot runners. Inserted before any `--` prompt delimiter by the caller. */
export function localThinkingArguments(id: string, level?: ThinkingLevel): string[] {
  if (!level) return []
  const effective = clampThinking(level, localThinkingLevels(id))
  if (!effective) return []
  if (id === 'codex') return ['-c', `model_reasoning_effort="${effective}"`]
  if (id === 'claude') return ['--effort', effective]
  return []
}

export function withLocalThinking(id: string, args: string[], level?: ThinkingLevel): string[] {
  const extra = localThinkingArguments(id, level)
  if (!extra.length) return args
  const separator = args.indexOf('--')
  // codex exec reads the prompt from stdin (`-`), so keep the options ahead of it.
  const index = separator >= 0 ? separator : id === 'codex' ? Math.max(1, args.lastIndexOf('-')) : args.length
  return [...args.slice(0, index), ...extra, ...args.slice(index)]
}

export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max'
}
