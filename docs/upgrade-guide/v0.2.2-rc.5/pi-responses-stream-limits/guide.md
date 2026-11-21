---
kind: upgrade-guide
description: The Pi AI adapter rejects the removed Responses whitespace and repeated-pattern limits.
---

# Remove Responses stream limits

English | [中文](guide.zh.md)

## Change

The Pi AI adapter no longer stops Responses streams because of long whitespace runs or repeated patterns. Its configuration rejects `compat.maxConsecutiveWhitespaceChars` and `compat.maxRepeatedPatternChars`, so requests that use a provider or model whose `compat` still sets either key fail with a configuration error.

## Migration

1. Remove `maxConsecutiveWhitespaceChars` and `maxRepeatedPatternChars` from every provider-level and model-level `compat` object in your profile patches.
2. Run `dsh --dump-config` for each affected profile and confirm that neither key appears.
