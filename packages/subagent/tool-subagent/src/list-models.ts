/** Model-facing discovery of LLM routes available to child Agents. */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: make `ctx.get('llm')` resolve to the optional LLM runtime.
import type {} from '@deepseek-ai/dsh-llm'
import { listSubagentModels } from '@deepseek-ai/dsh-subagent'
import type { ModelSelectionPolicy } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * Register `list_subagent_models` for one owning delegation-tool instance.
 * @param ctx - Context whose tool registry owns the fixed discovery definition.
 * @param policy - Route policy captured for this Session.
 */
export function registerListSubagentModels(ctx: Context, policy: ModelSelectionPolicy): void {
  ctx.tools.register(defineTool({
    name: 'list_subagent_models',
    description:
      'Discover LLM routes for subagents without changing the current Agent. Call with no arguments to list '
      + 'registered providers, with `provider` to list its advertised models, or with `provider` and `model` '
      + 'to inspect that exact model and its reasoning efforts. Catalog membership is advisory: an adapter may '
      + 'accept an unlisted model id. Use the returned ids with a delegation tool\'s `provider`, `model`, and '
      + '`reasoning_effort` fields.',
    parameters: {
      provider: {
        type: 'string',
        description: 'Registered LLM provider id. Omit to list providers.',
      },
      model: {
        type: 'string',
        description: 'Exact model id to inspect. Requires provider; omit to list that provider\'s advertised models.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, result) => [{ type: 'text', text: result }],
    },
    execute(args, exec) {
      const llm = ctx.get('llm')
      if (llm === undefined) {
        throw new Error('cannot discover child LLM routes because the `llm` service is unavailable')
      }
      return listSubagentModels(llm, policy, args, exec.signal)
    },
  }))
}
