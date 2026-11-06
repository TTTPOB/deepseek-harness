/** Model-facing discovery of LLM routes available to child Agents. */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { listSubagentModels, parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { AllowedModelRoute } from '@deepseek-ai/dsh-subagent'
import { subagentModelSelectionPolicy } from '@deepseek-ai/dsh-subagent'

interface ListSubagentModelsRequest {
  readonly provider?: string
  readonly model?: string
}

/** Read the requested provider, allowed models, or exact-model efforts. */
async function discoverModels(
  ctx: Context,
  policyHandle: ProjectionHandle<AllowedModelRoute[] | null>,
  request: ListSubagentModelsRequest,
  exec: ToolRunContext,
): Promise<string> {
  if (exec.agent === undefined) throw new Error('list_subagent_models requires a calling agent')
  const routes = subagentModelSelectionPolicy(policyHandle, exec.agent.session)
  let policy = routes === undefined ? undefined : { routes }
  const selectionEnabled = policy !== undefined
  if (policy === undefined) {
    const { provider, model } = parentAgentOptionsForDelegation(exec.agent)
    if (provider === undefined || model === undefined) {
      throw new Error('cannot discover child LLM routes without a parent provider and model')
    }
    policy = { routes: [{ provider, model }] }
  }
  const { signal } = exec
  const llm = ctx.get('llm')
  if (llm === undefined) {
    throw new Error('cannot discover child LLM routes because the `llm` service is unavailable')
  }
  return listSubagentModels(llm, policy, request, signal, selectionEnabled)
}

/**
 * Register discovery of the calling Session’s authorized child models.
 * @param ctx - Context carrying the tool registry and LLM service.
 * @param policyHandle - retained reader for the Session’s authorized child routes.
 */
export function registerListSubagentModels(
  ctx: Context,
  policyHandle: ProjectionHandle<AllowedModelRoute[] | null>,
): void {
  ctx.tools.register(defineTool({
    name: 'list_subagent_models',
    description:
      'Inspect subagent models without changing the current Agent. No arguments: providers; '
      + '`provider`: allowed models; `provider` + `model`: that model and its reasoning efforts. '
      + 'Inspect options here before selecting a child provider and model; use returned ids for delegation.',
    parameters: {
      provider: {
        type: 'string',
        description: 'Registered LLM provider id.',
      },
      model: {
        type: 'string',
        description: 'Exact model id; requires provider.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, result) => [{ type: 'text', text: result }],
    },
    execute(args, exec) {
      return discoverModels(ctx, policyHandle, args, exec)
    },
  }))
}
