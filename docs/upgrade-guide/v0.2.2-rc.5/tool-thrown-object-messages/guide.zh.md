---
kind: upgrade-guide
description: "工具失败文本可能显示 JSON 摘要，而不是对象的默认字符串。"
---

# 工具抛出对象时的失败文本

[English](guide.md) | 中文

## 变更

当工具抛出可序列化为 JSON、但没有字符串类型 `message` 的对象时，`@deepseek-ai/dsh-tools/pipeline` 的 `toolErrorMessage()` 会返回有长度上限的 JSON 摘要，而非对象经字符串转换后的结果（通常是 `[object Object]`）。工具结果仍保留 `Error: ` 前缀。工具错误码和已有的 Session 记录不变。

## 迁移

1. 如果你的集成通过匹配旧显示文本来判断工具是否失败，请改用工具结果的 `isError` 标记。把消息当作诊断文本，不要将它解析为 JSON：摘要可能被截断。
2. 运行一个抛出 `{ code: 'INDEX_UNAVAILABLE', reason: 'store is offline' }` 的工具。确认结果仍标为失败，且显示 `Error: {"code":"INDEX_UNAVAILABLE","reason":"store is offline"}`。
