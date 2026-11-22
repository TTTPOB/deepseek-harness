---
kind: upgrade-guide
description: '使用 Pi AI fork 的部署需要把提供方错误码的覆盖规则移到独立的流插件。'
---

# 将 Pi AI 错误码覆盖规则移出提供方配置

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-llm-pi-ai` 的 fork 版本曾从各提供方配置读取 `errorCodeRules`。现在适配器只使用内置分类器。部署专用的覆盖规则由独立的 dsh-config 插件在 `llm/stream` 瀑布式事件上处理。

## 迁移

1. 在 `cordis.yml` 或定义这些字段的补丁中，从 Pi AI 适配器的各 `providers.<route>` 条目移除 `errorCodeRules`。
2. 如果依赖自定义映射，请在 dsh-config 的流插件中配置同一条规则。在测试 profile 中触发相关提供方错误，确认报告的错误码符合预期。
