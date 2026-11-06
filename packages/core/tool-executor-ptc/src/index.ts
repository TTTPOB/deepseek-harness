/** PTC execution plugin for the mounting Agent, preset, or deployment scope. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { PtcProgramFormat } from '@deepseek-ai/dsh-ptc-runtime'
import { RUN_CODE_NAME, ToolNotFoundError, projectToolSchema } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecutor, ToolModelInput, ToolPromptSection, ToolBatchInput, ToolBatchResult } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline'
import { createRunCodeTool, requirePtcRuntime, type PtcSdkLanguage } from './ptc.ts'
import { renderToolsSdk, type ToolSdkSchema } from './ts-types.ts'
import { renderToolsSdkPy } from './py-types.ts'
import { Config } from './config.ts'

const PTC_ONLY_INSTRUCTION = `\`${RUN_CODE_NAME}\` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.`

/**
 * Name the direct-call surface for this step's visible exceptions.
 * @param exceptions - visible native exception names, in definition order.
 * @returns the PTC-only rule matching what the executor accepts.
 */
function ptcOnlyInstruction(exceptions: readonly string[]): string {
  if (exceptions.length === 0) return PTC_ONLY_INSTRUCTION
  const names = [RUN_CODE_NAME, ...exceptions].map(name => '`' + name + '`').join(', ')
  return `${names} are the only tools you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program; the native exceptions are also available there.`
}

const SDK_RENDERERS = {
  typescript: renderToolsSdk,
  python: renderToolsSdkPy,
} satisfies Record<PtcSdkLanguage, (schemas: readonly ToolSdkSchema[], programFormat: PtcProgramFormat) => string>

/** Runs programs whose nested tool calls use the shared guarded invocation pipeline. */
export class PtcExecutor implements ToolExecutor {
  readonly sections: readonly ToolPromptSection[]
  private readonly pipeline: ToolExecutionPipeline
  private readonly maxParallelSubCalls: number
  private readonly ptcNativeTools: ReadonlySet<string>
  private ptcTransport: ToolDefinition | undefined

  constructor(private readonly ctx: Context, config: Partial<Config> = {}, private readonly maxParallel: () => number = () => 10) {
    const resolved = Config(config)
    this.maxParallelSubCalls = resolved.maxParallelSubCalls
    this.ptcNativeTools = new Set(resolved.ptcNativeTools)
    const tools = ctx.tools
    this.sections = [
      { name: 'tools:ptc-only', order: ctx.systemPrompt.getSectionOrder('PTC_ONLY'), text: tools => ptcOnlyInstruction(this.exceptionsIn(tools).map(definition => definition.name)), interpolate: false },
      { name: 'tools:sdk', order: ctx.systemPrompt.getSectionOrder('TOOLS_SDK'), text: tools => this.renderSdk(tools), interpolate: false },
    ]
    this.pipeline = new ToolExecutionPipeline(ctx, {
      get: (name, scope, toolSet) => name === RUN_CODE_NAME ? this.requirePtcTransport() : tools.executable(name, scope, toolSet),
      // An exception still resolves through `tools.executable` against this
      // step's tool set, so a name hidden this step stays unknown.
      reject: (name, nested) => !nested && name !== RUN_CODE_NAME && !this.ptcNativeTools.has(name)
        ? new ToolNotFoundError(name, (this.ptcNativeTools.size === 0 ? `only \`${RUN_CODE_NAME}\` is callable directly — ` : '')
          + `call \`${name}\` from inside a \`${RUN_CODE_NAME}\` program instead`)
        : undefined,
    })
  }

  describe(tools: readonly ToolDefinition[]): ToolModelInput {
    const exceptions = this.exceptionsIn(tools)
    return {
      schemas: [this.requirePtcTransport(), ...exceptions].map(definition => projectToolSchema(definition, false)),
      // Configured exceptions stay orderable while a scope restriction hides them.
      knownNames: [RUN_CODE_NAME, ...[...this.ptcNativeTools].filter(name => name !== RUN_CODE_NAME)],
    }
  }

  /** Configured exceptions among this step's visible definitions. */
  private exceptionsIn(tools: readonly ToolDefinition[]): ToolDefinition[] {
    return tools.filter(definition => definition.name !== RUN_CODE_NAME && this.ptcNativeTools.has(definition.name))
  }

  private renderSdk(tools: readonly ToolDefinition[]): string {
    const runtime = requirePtcRuntime(this.ctx)
    const render = SDK_RENDERERS[runtime.language]
    return render(tools.map(definition => ({
      ...projectToolSchema(definition, false),
      output: definition.output.schema,
    })), runtime.programFormat)
  }

  execute(input: ToolBatchInput): Promise<ToolBatchResult> {
    return executeToolBatch(input, this.pipeline, this.maxParallel)
  }

  /** Keep the reserved transport outside registered capabilities and their restrictions. */
  private requirePtcTransport(): ToolDefinition {
    this.ptcTransport ??= createRunCodeTool(this.ctx, this.pipeline, this.maxParallelSubCalls)
    return this.ptcTransport
  }
}

export { Config } from './config.ts'
export { CodeRunFailedError } from './errors.ts'
export type { PtcDispatchLog } from './runtime-types.ts'
export type { PtcDispatchStartEventData, PtcDispatchEventData } from './types.ts'
export { jsonSchemaToTs, renderToolsSdk, type ToolSdkSchema } from './ts-types.ts'
export { jsonSchemaToPy, renderToolsSdkPy } from './py-types.ts'

/** Cordis plugin name. */
export const name = 'ptc-tool-executor'
/** Activate the executor only while its registry, prompt service, and runtime are available. */
export const inject = ['tools', 'systemPrompt', 'ptcRuntime']

/**
 * Select PTC execution in the mounting scope.
 * @param ctx - context owning this executor's selection and lifetime.
 * @param config - program subcall concurrency limits and native exceptions.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.setExecutor(new PtcExecutor(ctx, config))
}
