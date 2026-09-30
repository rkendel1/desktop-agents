import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions } from '@earendil-works/pi-ai'
import type { ModelCandidate, ModelDecision, ModelRequest, ModelRequirements } from '../../shared/modelFabric'
import type { ModelFabric } from './fabric'
import { classifyError, ModelRoutingError } from './router'

/**
 * What a request needs, read from the request itself: tools in the context need a model that can call tools, an image needs vision, and
 * the context needs to fit. (Whether it is “coding” is the caller’s to say; nothing here guesses.)
 */
export function requirementsOf(context: Context, extra: ModelRequirements = {}): ModelRequirements {
  const images = context.messages.some(message => Array.isArray(message.content) && message.content.some(part => (part as { type?: string }).type === 'image'))
  const characters = (context.systemPrompt?.length ?? 0) + JSON.stringify(context.messages).length + JSON.stringify(context.tools ?? []).length
  return { ...(context.tools?.length ? { toolUse: true } : {}), ...(images ? { vision: true } : {}), minimumContextTokens: Math.ceil(characters / 3) + 2048, ...extra }
}

export interface RoutedStreamInput {
  fabric: ModelFabric
  request: ModelRequest
  context: Context
  options?: SimpleStreamOptions
  /** Start the stream for a candidate on Foundry’s existing model path. `undefined`: this candidate cannot be started here. */
  open: (candidate: ModelCandidate, context: Context, options?: SimpleStreamOptions) => { model: Model<any>; stream: AssistantMessageEventStream } | undefined
  /** Told once when the request is finished, with everything that was tried. */
  onDecision?: (decision: ModelDecision) => void
}

const failureMessage = (text: string, model: Model<any>): AssistantMessage => ({ role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, stopReason: 'error', errorMessage: text, timestamp: Date.now(),
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as unknown as AssistantMessage)

/**
 * Stream one request through the fabric. Each candidate is opened in turn; events are held until the model produces its first content
 * (or ends), so a rate limit, timeout or capacity failure *before any output* moves on to the next eligible model and the caller sees
 * one uninterrupted stream. Once output has started it is passed through — it cannot be unsaid — and a later failure is reported
 * as it happened. If nothing eligible is left the stream ends with a clear error, never with a widened cost policy.
 */
export function routedStream(input: RoutedStreamInput): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream()
  const signal = input.options?.signal
  void (async () => {
    let placeholder: Model<any> | undefined
    try {
      const { value, decision } = await input.fabric.route<{ model: Model<any>; buffered: AssistantMessageEvent[]; rest: AsyncIterator<AssistantMessageEvent>; finished: boolean }>(input.request, async candidate => {
        const opened = input.open(candidate, input.context, input.options)
        if (!opened) throw Object.assign(new Error(`${candidate.id} cannot be started here`), { status: 503 })
        placeholder = opened.model
        const rest = opened.stream[Symbol.asyncIterator]()
        const buffered: AssistantMessageEvent[] = []
        for (;;) {
          const next = await rest.next()
          if (next.done) return { value: { model: opened.model, buffered, rest, finished: true } }
          const event = next.value
          if (event.type === 'error' && !buffered.some(item => item.type !== 'start')) {
            // Failed before producing anything: this is what cycling is for.
            const message = event.error.errorMessage ?? 'The model returned an error.'
            throw Object.assign(new Error(message), { ...(event.error.stopReason === 'aborted' ? { aborted: true } : {}) })
          }
          buffered.push(event)
          if (event.type !== 'start') return { value: { model: opened.model, buffered, rest, finished: event.type === 'done' || event.type === 'error' } }
        }
      }, { ...(signal ? { signal } : {}), classify: (_candidate, error) => classifyError(error) })
      input.onDecision?.(decision)
      for (const event of value.buffered) out.push(event)
      if (!value.finished) for (;;) { const next = await value.rest.next(); if (next.done) break; out.push(next.value) }
      out.end()
    } catch (error) {
      if (error instanceof ModelRoutingError) input.onDecision?.(error.decision)
      const text = error instanceof Error ? error.message : String(error)
      const model = placeholder ?? ({ api: 'foundry-fabric', provider: 'foundry', id: 'unavailable' } as Model<any>)
      const message = signal?.aborted ? { ...failureMessage('Request aborted', model), stopReason: 'aborted' as const } : failureMessage(text, model)
      out.push({ type: 'error', reason: message.stopReason === 'aborted' ? 'aborted' : 'error', error: message } as AssistantMessageEvent)
      out.end()
    }
  })()
  return out
}
