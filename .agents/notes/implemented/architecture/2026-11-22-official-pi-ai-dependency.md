# Agent Note: Use official Pi AI in the adapter

Status: implemented

English | [中文](2026-11-22-official-pi-ai-dependency.zh.md)

## Problem

Pi AI before 1.5 reparsed the whole accumulated tool-argument JSON on every streamed delta. On Pi AI 1.4.0 a 200 KiB argument fixture cost about 4.7 seconds of CPU; the Pi fork parsed arguments only at the end and took 9.6 milliseconds. The fork also carried two features absent upstream: a switch that moved the Responses system prompt into top-level `instructions`, and Gemini Chat Completions tool-call signature handling. Every upstream release had to be rebased under these changes.

## Decision

[The adapter](../../../../packages/llm/llm-pi-ai/README.md) pins official `@earendil-works/pi-ai` `1.6.0`. Its incremental parser no longer rescans the accumulated JSON: the same fixture takes 17.5 milliseconds, and arguments heavy in escapes and Unicode cost tens of milliseconds more than the fork. That difference is immaterial next to generation that takes minutes. The adapter reads raw deltas and final arguments, and the same local streaming tests pass on both versions for completion, truncation, argument repair, and Responses replay.

The adapter rejects `compat.systemPromptFormat`. Upstream Responses sends the initial system prompt as the first `input` item, using the `developer` role for reasoning models that accept it. From GPT-6.2 the backend appends top-level `instructions` after `input`, so a prompt sent there never reuses the cached prefix; upstream moved its Codex protocol to the same leading item for this reason ([Pi `edfe6b2ef`](https://github.com/earendil-works/pi/commit/edfe6b2ef), [#12273](https://github.com/earendil-works/pi/issues/12273)).

Only the Pi fork handled Gemini Chat Completions tool-call signatures; 1.6.0 does not. This fork's users do not use that path, so the adapter drops its tests.

## Alternatives considered

**Keep the patched dependency.** The official parser closes the performance gap that justified the fork, and dropping it removes a separate tarball and patch from every release.

**Keep an adapter-side `instructions` switch.** It would preserve a placement that defeats prompt caching on current reasoning models.

## Consequences

[`Configurable<T>`](../../../../packages/llm/llm-pi-ai/src/catalog.ts) strips explicitly assignable `undefined` from optional upstream properties, so the Schemastery configuration types and the compat allowlist match under `exactOptionalPropertyTypes` without type assertions. It is used only by the compile-time allowlist check; runtime validation is unchanged.

The allowlist offers three compat fields new in 1.6.0 (`requiresNonNullAssistantContent`, `requiresToolsWithToolHistory`, `promptCacheKeyMode`) and withholds Anthropic `supportsMessageThreads`, which depends on server-side thread state.

Pi AI 1.6.0 serializes Anthropic Messages differently, so the [prefix digest seed](../../../../packages/llm/llm-pi-ai/src/prefix-binding.ts) moved to v2. Signed thinking recorded before the upgrade fails the digest check once and is not replayed; later responses record v2 digests.

The adapter still offers upstream `supportsToolSearch`. This fork keeps its own `errorCodeRules`; a future migration of the rule engine must carry the configured rules with it.
