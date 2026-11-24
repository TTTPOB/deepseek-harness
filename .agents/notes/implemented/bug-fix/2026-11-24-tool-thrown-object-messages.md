# Agent Note: Bounded JSON text for thrown objects

Status: implemented

English | [中文](2026-11-24-tool-thrown-object-messages.zh.md)

## Problem

[`toolErrorMessage`](../../../../packages/core/tools/src/pipeline.ts) converts a value thrown by a tool or policy callback into failure text. An object without a string `message` went through `String(error)`, which yields `[object Object]`. The tool result then read `Error: [object Object]`, so neither the model nor the user learned the cause. A 14-day audit of one installation found a `session_list` failure recorded only as that text, with nothing else in the session to diagnose it. Tools outside this repository can throw such objects, so fixing individual throwers cannot cover every case.

## Decision

For an object without a string `message`, `toolErrorMessage` returns `JSON.stringify(error)` when the result fits in 1,024 UTF-16 code units. Longer JSON is cut so that the text, including the trailing `… [truncated]` marker, stays within 1,024 code units; a high surrogate left unpaired by the cut is removed. If serialization throws, as it does for cycles, `BigInt` values, or a throwing `toJSON`, or produces no JSON, the function falls back to `String(error)`. `Error` instances and objects with a string `message` still use that message, and other values still use string coercion. Tool results keep the `Error: ` prefix; tool error codes and recorded session events are unchanged. Expected failures still extend `HarnessError`, the only thrown values whose name and code the tool registry records ([shared error base](../architecture/2026-11-05-harness-error-dependency-free-base.md)).

## Alternatives considered

**`util.inspect`.** It renders more value types, but its output depends on Node formatting options and nesting depth, includes class names, and has no size bound.

**Unbounded JSON.** A thrown object can carry a request body or another large payload, and the text reaches the model as a tool result; an unbounded preview could fill the context window.

**Fix each thrower.** Tools in plugins outside this repository can still throw plain objects; only the shared formatter sees every case.

## Consequences

Failure text for a thrown plain object now shows its fields, for example `Error: {"code":"INDEX_UNAVAILABLE","reason":"store is offline"}`. Integrations that matched the old text must check the tool result's error flag instead ([upgrade guide](../../../../docs/upgrade-guide/v0.2.2-rc.5/tool-thrown-object-messages/guide.md)). The preview is diagnostic text, not parseable JSON, because truncation can cut it anywhere. Objects whose useful content is invisible to JSON, such as non-enumerable properties or `Map` entries, still produce little information.
