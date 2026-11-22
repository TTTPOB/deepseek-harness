# Agent Note: 适配器使用官方 Pi AI

Status: implemented

[English](2026-11-22-official-pi-ai-dependency.md) | 中文

## 问题

Pi AI 1.5 之前，每收到一段流式增量，都要把累计的整段工具参数 JSON 重新解析一遍。在 Pi AI 1.4.0 上，200 KiB 的参数夹具约耗 4.7 秒 CPU；Pi fork 只在结束时解析一次，耗时 9.6 毫秒。fork 还带了两项上游没有的功能：把 Responses 系统提示词移到顶层 `instructions` 的开关，以及 Gemini Chat Completions 工具调用签名的处理。每次上游发版，都要把这些改动重新变基到新版本上。

## 决策

[适配器](../../../../packages/llm/llm-pi-ai/README.zh.md)固定使用官方 `@earendil-works/pi-ai` `1.6.0`。它的增量解析器不再重扫累计的 JSON：同一夹具耗时 17.5 毫秒，转义和 Unicode 较多的参数比 fork 多几十毫秒。相对于分钟级的生成时间，这点差距可以忽略。适配器读取原始增量和最终参数；同一组本地流式测试在两个版本上都通过，覆盖正常结束、截断、参数修复和 Responses 回放。

适配器拒绝 `compat.systemPromptFormat`。上游 Responses 把初始系统提示词作为 `input` 的第一项发送，对接受 `developer` 角色的推理模型使用该角色。从 GPT-6.2 起，后端把顶层 `instructions` 拼在 `input` 之后，放在那里的提示词永远无法复用已缓存的前缀；上游正因为这一点，把 Codex 协议也改成了同样的前置条目（[Pi `edfe6b2ef`](https://github.com/earendil-works/pi/commit/edfe6b2ef)、[#12273](https://github.com/earendil-works/pi/issues/12273)）。

Gemini Chat Completions 的工具调用签名只有 Pi fork 处理，1.6.0 没有。本 fork 的使用者不走这条路径，因此适配器删除相关测试。

## 考虑过的替代方案

**继续使用打补丁的依赖。** 官方解析器已经消除了当初需要 fork 的性能差距；去掉 fork 后，每次发版不再需要单独的 tarball 和补丁。

**在适配器侧保留 `instructions` 开关。** 这只会保留一种在当前推理模型上让提示词缓存失效的放置方式。

## 后果

[`Configurable<T>`](../../../../packages/llm/llm-pi-ai/src/catalog.ts) 去掉上游可选属性中可显式赋值的 `undefined`，使 Schemastery 配置类型与 compat 白名单在 `exactOptionalPropertyTypes` 下无需类型断言即可对齐。它只用于编译期的白名单检查，运行时校验不变。

白名单开放 1.6.0 新增的三个 compat 字段（`requiresNonNullAssistantContent`、`requiresToolsWithToolHistory`、`promptCacheKeyMode`），不开放依赖服务端线程状态的 Anthropic `supportsMessageThreads`。

Pi AI 1.6.0 序列化 Anthropic Messages 的方式有变化，因此[前缀摘要种子](../../../../packages/llm/llm-pi-ai/src/prefix-binding.ts)换成 v2。升级前记录的签名思考会有一次不能通过摘要校验，不再回放；之后的响应记录 v2 摘要。

适配器开放上游的 `supportsToolSearch`，并使用内置规则对提供方错误分类；部署专用的失败码覆盖由独立的 dsh-config 插件在 `llm/stream` 瀑布式事件上处理。
