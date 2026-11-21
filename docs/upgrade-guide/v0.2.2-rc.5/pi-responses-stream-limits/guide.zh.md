---
kind: upgrade-guide
description: Pi AI 适配器拒绝已移除的 Responses 连续空白和重复模式阈值。
---

# 移除 Responses 流检测阈值

[English](guide.md) | 中文

## 变更

Pi AI 适配器不再因连续空白过长或重复模式而中断 Responses 流。配置校验会拒绝 `compat.maxConsecutiveWhitespaceChars` 和 `compat.maxRepeatedPatternChars`，仍在 `compat` 中设置其中任一字段的 provider 或 model，其请求会因配置错误而失败。

## 迁移

1. 在 profile 补丁中，从每个 provider 级和 model 级的 `compat` 对象里删除 `maxConsecutiveWhitespaceChars` 和 `maxRepeatedPatternChars`。
2. 对每个受影响的 profile 运行 `dsh --dump-config`，确认输出中没有这两个字段。
