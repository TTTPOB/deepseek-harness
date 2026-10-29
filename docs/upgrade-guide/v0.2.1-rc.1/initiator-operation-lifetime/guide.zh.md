---
kind: upgrade-guide
description: "来源操作结算后，继承其上下文的回调会失去 Agent 发起方归因。"
---

# 发起方归因随操作结束

[English](guide.md) | 中文

## 变更

`ctx.agents.withInitiator(agent, operation)` 原先会让操作内创建的异步资源持续读取发起 Agent，直到这些资源结束或注册表被 dispose（资源释放）。现在，操作返回非 Promise 值、抛错或其返回的 Promise 结算时，发起方 slot 就会清空。仍存活的资源回调通过 `currentInitiator()` 读取到 `undefined`；若未建立新的发起方，`requireInitiator()` 会抛错。依赖脱离返回链的回调中隐式归因的插件受此影响。如果 Promise 的 species 阻止观察结算，该 Promise 会保留归因。

## 迁移

1. 让传给 `withInitiator()` 的操作返回完整的前台生命周期，使归因在跨 await 时持续可用。
2. 对脱离返回链且归 Agent 所属的工作，显式传递所需 Agent 或会话，并保留取消与 dispose 归属。对绝不能继承 Agent 的无关共享资源，使用 `withoutInitiator()` 启动。
3. 确认前台代码仍能读取其 Agent，而在操作内捕获的回调在结算后读取到 `undefined`。生命周期详情见 [Agent 包参考](../../../../packages/core/agent/README.zh.md)。
