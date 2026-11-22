---
kind: upgrade-guide
description: 'Pi AI fork deployments must move provider error-code overrides to a separate stream plugin.'
---

# Move Pi AI error-code overrides out of provider profiles

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-llm-pi-ai` fork builds previously read `errorCodeRules` from each provider profile. The adapter now uses only its built-in classifier. A separate dsh-config plugin on the `llm/stream` waterfall owns deployment-specific overrides.

## Migration

1. Remove `errorCodeRules` from each `providers.<route>` entry for the Pi AI adapter in `cordis.yml` or the patch that defines it.
2. If you rely on a custom mapping, configure the same rule in the dsh-config stream plugin. Exercise the affected provider failure in a test profile and check that it reports the expected code.
