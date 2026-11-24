# Agent Note: 全文搜索游标只绑定请求

Status: implemented

[English](2026-11-24-request-bound-search-cursors.md) | 中文

## 问题

SQLite 提供方的全文搜索游标绑定服务实例、规范化后的请求和语料代际（generation）；代际一变，下一页就以 `SESSION_QUERY_STALE_CURSOR` 失败（[原决策](../../archived/feature/2026-07-10-sqlite-session-query-provider.md)）。跨会话搜索使用全局代际，只要有发生变化的活跃会话被重新索引，它就会递增。活跃会话每追加一条事件都会被标记为已变化，其中包括 PTC 在每次嵌套工具调用前写入调用方会话的 `tool/ptc-dispatch-start` 记录。因此，模型在 PTC 里搜索时，两页之间改变语料的正是它自己。对一个安装环境 14 天记录的审计发现，在同一个 PTC 程序中，四个不同查询都在第一页返回后 29–39 毫秒续页失败；重新搜索同样失败。

游标还以转义后的 JSON 携带整个请求，外加一个 UUID。常见游标约 450 个字符，模型每次续页都要原样复制。仓库内的消费方各自绕开失效问题：实验性搜索工具与同批工具调用互斥执行，Host 会话搜索遇到失效游标就从第一页重来。

## 决策

[`SearchStore`](../../../../packages/session-query/session-query-sqlite/src/store.ts) 把游标编码为 `v2.<digest>.<offset>`。digest 是规范化请求的 SHA-256 前 12 字节，按 base64url 编码；offset 是已经返回的排名行数。`searchSessions` 与 `searchEvents` 要求 digest 与当前请求一致，按当前语料重新排名，从 offset 处开始返回。格式错误的游标、属于其他请求的游标以及旧格式游标都以 `SESSION_QUERY_INVALID_CURSOR` 失败。`pageSessions` 的元数据快照保留自己的游标和 `SESSION_QUERY_STALE_CURSOR` 过期行为。

提供方不再为游标维护代际：活跃会话行没有代际列，游标也不再记录服务实例，因此 Host 重启后游标仍然有效。持久代际仍用于给已提交的索引写入排序。

[Host 会话搜索](../../../../packages/api/session-controller/README.zh.md)跨提供方分页按会话 ID 去重；提供方拒绝续页时，整个调用失败，不返回部分结果。[实验性搜索工具](../../../../packages/experimental/tool-session-query/README.zh.md)按会话 ID 或事件 seq 对收集到的结果去重，并可与同批工具调用并行执行。[升级指南](../../../../docs/upgrade-guide/v0.2.2-rc.5/session-search-continuations/guide.zh.md)说明了游标格式的变化。

## 考虑过的替代方案

**保留代际绑定，但忽略调用方自己的事件。** 这只能修好 PTC 这一种情况。subagent 和其他打开的会话仍会推进全局代际，而且提供方还得知道调用方是哪个会话。

**为每个结果列表固定快照。** 提供方要在调用之间保存排名结果，并为它们指定所有者、内存上限和过期时间。没有消费方需要各页之间彼此一致，消费方需要的是能继续翻页。

**按分数和次序键做 keyset 分页。** BM25 分数依赖语料统计，语料一变，游标里记下的分数就不再对应同一位置。游标还会暴露分数，而搜索结果有意不包含分数。

**消费方遇到失效游标就重来。** Host 会话搜索原本就是这样做的。面向模型的工具一旦重来，就会重复模型已经拿到的页面；在持续有活动的情况下，重来的搜索还会再次失效。

**只从现有载荷里去掉代际。** 这能消除失效，但游标仍有约 450 个字符；digest 只用 16 个字符就能绑定同一请求。

## 后果

续页不再因为语料变化而失败。代价是：某页可能重复前面某页返回过的结果，也可能漏掉排到 offset 之前的结果；合并多页的消费方负责去重。本次变更前发出的游标会以 `SESSION_QUERY_INVALID_CURSOR` 失败一次，调用方不带游标重新搜索即可。游标缩短到约 20 个字符。
