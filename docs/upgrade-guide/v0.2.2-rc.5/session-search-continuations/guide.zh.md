---
kind: upgrade-guide
description: "SQLite 全文搜索改变了多词匹配、事件搜索接口和续页游标。"
---

# SQLite 全文搜索

[English](guide.md) | 中文

## 变更

多词查询原来要求整段短语连续出现；现在，空格和大写 `AND` 要求各项都出现在同一条事件中，顺序不限。双引号表示精确短语，括号分组，大写 `OR` 优先于 AND，裸词末尾 `*` 匹配前缀。紧贴在项前面的 `-` 现在表示排除。查询至少需要一个正向项；Web 会话列表会把整个只有排除项的输入当成字面短语重搜。

SQLite 的 `searchSessions` 和 `searchEvents` 发出 v3 游标，并以 `SESSION_QUERY_INVALID_CURSOR` 拒绝包括 v2 在内的旧游标。v3 游标从当前排名的相同偏移位置续页。语料变化可能使结果重复或遗漏，而不是返回 `SESSION_QUERY_STALE_CURSOR`。只读取元数据的 `pageSessions` 仍使用独立的快照和过期规则。

事件搜索调用者传入 `sessionFilters`，而不是 `sessionId`，并从每条命中读取索引中的会话头信息，而不是读取 `page.session`。省略 `sessionFilters` 时搜索全库；过滤器中的会话 ID 不存在时，不产生结果。

## 迁移

1. 若要保留原来的连续短语匹配方式，把全文查询用双引号包起来，如 `"academic-source CLI"`。如果需要字面匹配以 `-` 开头的词或多个词，也用双引号包起来，如 `"-timeout retry"`。用已知事件确认命中。
2. 将 `searchEvents({ sessionId: id, query })` 替换为 `searchEvents({ query, sessionFilters: [{ kind: 'id', values: [id] }] })`。事件过滤条件仍放在 `filters`；从 `page.items[i].session` 读取每条命中的会话头信息。确认每条命中都属于请求指定的会话。
3. 丢弃尚未消费的全文搜索游标，不传 `cursor` 重新开始搜索。续页时保持规范化后的请求不变，包括过滤器和 `limit`。
4. 若汇总多页结果用于展示，按会话 ID 去重；事件结果按会话 ID 和事件序号的组合去重。确认无关会话有新活动后仍可继续翻页。无需迁移索引或会话数据。
