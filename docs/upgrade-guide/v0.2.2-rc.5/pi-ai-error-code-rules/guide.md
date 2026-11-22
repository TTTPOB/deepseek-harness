---
kind: upgrade-guide
description: 'The Pi AI adapter no longer applies provider-level errorCodeRules; it ignores the field without an error.'
---

# Move error-code rules out of Pi AI provider profiles

English | [中文](guide.zh.md)

## Change

Fork builds of `@deepseek-ai/dsh-llm-pi-ai` used to read `errorCodeRules` from each provider profile and rewrite the failure code of a terminal stream error before `llm-retry` saw it. The adapter now reports only the code from its built-in classifier. A profile that still sets `errorCodeRules` loads without an error, but the rules have no effect, so an error your rules used to make retryable, or non-retryable, now follows the built-in classification.

## Migration

1. Move each rule to a plugin that listens on the `llm/stream` waterfall and replaces `failure.code` on the terminal `finish` chunk, scoped to the same provider.
2. Remove `errorCodeRules` from every Pi AI `providers.<route>` entry in your profile patches.
3. Reproduce one affected error against a test profile and check the `llm/retry` events: an error mapped to a retryable code is retried, and an error mapped to `PI_AI_ERROR` is not.
