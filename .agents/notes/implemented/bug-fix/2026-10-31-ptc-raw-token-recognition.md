# Agent Note: Lexer-aware PTC raw text and exact parse locations

Status: implemented

English | [中文](2026-10-31-ptc-raw-token-recognition.zh.md)

## Problem

The [raw-text decision](../feature/2026-10-30-ptc-raw-text-and-parse-locations.md) removes an escaping layer for embedded text. Its outer-first recognition also converts opener sequences inside valid ordinary strings, silently changing their values. This affects programs that write source, tests or documentation about raw literals. Its JavaScript-only diagnostic parser can stop at a valid TypeScript annotation before the real error, and appending two parser messages makes failures longer without making them easier to repair.

## Decision

Acorn with `@sveltejs/acorn-typescript` parses the original model-written source. An outermost raw plugin intercepts an at-sign followed by at least two backticks in `getTokenFromCode`, reads through the next maximal exactly-matching run, records the range and emits a string token. Other at-signs delegate to the TypeScript plugin so decorators remain available. Ordinary strings, comments, regex and template text are not raw tokens; template interpolation expressions can contain them. Updating the tokenizer's line state after multiline raw tokens keeps following diagnostics in original coordinates.

Both formats use latest ECMAScript, sloppy script parsing, locations, and explicit allowances for top-level await, return and imports. The supplemental parser admits the union of the two formats; Node's selected type-stripping path still decides whether top-level return or imports are allowed. Sloppy mode avoids turning legacy octal into an Acorn-only strict-mode error; the existing strip rejection remains message-only. Only recorded raw ranges become templates, using the original line-preserving conversion. All other source bytes stay identical.

An unterminated raw token fails at its opener. Any other Acorn failure falls back to the original outer-first preprocessing before type stripping. Acorn is supplemental rather than a new acceptance authority: a parser compatibility gap must not block code the existing stripper accepts. This fallback intentionally retains the old recognition risk on programs Acorn rejects.

A strip failure with an Acorn position returns `SyntaxError at L:C: <strip message>`, the original source line and a caret. Coordinates are 1-based in both formats; Acorn's own message is omitted. An unterminated raw token uses the same frame with `Unterminated raw string literal; close it with exactly N backticks.` A strip failure after Acorn acceptance returns only the strip message. No approximate label, generated filename, duplicate parser text or writing advice is added. Callers still return `kind: 'exception'`. Diagnostics never execute model code.

## Alternatives considered

**Keep global opener reservation.** It makes recognition simple but silently corrupts ordinary strings. Requiring encoded at-signs in every source-writing program moves that defect onto callers.

**Hand-written string/comment scanning or regex-versus-division heuristics.** JavaScript lexical context includes templates, interpolation and TypeScript syntax. Acorn owns those rules instead of adding another partial lexer.

**Reject every Acorn failure.** This would make a supplemental dependency's grammar gaps regress otherwise accepted programs. The fallback preserves the existing acceptance path.

**Keep JavaScript-only diagnostic compilation.** It cannot skip valid TypeScript annotations and gives transformed rather than original columns.

## Consequences

Raw syntax and template conversion remain owned by the original feature note; this note partially supersedes recognition and diagnostics only. The package declares both parsers as runtime dependencies. tsdown leaves those dependencies external, so the isolated packed consumer must install and resolve them; source-only tests cannot qualify that artifact.

Package tests cover ordinary-token preservation, regex/division, template interpolation, TypeScript syntax and decorators, exact delimiter runs, CRLF/LF preservation, fallback, and all diagnostic forms in both formats. Real subprocess tests and the core tarball smoke pin raw execution, unchanged ordinary strings and source-frame formatting. The original note's assembled-transcript coverage gap remains; no private program corpus or exact private statistics are committed.
