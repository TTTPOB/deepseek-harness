---
kind: upgrade-guide
description: "Node PTC preserves raw-looking ordinary strings and replaces approximate parse diagnostics with original-source frames."
---

# Node PTC raw recognition and parse diagnostics

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-ptc-runtime-node` changes from global outer-first recognition to Acorn/TypeScript token recognition. Raw-looking sequences inside ordinary strings, comments, regex and template text stay unchanged. Programs that relied on those sequences being rewritten must use a raw literal as a code expression instead. Acorn failures other than unterminated raw literals retain the old fallback.

Parse failures replace the approximate `run_code:N` / `ptc-repl:N` suffix with `SyntaxError at L:C: <strip message>` and an original-source line/caret. TypeScript-only rejections have no location. Structured failures remain `kind: 'exception'`.

## Migration

1. Keep embedded text in raw code expressions; do not rely on conversion inside ordinary quoted strings. Existing encoded at-signs still work and need no change.
2. Update diagnostic matchers to accept `SyntaxError at L:C:` instead of the old filename suffix. Do not require a location for every TypeScript rejection.
3. Confirm both execution modes preserve an ordinary string containing the opener sequence and report a source frame for invalid quotes. See the [package reference](../../../../packages/ptc-runtime/ptc-runtime-node/README.md#raw-text-literals) for recognition and fallback limits.
