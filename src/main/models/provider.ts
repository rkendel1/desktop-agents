import type { ModelCandidate, ModelHealthSnapshot, ModelRequest, ProviderId } from '../../shared/modelFabric'
import type { ClassifiedError } from './router'

export interface ModelResponse { text: string; raw?: unknown }
export interface ModelInvocation extends ModelRequest { payload: unknown }

/**
 * The provider-neutral adapter. The router never learns what a provider is: it asks for candidates, and — only for a candidate the
 * cost policy has admitted — asks the provider to invoke one. An adapter reuses whatever integration Foundry already has for that
 * provider; it does not invent a provider API.
 */
export interface ModelProvider {
  readonly id: ProviderId
  readonly name: string
  /** The models this provider offers now, with access and capabilities classified. Throws when the provider cannot be asked. */
  discover(signal?: AbortSignal): Promise<ModelCandidate[]>
  /** An active probe. Optional: routing health is otherwise observed from real requests. */
  health?(model: ModelCandidate, signal?: AbortSignal): Promise<Pick<ModelHealthSnapshot, 'state'> & { detail?: string }>
  invoke(model: ModelCandidate, request: ModelInvocation, signal?: AbortSignal): Promise<ModelResponse>
  /** This provider’s reading of its own errors (its 429 body, its “model is loading”), when the general rules would misread it. */
  classifyError?(error: unknown): ClassifiedError | undefined
}
