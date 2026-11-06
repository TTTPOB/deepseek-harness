/** Model-facing discovery of LLM routes available to delegated child Agents. */

import type LlmRuntime from '@deepseek-ai/dsh-llm'
import type { LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import type { ModelSelectionPolicy } from './model-selection.ts'

/** Provider and exact-model filter for one discovery call. */
export interface SubagentModelDiscoveryRequest {
  /** Registered LLM provider id. Omit to list providers. */
  readonly provider?: string
  /** Exact model id to inspect. Requires provider. */
  readonly model?: string
}

/** Resolve one registered provider with a model-correctable diagnostic. */
function registeredProvider(
  llm: LlmRuntime,
  policy: ModelSelectionPolicy,
  providerId: string,
): LlmProviderInfo {
  const providers = llm.listProviders()
  const provider = providers.find(candidate => candidate.id === providerId)
  if (provider !== undefined) return provider
  const available = providers
    .filter(candidate => policy.routes.some(route => route.provider === candidate.id))
    .map(candidate => candidate.id)
    .join(', ') || '(none)'
  throw new Error(`LLM provider "${providerId}" is not registered; available providers: ${available}`)
}

/** Render one advertised or resolved model. */
function modelLine(provider: string, model: { id: string; name: string; description?: string }): string {
  return `${provider}/${model.id} — ${model.name}${model.description === undefined ? '' : `: ${model.description}`}`
}

/**
 * Discover authorized routes and reasoning efforts without changing the Agent.
 * @param llm - live runtime owning provider and model metadata.
 * @param policy - authorized routes, or the current parent route when selection is disabled.
 * @param request - provider and optional exact-model filter.
 * @param signal - caller cancellation for metadata resolution.
 * @param selectionEnabled - whether to list authorized catalog entries instead of resolving the parent model.
 * @returns model-facing directory text.
 */
export async function listSubagentModels(
  llm: LlmRuntime,
  policy: ModelSelectionPolicy,
  request: SubagentModelDiscoveryRequest,
  signal: AbortSignal,
  selectionEnabled = true,
): Promise<string> {
  if (request.model !== undefined && request.provider === undefined) {
    throw new Error('`model` requires `provider`')
  }
  if (request.provider === undefined) {
    const providers = llm.listProviders()
      .filter(provider => policy.routes.some(route => route.provider === provider.id))
    return providers.length === 0
      ? '(no LLM providers)'
      : providers.map(provider => `${provider.id} — ${provider.name}`).join('\n')
  }
  if (request.provider.length === 0) throw new Error('`provider` must be non-empty')
  const allowedRoutes = policy.routes.filter(route => route.provider === request.provider)
  const [firstRoute] = allowedRoutes
  if (firstRoute === undefined) {
    throw new Error(`LLM provider "${request.provider}" is not allowed for this Session`)
  }
  const provider = registeredProvider(llm, policy, request.provider)
  if (request.model === undefined) {
    const models = selectionEnabled
      ? (await llm.listModels(provider.id)).filter(model => allowedRoutes.some(route => route.model === model.id))
      : [await llm.resolveModelInfo(provider.id, firstRoute.model, signal)]
    signal.throwIfAborted()
    return models.length === 0
      ? `(no advertised models for ${provider.id})`
      : models.map(model => modelLine(provider.id, model)).join('\n')
  }
  if (request.model.length === 0) throw new Error('`model` must be non-empty')
  if (!allowedRoutes.some(route => route.model === request.model)) {
    throw new Error(`child LLM route "${provider.id}/${request.model}" is not allowed for this Session`)
  }
  const model = await llm.resolveModelInfo(provider.id, request.model, signal)
  const efforts = model.reasoning?.efforts.map(effort => (
    `${effort.id}${model.reasoning?.defaultEffort === effort.id ? ' (default)' : ''} — ${effort.name}`
    + (effort.description === undefined ? '' : `: ${effort.description}`)
  )).join('\n') || '(no advertised reasoning efforts)'
  return `${modelLine(provider.id, model)}\nReasoning efforts:\n${efforts}`
}
