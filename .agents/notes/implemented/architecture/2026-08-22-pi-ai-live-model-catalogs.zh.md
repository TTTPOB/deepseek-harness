# Agent Note: pi-ai 内置路由跟随可持久化的实时模型 catalog

Status: implemented

[English](2026-08-22-pi-ai-live-model-catalogs.md) | 中文

## Problem

已安装 pi-ai catalog 随适配器依赖锁定，而提供方模型 id 与描述符会独立变化。若把这份静态数据当作完整内置 catalog，新模型就必须等待依赖发布，或由部署显式维护 `models` 列表。一次性 settings 发现能展示较新模型，但若不持久化完整描述符，路由重启后无法继续对仅远端存在的 id 使用 `modelOverrides`，离线进程也无法重建自己此前服务过的模型元数据。

[声明式提供方决定](2026-08-03-pi-ai-declared-provider-catalog.zh.md)在产品需求仅为一次性端点询问时拒绝了动态 catalog。内置 catalog 发现现在拥有独立的完整 pi-ai 描述符权威来源、持久化与离线路径，因此该否决不再适用于内置提供方。手工声明网关仍保留一次性 `/models` 询问，因为其端点仍是唯一来源，且通常只报告 id 而非完整描述符。

## Decision

`llm-pi-ai` 拥有一个隔离的 pi-ai `Models` 集合，用于管理内置 catalog。每个已安装提供方都由一个刷新实现包装，访问 `https://pi.dev/api/models/providers/<provider>`；经过校验的完整描述符按 id 替换匹配静态条目，并追加仅远端存在的条目。请求提供方绝不进入这个可变集合。每次列举、解析和流操作仍捕获一份不可变适配器快照，成功发布只会使下一次操作使用的已记忆 profiles 失效。

提供方缓存通过 `FileModelsStore` 存放在 `$DSH_HOME` 下。它使用按提供方加锁的原子写入和仅所有者权限，持久化 models、`checkedAt`、ETag 与 Last-Modified。插件启动时在注册 settings namespace 之前恢复每个已安装提供方的缓存，全程不联网；原因是 settings 会同步校验持久化分节，而配置选择或 `modelOverrides` 可能点名仅远端存在的模型。每条已配置内置路由都会定期刷新；`catalogRefreshIntervalMs` 同时作为新鲜度 TTL 与刷新周期，默认五分钟。非空显式列表从当前 catalog 中选择模型，并按[模型选择决定](../bug-fix/2026-08-22-live-catalog-model-selection.zh.md)继承描述符变化。

刷新工作按提供方共享，并按强度排序：缓存恢复、普通 TTL 刷新、强制刷新。较强请求若在较弱工作期间抵达，会在其后执行，而不是沿用较弱结果。调用方取消只停止自身等待；配置替换与插件释放会中止共享操作。替换提供方包装器会创建新的 pi-ai 发布代际，因此迟到响应无法发布到替代项中。

现有 `llm.discoverModels` 操作会强制并等待内置刷新，即使没有活跃路由也一样。它返回当前完整描述符投影；刷新失败报告 `DISCOVERY_FAILED`，最后发布的 catalog 继续服务。手工声明提供方继续使用草稿或已存储的请求凭据，询问其已配置 OpenAI 兼容 `/models` 端点。

## Alternatives considered

- **保持已安装 catalog 为权威并要求升级依赖。** 没有运行时可变状态，但模型可用性与元数据更正会被适配器发布节奏绑定。
- **发现只返回远端候选而不持久化。** 路由行为保持静态，但发现后接受的仅远端覆盖无法在重启后重建，离线时结果也会消失。
- **内置路由使用各提供方自己的 `/models` 端点。** 这些端点需要提供方凭据、协议不一致，且通常省略容量与兼容元数据；`pi.dev` 提供单一公开的完整描述符格式。
- **就地修改请求路径的 `Models` 集合。** 这样无需重建 profiles，但 pi-ai 会在凭据等待后惰性解析提供方，因此在途请求可能跨越 catalog 代际。隔离的可变管理器配合不可变请求快照，可以保持每操作一致性。

## Consequences

内置路由会跟随远端新增与更正描述符，同时保留静态离线基线；非空 `models` 列表会收窄所服务的描述符，但不会冻结其元数据。启动在 settings 注册前为每个已安装提供方执行有界本地读取，不发起 catalog 网络请求。固定公开端点无需提供方凭据；无法信任远端元数据的部署应使用由部署拥有协议、endpoint 与模型条目的手工声明路由。

`tests/models-store.spec.ts` 与 `tests/remote-catalog.spec.ts` 钉住持久化、条件 HTTP、校验、有界响应和陈旧代际发布。`tests/catalog-manager.spec.ts` 钉住恢复、刷新排序、取消、活跃路由周期、配置替换与释放。`tests/catalog.spec.ts` 钉住不可变请求快照、显式列表优先级、实时覆盖与持久化仅远端覆盖的启动。`tests/discovery.spec.ts` 钉住休眠提供方强制刷新、失败保留与未改变的手工声明端点路径。
