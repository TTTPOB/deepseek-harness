---
kind: upgrade-guide
description: 'Pi AI 适配器不再执行提供方级别的 errorCodeRules；该字段会被忽略，不报错。'
---

# 把错误码规则移出 Pi AI 提供方配置

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-llm-pi-ai` 的 fork 版本以前会读取各提供方配置里的 `errorCodeRules`，在 `llm-retry` 处理之前改写流式请求最终错误的错误码。现在适配器只报告内置分类器给出的错误码。仍然设置了 `errorCodeRules` 的配置可以正常加载，但规则不再生效：原本靠规则变成可重试或不可重试的错误，现在按内置分类处理。

## 迁移

1. 把每条规则移到监听 `llm/stream` 瀑布式事件的插件里，由插件在最终的 `finish` 块上替换 `failure.code`，并限定在同一个提供方。
2. 从配置补丁中每个 Pi AI `providers.<route>` 条目里删除 `errorCodeRules`。
3. 在测试 profile 中复现一次受影响的错误，检查 `llm/retry` 事件：映射为可重试错误码的错误会重试，映射为 `PI_AI_ERROR` 的错误不会重试。
