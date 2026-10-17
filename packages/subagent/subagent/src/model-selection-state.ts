/** Durable per-session state for the user-controlled model-selection opt-in. */

import { z as zod } from 'zod'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import {
  assertAllowedModelRoutes,
  type AllowedModelRoute,
  type ModelSelectionPolicy,
  type SubagentModelSelectionSettingsSource,
} from './model-selection.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records that this session's delegation tools expose child provider,
     * model, and reasoning-effort selection. Appended before the first model
     * request; absence means the fixed-route definition. Log-only: it carries
     * no `surfaceOp` and never enters model history.
     */
    'subagent/model-selection-policy': {
      /** Exact routes this Session may select explicitly for a child. */
      allowedModels: AllowedModelRoute[]
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Exact routes authorized for child LLM selection, or null when disabled. */
    subagentModelSelectionPolicy: AllowedModelRoute[] | null
  }
}

const modelSelectionPolicySchema: zod.ZodType<AllowedModelRoute[] | null> = zod.array(zod.object({
  provider: zod.string().min(1),
  model: zod.string().min(1),
}).strict()).min(1).nullable()

/** Host-only projection of the durable model-selection policy. */
export const subagentModelSelectionProjectionDefinition = {
  key: 'subagentModelSelectionPolicy',
  stateVersion: 1,
  stateSchema: modelSelectionPolicySchema,
  init: () => null,
  apply: (policy, event) => {
    if (policy !== null || event.type !== 'subagent/model-selection-policy') return policy
    const { allowedModels } = event.data
    assertAllowedModelRoutes(allowedModels)
    if (allowedModels.length === 0) {
      throw new Error('subagent/model-selection-policy requires at least one route')
    }
    return allowedModels
  },
} satisfies ProjectionDefinition<'subagentModelSelectionPolicy', AllowedModelRoute[] | null>

/**
 * Read the exact route list captured for a model-selectable definition.
 * @param projections - registry that owns the policy projection.
 * @param session - session whose durable decision is read.
 * @returns a detached route list, or undefined for the fixed-route definition.
 */
export function subagentModelSelectionPolicy(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  session: Session,
): AllowedModelRoute[] | undefined {
  return projections.stateOf(session, 'subagentModelSelectionPolicy')?.map(route => ({ ...route }))
}

/**
 * Append the route policy once, before its definition can reach a model request.
 * @param projections - registry that owns the policy projection.
 * @param session - session receiving the model-selectable definition.
 * @param allowedModels - exact routes the definition may select explicitly.
 */
export function recordSubagentModelSelection(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  session: Session,
  allowedModels: readonly AllowedModelRoute[],
): void {
  if (subagentModelSelectionPolicy(projections, session) !== undefined) return
  session.append('subagent/model-selection-policy', {
    allowedModels: allowedModels.map(route => ({ ...route })),
  })
}

/** Projection and Session reads that freeze one Session's model-selection policy. */
export interface SubagentModelSelectionScope {
  /** Registry that owns the durable policy projection. */
  readonly projections: Pick<SessionProjectionRegistry, 'stateOf'>
  /**
   * Session registry used to inherit a delegating parent's frozen policy.
   * Undefined when the composition has no Session registry; inheritance then fails loud.
   */
  readonly sessions: { get(id: Session['id']): Session | undefined } | undefined
}

/**
 * Freeze the model-selection policy for one Session before its delegation tools
 * reach a model request. An already recorded policy wins, so a restored Session
 * keeps the routes it was composed with; a subagent child inherits its
 * delegating parent's recorded policy; only a fresh top-level Session samples
 * the current user preference. The sampled or inherited policy is recorded, so
 * later settings edits and spawns never change it.
 * @param scope - projection registry and Session lookup used for inheritance.
 * @param session - Session receiving the delegation tools.
 * @param settings - current preference source; undefined disables selection for this composition.
 * @returns the frozen policy, or undefined for the fixed-route definition.
 */
export function selectSubagentModelSelectionPolicy(
  scope: SubagentModelSelectionScope,
  session: Session,
  settings: SubagentModelSelectionSettingsSource | undefined,
): ModelSelectionPolicy | undefined {
  if (settings === undefined) return undefined
  const freshSession = session.firstLiveSeq === 0
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    && session.eventAt(SessionSeq(0))?.type !== 'session/end-seed'
  let allowedModels = subagentModelSelectionPolicy(scope.projections, session)
  if (allowedModels === undefined) {
    const parentId = session.header.origin === 'subagent'
      ? session.header.parentSession
      : undefined
    if (parentId !== undefined) {
      if (scope.sessions === undefined) {
        throw new Error('child model-selection inheritance requires the Session registry')
      }
      const parent = scope.sessions.get(parentId)
      allowedModels = parent === undefined
        ? undefined
        : subagentModelSelectionPolicy(scope.projections, parent)
    } else if (freshSession) {
      const current = settings.current()
      allowedModels = current.enabled ? current.allowedModels : undefined
    }
  }
  if (allowedModels !== undefined) {
    recordSubagentModelSelection(scope.projections, session, allowedModels)
  }
  return allowedModels === undefined ? undefined : { routes: allowedModels }
}
