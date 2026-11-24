---
kind: upgrade-guide
description: "Tool failure text can contain a JSON preview instead of the default object string."
---

# Tool failure text for thrown objects

English | [中文](guide.zh.md)

## Change

When a tool throws a JSON-serializable object without a string `message`, `toolErrorMessage()` from `@deepseek-ai/dsh-tools/pipeline` returns a bounded JSON preview instead of the object's string conversion (often `[object Object]`). Tool results retain the `Error: ` prefix. Tool error codes and existing Session records are unchanged.

## Migration

1. If your integration matches the old display text to detect tool failure, use the tool result's `isError` flag instead. Treat the message as diagnostic text, not JSON to parse: the preview can be truncated.
2. Run a tool that throws `{ code: 'INDEX_UNAVAILABLE', reason: 'store is offline' }`. Confirm that its result still reports failure and displays `Error: {"code":"INDEX_UNAVAILABLE","reason":"store is offline"}`.
