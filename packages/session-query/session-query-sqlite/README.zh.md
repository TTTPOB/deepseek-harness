---
description: "面向部署方与维护者的 SQLite FTS5 会话历史全文搜索后端，用于选择、配置或排查查询服务之上的全文搜索。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-query-sqlite

[English](README.md) | 中文

## 概述

使用本包可为会话历史增加带排序的 SQLite FTS5 搜索，既能跨会话搜索，也能在单个会话内搜索，并支持游标分页。它把实时与持久化历史索引到独立的派生数据库，因此搜索反映本进程观察到的状态，同时不会重写持久历史。精确读取、过滤与追踪仍通过同一查询 API 提供。已发布组合中的搜索是可选能力；配置 `openAt` 可让索引在启动时、首次搜索时打开，或永不打开。结果匹配 token 与短语，而非任意子字符串；每个索引路径只能由一个进程持有。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当组合需要对会话历史进行排序后的全文搜索时——例如 Web 内容搜索或 `/resume` 既往工作检索——挂载本包。常用路径是显式的：挂载插件、给它一个专用数据库路径，然后从代码调用 `ctx.sessionQuery.searchSessions` 或 `searchEvents`。

### 何时选择

当你想对既往会话进行带排序与分页的全文召回时选择它。它与 `dsh-session-query` 和会话服务一起使用；持久化后端可选但建议挂载，这样重启后持久化历史仍可搜索。不要把 `path` 指向 session-persistence 数据库——本包拥有独立的派生索引。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    path: /absolute/path/to/session-search.db
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `path` | 必填 | 专用派生索引 SQLite 路径，或 `:memory:`；POSIX 上缺失的路径会以仅所有者可访问的方式创建 |
| `keysPath` | `<path>.keys.db` | 专用文档键旁路库路径，或 `:memory:`（`path` 为 `:memory:` 时的默认值）；必须与 `path` 不同 |
| `openAt` | `startup` | `startup` 在激活时打开；`first-search` 把 SQLite 模块推迟到首次搜索；`never` 关闭全文搜索，继承的读取保持可用 |
| `warmupWaitMs` | `3000` | 跨会话搜索等待后台预热的最长时间（毫秒）；`0` 表示立即返回 |
| `journalMode` | `wal` | `wal`、`delete`、`truncate` 或 `persist` |
| `synchronous` | `full` | 仅 WAL 模式支持 `normal`，应用于主库和旁路库 |
| `defaultLimit` | `20` | 请求省略 `limit` 时的分页大小 |
| `maxLimit` | `100` | 接受的最大请求分页大小 |
| `snippetChars` | `240` | 按 Unicode 码点计算的最大 snippet 长度 |
| `readWindowMax` | `50` | 继承的 `readEvent()` 的 `before`/`after` 原始事件数上限 |
| `persistedReadConcurrency` | `4` | 继承批量读取的并发持久化日志读取数 |
| `preparedSessionCacheSize` | `5` | 继承的 `observeSession` 读取器为复用保留的冷 prepared-Session 观察数 |
| `metadataCacheTtlMs` | `5000` | 继承的元数据新鲜度窗口（毫秒），0 关闭复用 |
| `sessionPageSnapshotTtlMs` | `60000` | 继承的会话列表快照有效期（毫秒） |
| `sessionPageSnapshotCapacity` | `8` | 继承的会话列表快照容量 |
| `maxIndexedSessionBytes` | `33554432` | 读入索引的持久化日志产物字节上限；超过该值的会话不进入搜索，并通过 `ctx.logger.warn` 报告 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-query-sqlite)是每个受支持字段及其 JSDoc 的穷尽式真源。

<a id="search-behavior"></a>
### 搜索行为

`openAt: startup` 在激活时启动后台预热；`openAt: first-search` 在首次搜索时启动。全库搜索最多等待 `warmupWaitMs` 毫秒；索引仍未就绪时返回可重试的 `SESSION_QUERY_INDEX_WARMING`。文档键就绪后，带 `id` 过滤器的 `searchEvents` 可直接刷新并搜索指定会话，无需等待全库预热。取消请求只取消该请求的等待。

`searchSessions` 按每个会话匹配度最高的事件对命中分组；`searchEvents` 返回单条事件以及同一索引观察的 `session` 头信息。两种方法都支持 `sessionFilters: [{ kind: 'id', values: ids }]`；省略会话过滤器时搜索全库，不存在的 ID 不产生结果。元数据过滤器在排序前缩小结果；默认搜索全部 `current`、`shadowed` 与 `log-only` 事件。
#### 查询语法

| 写法 | 匹配方式 |
|---|---|
| `alpha beta` 或 `alpha AND beta` | 同一事件包含所有项，顺序和相邻关系不限 |
| `alpha beta OR gamma` | 等同 `alpha AND (beta OR gamma)`；只有独立大写 `OR` 是运算符 |
| `"alpha beta"` | 词元顺序一致且紧邻；引号中的字面双引号写成 `""` |
| `alpha -beta`、`alpha -"beta gamma"`、`alpha -(beta OR gamma)` | 排除紧贴 `-` 的项；单独写的 `-` 不作运算符 |
| `alph*` | 裸词末尾 `*` 匹配最后一个词元的前缀 |

其他标点按字面文本分词：`reveal.js`、`academic-source` 和路径要求各自分出的词元按顺序相邻。小写 `and`、`or`、`not` 是普通词。没有词元的项被忽略。引号或括号不配对、空括号组、括号嵌套超过 16 层、缺少 `OR` 操作数、子组或分支只有排除项、或没有词元时返回 `SESSION_QUERY_INVALID_QUERY`。整个查询只有排除项时返回 `SESSION_QUERY_EXCLUSION_ONLY`；Web 会话列表在收到该码后将原输入作为一个字面短语重搜。

排序使用同一个历史 BM25 背景。单短语排序除去两来源共用的 IDF，保持原有结果顺序。复合查询累加去重后的正向短语得分；两部分用相同的历史平均文档长度与各短语的历史 IDF。没有出现的 OR 项和排除项不计分。被实时副本遮蔽的历史正文只参与背景统计。历史没有词元时使用实时平均长度；历史没有匹配的短语使用 IDF 1。分数相同时依次按事件时间、会话 ID 和事件序号排序。完整表达式确定最长为 `snippetChars` 个 Unicode 码点的摘录，不返回分数。

每个不透明的 v3 游标绑定规范化后的搜索请求。如果游标由旧搜索语义生成，请重新开始搜索。续页会对当前语料重新排名，从游标记录的位置开始返回。若两页之间语料发生变化，结果可能重复或遗漏。

`unicode61` tokenizer 匹配 token 与短语，而非任意子字符串：`AI` 不匹配 token `BRAID`。需要执行字面、空白灵活的字符串子串扫描时，使用带 `text` 子句的 `ctx.sessionQuery.filterEvents()`。

### 何时推迟或关闭搜索

使用 `openAt: first-search` 时，服务在不导入 `node:sqlite`、不打开索引的情况下激活，把 SQLite 的实验性警告推迟到首次实际搜索；无效数据库让首次搜索失败，而不是服务激活失败。使用 `openAt: never` 时，全文搜索对该部署关闭：`searchSessions` 与 `searchEvents` 在任何请求规范化之前就以 `SESSION_QUERY_SEARCH_DISABLED` 失败，而继承的全部精确读取、过滤与追踪保持可用。请求超过编译谓词预算（会话和事件谓词合计 14 个）或 SQLite 可移植的 32,766 绑定上限时，会在准备语句前以 `SESSION_QUERY_INVALID_FILTER` 失败。

### 失败与恢复

带类型的 `SessionQueryError` 失败携带稳定代码：搜索配置为关闭时返回 `SESSION_QUERY_SEARCH_DISABLED`；索引无法打开或对账时返回 `SESSION_QUERY_INDEX_FAILED`；游标格式无效、版本过旧或不属于该请求时返回 `SESSION_QUERY_INVALID_CURSOR`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释后端背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本后端建立在一个分离与两项承诺之上：

- **派生索引，绝不动源存储。** FTS 行存放在专用可丢弃数据库中；这里的代码从不打开 session-persistence 数据库。
- **实时优先的观察。** 已挂载的实时会话优先于同一会话的历史索引。
- **自有查询语言。** 解析器只生成自身支持的逻辑运算；用户查询项一律作为引号内的文本交给 FTS5。

设计历史记录在 [SQLite FTS5 会话搜索笔记](../../../.agents/notes/archived/feature/2026-07-10-sqlite-session-query-provider.md)与[统一服务决策](../../../.agents/notes/archived/architecture/2026-07-23-unified-session-query-service.md)中。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务：配置、openAt 生命周期、后台预热与变化跟踪 |
| [`src/query.ts`](src/query.ts) | 请求规范化、参数化谓词、摘录、谓词与绑定预算 |
| [`src/query-syntax.ts`](src/query-syntax.ts) | 查询词法、语法树、FTS 表达式与正向短语去重 |
| [`src/bm25.ts`](src/bm25.ts) | 连接本地 token probe 与历史 BM25 校准 |
| [`src/schema.ts`](src/schema.ts) | 数据库 schema、application id 归属、原地重置、仅所有者文件创建 |

### 索引生命周期

一个 worker 独占 SQLite 和 JSONL 读取器，在 Host 线程之外读取、解压和投影冷日志。每个变化的持久化会话会在一次事务中提交其 revision、FTS 行、文档键及新世代；重开跳过已提交的 revision。生命周期事件标记变化的会话，实时投影在 Host 上分批让出。非 JSONL 后端仍在其服务所在的线程通过通用持久化接口提供原始日志。

复合查询先把完整表达式选出的两份候选保存在连接内的临时表，再对每个正向短语在各来源走一次 MATCH。交叉连接以 FTS 游标为外循环，先按文档 rowid 过滤候选再调用 `bm25`。只有有界结果页执行完整表达式高亮。修改实时正文时，同一写入更新其 FTS 记录及词元数。

公开 `bm25` 在权重 1 和 2 的分数用于恢复短语 IDF 和词频，包括重叠匹配。复合评分将反推词频四舍五入为整数，并用 FTS5 的历史词元总数除以文档数得到平均长度。单短语评分仍从一个含词元的历史文档校准长度；每次成功提交历史写入后失效该校准。

### Schema 归属

数据库携带 application id 与 schema 版本 8。打开时拒绝其他应用程序拥有的文件或规范数据库，拒绝未知用户表；只有已识别的不兼容派生 schema 才会原地重置——因此不相关或 session-persistence 数据库绝不会被触碰。在 POSIX 文件系统上，缺失的目录与数据库文件以仅所有者可访问的方式创建（进程 umask 前为 `0700` 与 `0600`）。每个派生索引路径在一个进程中只能由一个服务拥有；世代与 TEMP 遮蔽状态由连接持有。

文档键旁路库从 schema 1 原地升级，主库保持原有 schema 与路径。世代不匹配时，旁路库从主 FTS 表开始或继续分批重建，不读取会话日志。每批提交时记录进度，查询不会使用半成品。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享查询服务逐步进入类型级约定与设计证据。

- [会话查询子系统参考](../../../docs/subsystems/session-query.zh.md)——本后端实现的完整类型级约定。
- [dsh-session-query](../session-query/README.zh.md)——服务定义：本后端继承的精确读取、过滤与追踪。
- [dsh-tool-session-query](../../experimental/tool-session-query/README.zh.md)——调用这些搜索方法的面向模型消费方。
- [SQLite FTS5 会话搜索](../../../.agents/notes/archived/feature/2026-07-10-sqlite-session-query-provider.md)——搜索语义、对账与 tokenizer 决策。
- [JSONL 会话持久化](../../session/session-persistence-jsonl/README.zh.md)——本可丢弃索引观察的权威 Session store；其 root 必须与本包的数据库路径分开。

-----

<a id="model-experience"></a>
## 模型体验

无，因为后端只向调用方返回排序后的命中，不注册面向模型的上下文。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本包何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用 SQLite 对比或任务积压。

- **无调用方授权**——这是上下文范围内的可信服务；模型工具或 UI 必须强制执行自己的访问策略。
- **worker 同步执行查询**——大型 MATCH 可能让其他索引操作在 worker 上排队，但不会阻塞 Host 事件循环。
- **Token 召回，而非任意子字符串**——`unicode61` tokenizer 不会匹配更大 token 中的子字符串；对字面扫描使用 `filterEvents()`。
- **AND 只在单条事件内生效**——词散落在同一会话的不同事件中时，不算匹配。
- **单一所有者的派生索引**——每个索引路径必须仅归一个进程中的一个服务所有；不支持外部写入者与多进程共享。
- **外部文件更改不实时发现**——其他进程修改持久化文件不会产生当前进程的生命周期通知；重启查询服务或替换持久化服务后，首次搜索重新扫描元数据。
- **超大会话不进入搜索**——索引绝不会读取产物超过 `maxIndexedSessionBytes` 的存储日志；它会为每个此类会话通过 `ctx.logger.warn` 发出警告，并保持其余语料库可搜索。越过该上限也会驱逐已索引的会话，因此查询绝不会用存储日志已超出其大小的旧行作答；降低上限则驱逐所有超过它的会话。提高该上限即可纳入该会话，但构建开销与它的大小成正比。未提供 `SessionPersistenceSnapshot.sizeBytes` 的后端不受此上限约束。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放设计问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

#### 打包后的 worker 冒烟测试

在临时 pnpm 前缀中安装 SQLite 与 session-query 的 tarball 和目标 JSONL 持久化包。从本包目录运行 `node tests/pack-smoke.mjs <prefix>`，核对 worker 能解析已安装的 JSONL peer 并索引一条压缩日志。测试不启动 Host。

#### 未来：其他 tokenizer 与搜索提供方

`unicode61` tokenizer 的选择牺牲子字符串召回，以换取较小的索引体积与双字符 token 支持；trigram 备选方案经实测后被否决。切换 tokenizer 或增加另一个搜索后端会改变索引召回，并需要各自的对账与世代方案。

</details>
