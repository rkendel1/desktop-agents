export interface DecisionSettings {
  healthCheckIntervalSeconds?: number
  mode: 'leader' | 'model' | 'llm' | 'jev'
  providerId: string
  model: string
}

export const DEFAULT_DECISION_SETTINGS: DecisionSettings = {
  mode: 'leader', providerId: '', model: ''
}

export function validateDecisionSettings(value: DecisionSettings): DecisionSettings {
  if (value?.healthCheckIntervalSeconds !== undefined && (!Number.isInteger(value.healthCheckIntervalSeconds)
    || value.healthCheckIntervalSeconds < 30 || value.healthCheckIntervalSeconds > 3600)) throw new Error('Health check interval must be between 30 and 3600 seconds.')
  if (!value || !['leader', 'model', 'llm', 'jev'].includes(value.mode)
    || typeof value.providerId !== 'string' || typeof value.model !== 'string') throw new Error('Invalid group decision settings.')
  if (value.mode !== 'leader' && (!/^[a-zA-Z0-9-]{1,80}$/.test(value.providerId)
    || !value.model.trim() || value.model.length > 200)) throw new Error('Select a decision provider and enter a model ID.')
  return { mode: value.mode === 'leader' ? 'leader' : 'model', providerId: value.providerId, model: value.model.trim(),
    ...(value.healthCheckIntervalSeconds !== undefined ? { healthCheckIntervalSeconds: value.healthCheckIntervalSeconds } : {}) }
}

/** Both current UI and legacy modes use the protocol of the configured model. */
export function decisionProtocol(model: string): 'jev' | 'chat' {
  return /^(?:(?:~)?typesafe\/)?jev(?:[-/:]|$)/i.test(model.trim()) ? 'jev' : 'chat'
}

export function decisionJson(text: string): unknown {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try { return JSON.parse(stripped) }
  catch { throw new Error('The model returned invalid JSON.') }
}
