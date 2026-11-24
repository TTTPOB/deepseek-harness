---
kind: upgrade-guide
description: "SQLite 全文搜索拒绝升级前发出的游标，并允许在语料变化后继续翻页。"
---

# SQLite 全文搜索续页

[English](guide.md) | 中文

## 变更

SQLite 的 `searchSessions` 和 `searchEvents` 使用升级前发出的游标时会返回 `SESSION_QUERY_INVALID_CURSOR`。新游标从当前排名的相同偏移位置续页。语料变化可能使结果重复或遗漏，而不是返回 `SESSION_QUERY_STALE_CURSOR`。只读取元数据的 `pageSessions` 仍使用独立的快照和过期规则。

## 迁移

1. 丢弃尚未消费的全文搜索游标，不传 `cursor` 重新开始搜索。续页时保持规范化后的请求不变，包括过滤器和 `limit`。
2. 若汇总多页结果用于展示，按会话 id 或事件序号去重。确认无关会话有新活动后仍可继续翻页。无需迁移索引或会话数据。
