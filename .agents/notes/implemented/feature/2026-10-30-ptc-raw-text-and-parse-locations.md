# Agent Note: Raw text literals and parse locations for PTC

Status: implemented

English | [中文](2026-10-30-ptc-raw-text-and-parse-locations.zh.md)

## Problem

PTC-only tools require a model to place file contents or embedded scripts inside TypeScript string literals, then place that program inside tool-call JSON. In local use, observed escaping failures occur after JSON decoding, inside TypeScript source; the outer JSON arguments remain valid. Typical failures are real newlines inside ordinary quoted strings, inner quotes matching the outer quote, and over-escaped template backticks. Embedded code can also be silently changed when the TypeScript layer interprets an intended `\n` before writing a file.

JavaScript and TypeScript have no string syntax that accepts arbitrary text without delimiter restrictions. `String.raw` still reserves backticks and `${`. The [PTC foundation](2026-06-15-ptc.md) owns tool presentation and dispatch; this decision extends only the Node provider's program language and parse diagnostics.

On Node 24.19, `stripTypeScriptTypes` exposes a parse failure's message and code but no source location. This minimal example is independently reproducible without a model or credentials:

```js
import { stripTypeScriptTypes } from 'node:module'
try {
  stripTypeScriptTypes('const text = ;')
} catch (error) {
  console.log(error.message, error.code, error.lineNumber, error.columnNumber)
}
```

The code is `ERR_INVALID_TYPESCRIPT_SYNTAX`; both location fields are undefined. Short parser messages alone leave a model guessing where to edit.

## Decision

The Node provider accepts the `@` plus multiple-backtick raw-string syntax from the Stage 1 [TC39 improve-template-literals proposal](https://github.com/tc39/proposal-improve-template-literals). Both per-call and persistent execution use one shared preprocessor before type stripping. The [package reference](../../../../packages/ptc-runtime/ptc-runtime-node/README.md#raw-text-literals) defines the current recognition, delimiter matching, initial-newline omission and exact content preservation. The [lexer-aware correction](../bug-fix/2026-10-31-ptc-raw-token-recognition.md) supersedes this note's initial recognition and diagnostic choices; the raw language and conversion rationale remain active here.

The initial recognition decision was outer-first, without JavaScript lexical analysis: outside an open raw body, ``` @`` ``` started a raw literal anywhere in source, including strings, templates, comments and regex literals. This reserved the opener but made recognition unambiguous, without a regex-versus-division decision. An ordinary string encoded the at-sign as ``` \x40`` ```; a raw body used a longer delimiter to contain a shorter opener. The rationale compared HTML's `</script>` splitting, heredoc closing markers and longer Markdown fences. The correction replaces this global reservation because it silently changes ordinary string values; outer-first conversion remains only the compatibility fallback.

An omitted opening newline becomes a backslash line continuation inside the generated template. This preserves LF source lines without introducing a line terminator between `return` and its value or changing member-access/ASI behavior. CR content is encoded as `\r` to avoid template newline normalization; bare CR source-line accounting is not retained.

The initial compile-only `vm.Script` diagnostic used an async wrapper in both modes so top-level await could not hide a later syntax error, and offset the wrapper line. It labeled positions approximate because JavaScript cannot parse TypeScript annotations. The correction replaces that mechanism with Acorn/TypeScript original-source locations and one strip message. No model code runs in the host; the execution bootstrap and sandbox remain unchanged.

## Alternatives considered

**Free-form tool calls or bypassing client parsing.** The observed failures are not in outer JSON. Anthropic's `tool_use.input` is parsed server-side, so a client cannot recover a non-JSON text payload from that interface.

**A separate `payloads` parameter on `run_code`.** It offers the same text-preservation benefit but changes the tool schema and separates text from where the program uses it.

**Automatically repair real newlines inside ordinary quoted strings.** Useful locations let a model fix the source on retry. Silent repair would execute code that differs from what the language rules say the model wrote.

**Require `String.raw`.** It cannot contain arbitrary backticks or `${` without additional quoting work.

**Restore combined native/PTC presentation.** The combined mode has been removed upstream; changing presentation is outside this language fix.

**Infer regex literals from JavaScript tokens.** Using the previous token to decide whether `/` starts a regex remains heuristic; regex literals after `)` or `}` can be misclassified, letting inner quotes or backticks hide later raw openers.

**Parse each prefix with a complete parser such as `@babel/parser`.** The raw opener is itself invalid JavaScript syntax. Each candidate would require parsing its preceding prefix and interpreting parser errors to decide whether the prefix ends inside a string, comment or regex. This depends on diagnostic wording and adds a dependency without simplifying the outer-first rule.

## Consequences

Raw literals remove a common escaping layer. This is a `run_code` language extension, not portable TypeScript syntax or a claim that the TC39 proposal is standardized. The initial global opener reservation and JavaScript-only location limitations are superseded by the correction; the package reference states the current fallback and location limits.

Shell-level nested quoting is not repaired. For embedded shell scripts, guidance remains to write a script file first or pass it through stdin using a quoted heredoc delimiter. Runtime support does not update external prompt-guidance plugins; adopting raw literals there and rechecking escaping-related failures after deployment remain separate follow-up work.

Workflow `script` bodies pass through a binding as data and are compiled separately, without this preprocessor or raw-literal syntax. Opening/restoring historical sessions and rendering stored results do not execute old programs; manually rerunning programs and replaying model calls in recorded-session tests does execute them under the current rule. Package tests cover both real process modes and fixed model-visible diagnostics. No new recorded-session scenario is included: changing its replayed model program requires recording, and API-key-dependent recording is excluded from this work. Assembled transcript coverage therefore remains a named gap.
