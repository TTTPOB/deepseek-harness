/** Runtime validation for Pi model descriptors crossing JSON boundaries. */

import type { Api, Model } from '@earendil-works/pi-ai'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function validateCost(value: unknown): boolean {
  if (!isRecord(value)
    || !isNonNegativeNumber(value.input)
    || !isNonNegativeNumber(value.output)
    || !isNonNegativeNumber(value.cacheRead)
    || !isNonNegativeNumber(value.cacheWrite)) return false
  if (value.tiers === undefined) return true
  if (!Array.isArray(value.tiers)) return false
  return value.tiers.every(tier => (
    isRecord(tier)
    && Number.isSafeInteger(tier.inputTokensAbove)
    && (tier.inputTokensAbove as number) >= 0
    && isNonNegativeNumber(tier.input)
    && isNonNegativeNumber(tier.output)
    && isNonNegativeNumber(tier.cacheRead)
    && isNonNegativeNumber(tier.cacheWrite)
  ))
}

function validateOptionalModelFields(model: Record<string, unknown>): boolean {
  if (model.thinkingLevelMap !== undefined) {
    if (!isRecord(model.thinkingLevelMap)
      || !Object.values(model.thinkingLevelMap).every(value => value === null || isNonEmptyString(value))) return false
  }
  if (model.samplingParams !== undefined && !isRecord(model.samplingParams)) return false
  if (model.headers !== undefined) {
    if (!isRecord(model.headers) || !Object.values(model.headers).every(value => typeof value === 'string')) return false
  }
  if (model.compat !== undefined && !isRecord(model.compat)) return false
  return true
}

/**
 * Validate one complete Pi model descriptor and its provider/id ownership.
 * @param value - decoded JSON value to validate.
 * @param providerId - provider that owns the catalog.
 * @param expectedId - object key that names the descriptor, when present.
 * @returns the descriptor after validation.
 * @throws Error when a required field or ownership field is malformed.
 */
export function parsePiModel(value: unknown, providerId: string, expectedId?: string): Model<Api> {
  if (!isRecord(value)
    || !isNonEmptyString(value.id)
    || (expectedId !== undefined && value.id !== expectedId)
    || value.provider !== providerId
    || !isNonEmptyString(value.name)
    || !isNonEmptyString(value.api)
    || !isNonEmptyString(value.baseUrl)
    || typeof value.reasoning !== 'boolean'
    || !Array.isArray(value.input)
    || !value.input.every(input => input === 'text' || input === 'image')
    || !validateCost(value.cost)
    || !isPositiveSafeInteger(value.contextWindow)
    || !isPositiveSafeInteger(value.maxTokens)
    || !validateOptionalModelFields(value)) {
    const suffix = expectedId === undefined ? '' : ` for model "${expectedId}"`
    throw new Error(`model catalog contains an invalid Pi model descriptor${suffix}`)
  }
  return value as unknown as Model<Api>
}

/**
 * Validate an object keyed by model id as a complete remote catalog.
 * @param value - decoded network JSON.
 * @param providerId - provider whose catalog was requested.
 * @returns validated descriptors in response object order.
 */
export function parsePiModelCatalog(value: unknown, providerId: string): readonly Model<Api>[] {
  if (!isRecord(value)) throw new Error('model catalog response must be an object keyed by model id')
  return Object.entries(value).map(([id, descriptor]) => parsePiModel(descriptor, providerId, id))
}
