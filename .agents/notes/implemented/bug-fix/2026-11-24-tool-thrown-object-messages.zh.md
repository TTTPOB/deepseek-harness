# Agent Note: 为抛出的对象生成有长度上限的 JSON 文本

Status: implemented

[English](2026-11-24-tool-thrown-object-messages.md) | 中文

## 问题

[`toolErrorMessage`](../../../../packages/core/tools/src/pipeline.ts) 把工具或策略回调抛出的值转换成失败文本。没有字符串 `message` 的对象会经过 `String(error)`，结果是 `[object Object]`。工具结果因此显示为 `Error: [object Object]`，模型和用户都看不到原因。对一个安装环境 14 天记录的审计发现，有一次 `session_list` 失败只留下这段文本，会话里没有任何其他信息可供诊断。仓库外的工具也可能抛出这类对象，逐个修改抛出方无法覆盖所有情况。

## 决策

对于没有字符串 `message` 的对象，若 `JSON.stringify(error)` 的结果不超过 1,024 个 UTF-16 码元，`toolErrorMessage` 直接返回它。更长的 JSON 会被截断，使包括末尾 `… [truncated]` 标记在内的文本不超过 1,024 个码元；截断后落单的高位代理项会被删除。如果序列化抛出异常（循环引用、`BigInt` 值或会抛出异常的 `toJSON` 都会如此），或者没有产生 JSON，函数退回 `String(error)`。`Error` 实例和带字符串 `message` 的对象仍使用该 message，其他值仍按字符串强制转换。工具结果保留 `Error: ` 前缀；工具错误码和已记录的会话事件不变。预期内的失败仍继承 `HarnessError`，工具注册表只记录这类抛出值的名称和错误码（[共享错误基类](../architecture/2026-11-05-harness-error-dependency-free-base.zh.md)）。

## 考虑过的替代方案

**`util.inspect`。** 它能渲染更多类型的值，但输出取决于 Node 的格式化选项和嵌套深度，会带上类名，也没有长度上限。

**不设上限的 JSON。** 抛出的对象可能携带请求体或其他大载荷，而这段文本会作为工具结果进入模型；不设上限的预览可能占满上下文窗口。

**逐个修改抛出方。** 仓库外插件里的工具仍可能抛出普通对象；只有共享的格式化函数能看到所有情况。

## 后果

抛出普通对象时，失败文本现在会显示它的字段，例如 `Error: {"code":"INDEX_UNAVAILABLE","reason":"store is offline"}`。依赖旧文本判断失败的集成应改为检查工具结果的错误标志（[升级指南](../../../../docs/upgrade-guide/v0.2.2-rc.5/tool-thrown-object-messages/guide.zh.md)）。这段预览是诊断文本，不是可解析的 JSON，因为截断可能发生在任何位置。有用内容对 JSON 不可见的对象，例如不可枚举属性或 `Map` 条目，仍然只能提供很少的信息。
