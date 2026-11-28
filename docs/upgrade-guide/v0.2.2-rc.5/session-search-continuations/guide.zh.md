---
kind: upgrade-guide
description: "SQLite 全文搜索改变了事件搜索的请求、结果头信息和续页游标。"
---

# SQLite 全文搜索

[English](guide.md) | 中文

## 变更

SQLite 的 `searchSessions` 和 `searchEvents` 使用升级前发出的游标时会返回 `SESSION_QUERY_INVALID_CURSOR`。新游标从当前排名的相同偏移位置续页。语料变化可能使结果重复或遗漏，而不是返回 `SESSION_QUERY_STALE_CURSOR`。只读取元数据的 `pageSessions` 仍使用独立的快照和过期规则。

事件搜索调用者传入 `sessionFilters`，而不是 `sessionId`，并从每条命中读取索引中的会话头信息，而不是读取 `page.session`。省略 `sessionFilters` 时搜索全库；过滤器中的会话 ID 不存在时，不产生结果。

## 迁移

1. 将 `searchEvents({ sessionId: id, query })` 替换为 `searchEvents({ query, sessionFilters: [{ kind: 'id', values: [id] }] })`。事件过滤条件仍放在 `filters`；从 `page.items[i].session` 读取每条命中的会话头信息。确认每条命中都属于请求指定的会话。
2. 丢弃尚未消费的全文搜索游标，不传 `cursor` 重新开始搜索。续页时保持规范化后的请求不变，包括过滤器和 `limit`。
3. 若汇总多页结果用于展示，按会话 ID 去重；事件结果按会话 ID 和事件序号的组合去重。确认无关会话有新活动后仍可继续翻页。无需迁移索引或会话数据。
