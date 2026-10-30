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

The Node provider accepts the `@` plus multiple-backtick raw-string syntax from the Stage 1 [TC39 improve-template-literals proposal](https://github.com/tc39/proposal-improve-template-literals). Both per-call and persistent execution use one shared preprocessor before type stripping. The [package reference](../../../../packages/ptc-runtime/ptc-runtime-node/README.md#raw-text-literals) defines delimiter matching, outer-first recognition, initial-newline omission and exact content preservation.

Recognition is outer-first, without JavaScript lexical analysis: outside an open raw body, ``` @`` ``` starts a raw literal anywhere in source, including strings, templates, comments and regex literals. This reserves the opener but makes recognition unambiguous, without a regex-versus-division decision. An ordinary string encodes the at-sign as ``` \x40`` ```; a raw body uses a longer delimiter to contain a shorter opener. HTML similarly splits `<script>` using only `</script>`, requiring inner JavaScript to write `<\/script>` when needed; heredocs inspect only their closing marker; Markdown selects longer fences to avoid conflicts.

An omitted opening newline becomes a backslash line continuation inside the generated template. This preserves LF source lines without introducing a line terminator between `return` and its value or changing member-access/ASI behavior. CR content is encoded as `\r` to avoid template newline normalization; bare CR source-line accounting is not retained.

When type stripping fails, a compile-only `vm.Script` pass wraps the preprocessed source in an async function expression and offsets its wrapper line. The async wrapper is also used for REPL diagnostics so a valid top-level await does not hide a later syntax error. No model code runs in the host. A JavaScript syntax error adds only its source frame and message, explicitly labeled approximate when TypeScript-only syntax is present; successful JavaScript compilation adds nothing. The execution bootstrap and sandbox remain unchanged.

## Alternatives considered

**Free-form tool calls or bypassing client parsing.** The observed failures are not in outer JSON. Anthropic's `tool_use.input` is parsed server-side, so a client cannot recover a non-JSON text payload from that interface.

**A separate `payloads` parameter on `run_code`.** It offers the same text-preservation benefit but changes the tool schema and separates text from where the program uses it.

**Automatically repair real newlines inside ordinary quoted strings.** Useful locations let a model fix the source on retry. Silent repair would execute code that differs from what the language rules say the model wrote.

**Require `String.raw`.** It cannot contain arbitrary backticks or `${` without additional quoting work.

**Restore combined native/PTC presentation.** The combined mode has been removed upstream; changing presentation is outside this language fix.

**Infer regex literals from JavaScript tokens.** Using the previous token to decide whether `/` starts a regex remains heuristic; regex literals after `)` or `}` can be misclassified, letting inner quotes or backticks hide later raw openers.

**Parse each prefix with a complete parser such as `@babel/parser`.** The raw opener is itself invalid JavaScript syntax. Each candidate would require parsing its preceding prefix and interpreting parser errors to decide whether the prefix ends inside a string, comment or regex. This depends on diagnostic wording and adds a dependency without simplifying the outer-first rule.

## Consequences

Raw literals remove a common escaping layer at the cost of reserving ``` @`` ``` even in ordinary JavaScript strings; existing program text containing it must encode the at-sign or use a longer raw delimiter. This is a `run_code` language extension, not portable TypeScript syntax or a claim that the TC39 proposal is standardized. JavaScript diagnostics can stop at a TypeScript annotation before the real error; columns describe transformed text. The package reference keeps these limitations explicit.

Shell-level nested quoting is not repaired. For embedded shell scripts, guidance remains to write a script file first or pass it through stdin using a quoted heredoc delimiter. Runtime support does not update external prompt-guidance plugins; adopting raw literals there and rechecking escaping-related failures after deployment remain separate follow-up work.

Programs with a reserved opener inside formerly valid strings, templates, comments or regex literals require source adjustments. Workflow `script` bodies pass through a binding as data and are compiled separately, without this preprocessor or raw-literal syntax. Opening/restoring historical sessions and rendering stored results do not execute old programs; manually rerunning programs and replaying model calls in recorded-session tests does execute them under the new rule. Package tests cover both real process modes and fixed model-visible diagnostics. No new recorded-session scenario is included: changing its replayed model program requires recording, and API-key-dependent recording is excluded from this work. Assembled transcript coverage therefore remains a named gap.
