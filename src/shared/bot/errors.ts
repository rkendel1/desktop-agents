/**
 * A CLI agent reports a failure as its echoed transcript followed by a run of
 * `ERROR:` segments — the retries first, then the real cause, usually repeated
 * verbatim. Pasting all of that into the thread buries the one line a person
 * can act on, so the chat shows a headline and keeps the raw text behind a
 * disclosure.
 */

export interface RuntimeErrorSummary {
  /** One line naming what went wrong and the facts needed to fix it. */
  title: string
  /** A plain-language next step that can stay visible while details are folded. */
  guidance?: string
  /** A tightly scoped recovery action rendered beside diagnostic controls. */
  action?:
    | { kind: 'open-local-agent-terminal'; agentId: 'claude'; label: 'Open Claude Code' }
    | { kind: 'update-local-agent'; agentId: 'grok'; label: 'Update Grok' }
  /** The untouched original, for the details disclosure. */
  detail: string
}

const OPEN_CLAUDE: RuntimeErrorSummary['action'] = {
  kind: 'open-local-agent-terminal',
  agentId: 'claude',
  label: 'Open Claude Code'
}

const RETRY = /^Reconnecting\b/i
const TITLE_LIMIT = 180

/** Only failures that can disappear when the same model turn is resumed.
 * Validation, authentication, quota, and context-window failures deliberately
 * stay terminal: retrying those would repeat the same request and may charge or
 * execute work twice without helping the person. */
export function isRetryableRuntimeError(raw: string | undefined): boolean {
  if (!raw) return false
  if (/\b(?:400|401|403|404|409|413|422)\b|context(?:_| )length|too many tokens|request body exceeds|insufficient_quota|quota exceeded|billing/i.test(raw)) {
    return false
  }
  return /request (?:was )?aborted|stream_interrupted|upstream_unreachable|stream ended without|fetch failed|network.?error|connection (?:reset|lost|closed)|socket hang up|econnreset|enotfound|eai_again|etimedout|timed? out|\b(?:429|500|502|503|504|524)\b/i.test(raw)
}

export function summarizeRuntimeError(raw: string): RuntimeErrorSummary {
  const detail = String(raw ?? '').trim()
  const flat = detail.replace(/\s+/g, ' ')
  if (!flat) return { title: 'The conversation could not finish.', detail }

  const localAgent = localAgentFailure(flat)
  if (localAgent) return { ...localAgent, detail }

  const segments = flat
    .split(/ERROR:\s*/i)
    .slice(1)
    .map((part) => part.trim())
    .filter(Boolean)
  const retries = segments.filter((part) => RETRY.test(part)).length
  const causes = segments.filter((part) => !RETRY.test(part))
  // The last real cause wins: earlier ones are retries of the same call.
  const source = causes[causes.length - 1] ?? (segments.length ? '' : flat)

  const status = statusCode(source)
  const facts = [
    status ? `HTTP ${status}` : '',
    field(source, 'Provider'),
    field(source, 'model'),
    reason(source),
    retries ? `after ${retries} ${retries === 1 ? 'retry' : 'retries'}` : ''
  ].filter(Boolean)

  const headline = describe(source, status, retries)
  return { title: clip(facts.length ? `${headline} · ${facts.join(' · ')}` : headline), detail }
}

function localAgentFailure(source: string): Omit<RuntimeErrorSummary, 'detail'> | undefined {
  if (/^Gemini: Image generation failed\./i.test(source)) {
    if (/No valid API key|NANOBANANA_API_KEY.*(?:missing|not set)|API key.*(?:not found|missing)/i.test(source)) return {
      title: 'Gemini image generation needs an API key',
      guidance: 'Configure a Google AI Studio key locally with gemini extensions config nanobanana, then retry. Do not paste the key in chat.'
    }
    return {
      title: 'Gemini did not generate an image',
      guidance: 'The image tool failed or was denied. This task has stopped; see details for the reason.'
    }
  }
  if (/^Gemini: (?:Incomplete event stream|Gemini stopped before completing)/i.test(source)) return {
    title: 'Gemini stopped before completing the task',
    guidance: 'This task is no longer running. See details before trying again.'
  }
  if (/\bOMP:/i.test(source) && /credit balance is too low.*Anthropic API/i.test(source)) {
    return {
      title: 'OMP’s Anthropic API credit is insufficient',
      guidance: 'Select the model you use in OMP, or top up that provider’s API balance. Douchat credits do not cover local agent usage.'
    }
  }
  if (/^Grok: Image generation failed\./i.test(source)) {
    return {
      title: 'Grok did not generate an image',
      guidance: 'The image tool failed or was denied. This task has stopped; see details for the reason.'
    }
  }
  if (/^Grok(?::)? .*stopped before completing the task/i.test(source)) {
    return {
      title: 'Grok stopped before completing the task',
      guidance: 'This task is no longer running. See details before trying again.'
    }
  }
  if (/openclaw/i.test(source) && /No route-compatible authentication source is configured/i.test(source)) {
    return {
      title: 'OpenClaw cannot authenticate with the selected model',
      guidance: 'Configure authentication for this model in OpenClaw, or select a model already configured there, then try again.'
    }
  }
  if (/openclaw/i.test(source) && /schema version|migrate session identities/i.test(source) && /doctor --fix/i.test(source)) {
    return {
      title: 'OpenClaw needs a local data upgrade',
      guidance: 'Stop active OpenClaw tasks, run openclaw doctor --fix in Terminal, then try again.'
    }
  }
  if (/cursor/i.test(source) && /workspace trust required/i.test(source)) {
    return {
      title: 'Cursor needs workspace trust',
      guidance: 'Cursor could not start in the temporary chat workspace. Update Douchat and try again.'
    }
  }
  if (/grok|runtime-socket deny|socket deny resolution/i.test(source) && /sandbox|runtime-socket deny/i.test(source)) {
    const socket = /socket.*symlink|runtime-socket deny.*symlink/i.test(source)
    return {
      title: socket ? 'Grok cannot start with the current Docker socket setup' : 'Grok could not start its sandbox',
      guidance: socket
        ? 'Grok’s sandbox rejected a Docker socket link before the conversation started. Try updating Grok. If it still fails, use another agent while this compatibility issue is resolved.'
        : 'Grok stopped before the conversation started because its sandbox could not be applied. Try updating Grok; technical details are available below.',
      action: { kind: 'update-local-agent', agentId: 'grok', label: 'Update Grok' }
    }
  }
  const claude = /\bClaude Code\b/i.test(source)
  if (!claude) return undefined

  if (/ENOENT|command not found|not (?:installed|found)|no such file or directory/i.test(source)) {
    return {
      title: 'Claude Code could not be found',
      guidance: 'Install Claude Code, then open Settings → Local agents and detect it again.'
    }
  }
  if (/not logged in|not signed in|log in first|login required|authentication required|unauthori[sz]ed|invalid (?:api )?key|missing (?:api )?key|run \/login/i.test(source)) {
    return {
      title: 'Claude Code is not signed in',
      guidance: 'Open Claude Code in Terminal and sign in, then return to Douchat and try again.',
      action: OPEN_CLAUDE
    }
  }
  if (/credit balance (?:is )?too low|insufficient (?:credit|credits|quota)|out of credits|quota exceeded|usage limit (?:is )?(?:reached|exceeded)|billing required/i.test(source)) {
    return {
      title: 'Claude Code does not have enough credit',
      guidance: 'Open Claude Code in Terminal and add credit or switch to an account with available usage, then return to Douchat and try again.',
      action: OPEN_CLAUDE
    }
  }
  if (/exited with status|exit(?:ed)? code|failed to start|spawn .*EACCES/i.test(source)) {
    return {
      title: 'Claude Code could not start',
      guidance: 'Open Claude Code in Terminal once. Finish signing in or fix the error shown there, then return to Douchat and try again.',
      action: OPEN_CLAUDE
    }
  }
  return undefined
}

function describe(source: string, status: number | undefined, retries: number): string {
  if (status === 401 || status === 403) return 'The model endpoint rejected the request'
  if (status === 404) return 'The model endpoint was not found'
  if (status === 408 || status === 504) return 'The model endpoint timed out'
  if (status === 429) return 'The provider is rate limiting this key'
  if (status && status >= 500) return 'The provider returned a server error'
  if (/\b(?:EACCES|EPERM)\b|operation not permitted|permission denied|needs permission to access/i.test(source)) {
    return 'Douchat does not have permission to access that local file or folder'
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|fetch failed/i.test(source)) {
    return 'Could not reach the model endpoint'
  }
  if (/request (?:was )?aborted|stream_interrupted/i.test(source)) return 'The model connection was interrupted'
  if (!source && retries) return 'Lost the connection to the model endpoint'
  return firstSentence(source) || 'The conversation could not finish'
}

function statusCode(source: string): number | undefined {
  const match =
    /unexpected status (\d{3})/i.exec(source) ??
    /upstream_status:\s*HTTP\/?[\d.]*\s*(\d{3})/i.exec(source) ??
    /\bstatus(?:_code)?[:=]\s*(\d{3})\b/i.exec(source) ??
    /\b(\d{3})\s+(?:Unauthorized|Forbidden|Not Found|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i.exec(
      source
    )
  const code = match ? Number(match[1]) : Number.NaN
  return code >= 100 && code <= 599 ? code : undefined
}

/** Reads a `Name: value` field out of a semicolon-separated tail. */
function field(source: string, name: string): string {
  return new RegExp(`\\b${name}:\\s*([^;,]+)`, 'i').exec(source)?.[1].trim() ?? ''
}

function reason(source: string): string {
  const value = /\bcause:\s*([^;]+?)\s*(?:,\s*url:|;|$)/i.exec(source)?.[1] ?? ''
  return value.trim().replace(/\.$/, '')
}

function firstSentence(source: string): string {
  const stop = source.search(/[.!?](\s|$)/)
  return (stop > 0 ? source.slice(0, stop) : source).trim()
}

function clip(text: string): string {
  return text.length <= TITLE_LIMIT ? text : `${text.slice(0, TITLE_LIMIT - 1).trimEnd()}…`
}
