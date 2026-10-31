---
kind: upgrade-guide
description: "Node PTC 保留普通字符串中看似原始开头的文本，并以原始源码帧替代近似解析诊断。"
---

# Node PTC 原始文本识别与解析诊断

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-ptc-runtime-node` 从全局外层优先识别改为 Acorn/TypeScript token 识别。普通字符串、注释、正则及模板正文中看似原始开头的序列保持不变。依赖这些序列被重写的程序必须改为将原始字面量作为代码表达式。Acorn 因未闭合原始字面量以外的原因失败时，保留旧回退。

解析失败以 `SyntaxError at L:C: <strip message>` 及原始源码行／插入符替代近似的 `run_code:N` / `ptc-repl:N` 后缀。只有 TypeScript 拒绝时没有位置。结构化失败仍为 `kind: 'exception'`。

## 迁移

1. 将嵌入文本放在原始代码表达式中，不要依赖普通引号字符串内部的转换。现有编码 @ 仍然有效，无需修改。
2. 更新诊断匹配器，以接受 `SyntaxError at L:C:`，而非旧文件名后缀。不要要求每次 TypeScript 拒绝都有位置。
3. 确认两种执行模式都保留含开头序列的普通字符串，并为无效引号报告源码帧。识别和回退限制见[包参考](../../../../packages/ptc-runtime/ptc-runtime-node/README.zh.md#raw-text-literals)。
