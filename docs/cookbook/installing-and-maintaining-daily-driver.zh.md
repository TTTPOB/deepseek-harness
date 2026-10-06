# 维护共用插件日用安装

[English](installing-and-maintaining-daily-driver.md) | 中文

这套 Linux/WSL 操作使用官方 `@deepseek-ai/dsh@0.1.7-rc.2` CLI 和官方 Web app，配合持久目录 `../artifacts/daily-driver-v0.1.7-rc.2-fork1` 中的五个 DSH fork、Pi AI fork 和四个普通插件 tarball。MCP Panel 固定从 npm 安装 `0.6.19`。前提为 Node 24 和 Corepack pnpm 11.24.0。脚本不下载或发布资产，不启停 Host，也不修改运行中的会话。

全局 pnpm overrides 只管理五个官方同名 fork 与 Pi AI。每个消费 profile 将相同的五个独立插件作为普通 dependencies 安装（四个本地 tarball 加 MCP Panel）；官方 fork 不进入 profile dependencies。`$DSH_HOME/cordis.patch.yml` 为所有 profile 唯一声明共用插件和个人 preset。原有全局配置（含 MCP）优先；原 profile patch 中的共用插件参数迁入对应全局 insert 行，并保留 `!!js` 表达式。未来真正属于某个 profile 的配置才放入 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`。Web bundles 保持 base 与官方 Web app；其它 profile 保留原有 bundles。

## 1. 预览现有 Web profile

在源码 checkout 执行：

```sh
node scripts/upgrade-daily-driver.mjs --dry-run
```

预览只读路径、版本及行数，不写文件或打印配置值。缺少 `settings.yaml` 是正常情况；如果存在，受支持的旧 section 会迁入 Web 行，apply 时归档旧文件；未知 section 会报错而非丢弃。隔离 fixture 请显式传入 `--home`、`--global-dir`、`--global-bin-dir`、`--artifacts`。

## 2. 按需执行，再安装另一消费 profile

先在外部按原启动方式自行停止 Host；以下命令供日后明确的维护窗口使用，不是开发期间对当前 Host 执行的命令：

```sh
node scripts/upgrade-daily-driver.mjs --apply
node scripts/upgrade-daily-driver.mjs --profile OTHER_EXISTING_PROFILE --apply
```

第二条是可选命令，目标 profile 必须已经存在；不会自动迁移 `paper-chew`，也不改其 bundles。每次 apply 备份选定 profile 全部内容、全局 workspace、home patch 和已有 settings，并为 sessions/storages 留快照而不修改原件。pnpm 使用 `auto-install-peers=false` 管理 profile 依赖、lockfile 和 modules；其它 profile dependencies 与无关 global overrides 保留。Web profile 只有 base/Web app 两个 bundles。之后自行重启 Host，私下检查最终组合；`--dump-config` 可能展开凭据，不要公开输出。

## 3. 必要时回滚选定 profile

自行停 Host，使用对应 apply 输出的备份路径：

```sh
node scripts/upgrade-daily-driver.mjs --rollback /absolute/path/to/backup
```

非 Web profile 加上 `--profile OTHER_EXISTING_PROFILE`；apply 若显式指定了 `--home`、`--global-dir`、`--global-bin-dir`，回滚时保持一致。回滚恢复该 profile、home patch、全局 workspace 和原有 settings，并重装记录的顶层 CLI 版本。它**不会**用旧 sessions/storages 快照覆盖新数据：之后可能已有新会话。快照只能单独人工审查后恢复。

[Release workflow](../../.github/workflows/daily-driver-release.yml) 保留 fork1 的五包路线，并为 `daily-driver-v0.1.7-rc.2-fork2` tag 单独发布 subagent。fork2 Release 只有 `deepseek-ai-dsh-subagent-0.1.7-rc.2-fork2.tgz` 和 `SHA256SUMS`：校验 checksum 后仅替换全局 `@deepseek-ai/dsh-subagent` override，其余四个 DSH fork1 override、Pi AI fork1、CLI/Web 与独立插件均不变。上面的升级脚本仍针对完整 fork1 资产，不能用于仅含 subagent 的 Release。fork2 job 运行 continuation 回归，在隔离 CLI 项目安装 tarball，检查构建入口 import 和实际 override 解析；这不等于 Loader 激活或已修改真实 Host 安装。

Release workflow 还会为 `daily-driver-v0.1.7-rc.2-fork3` tag 单独发布 session-query。该 Release 只有 `deepseek-ai-dsh-session-query-sqlite-0.1.7-rc.2-fork1.tgz` 和 `SHA256SUMS`：校验 checksum 后仅替换全局 `@deepseek-ai/dsh-session-query-sqlite` override，五个 DSH fork override、Pi AI fork1、CLI/Web 与独立插件均不变。它的 job 运行 `packages/session-query` 回归，在隔离 CLI 项目安装 tarball 检查构建入口 import 与实际 override 解析，并断言 `maxIndexedSessionBytes` 默认值与 schema 对越界值的拒绝；这不等于 Loader 激活或已修改真实 Host 安装。`build` 与 `publish` job 会跳过 fork2 与 fork3 两个 tag。产物超过 `maxIndexedSessionBytes` 的会话不进入全文搜索，并通过插件的 `ctx.logger.warn` 报告一次。

## 4. 验证 fork4 Release，不应用到本机

`daily-driver-v0.1.7-rc.2-fork4` 专用 job 只发布 `deepseek-ai-dsh-session-persistence-jsonl-0.1.7-rc.2-fork1.tgz`、`deepseek-ai-dsh-session-query-sqlite-0.1.7-rc.2-fork2.tgz` 与 `SHA256SUMS`；通用 `build` 与 `publish` job 跳过该 tag，fork2 与 fork3 路线不变。两个 fork 配合直属子来源的 stat 修订与生命周期 dirty 文档增量对账，保留索引大小上限；其他进程修改持久化文件不会实时触发发现，查询服务重启或持久化服务换源后才重新扫描元数据。官方 CLI/Web、会话与持久化/查询定义包、其他 overrides 和独立插件不变。

下载并校验两个 tarball 后，在源码 checkout 运行可复用的[隔离 smoke](../../scripts/smoke-session-index-fork4.mjs)：

```sh
node scripts/smoke-session-index-fork4.mjs \
  dist/daily-driver/deepseek-ai-dsh-session-persistence-jsonl-0.1.7-rc.2-fork1.tgz \
  dist/daily-driver/deepseek-ai-dsh-session-query-sqlite-0.1.7-rc.2-fork2.tgz
```

smoke 在临时安装副本中通过 pnpm overrides 搭配官方 `dsh@0.1.7-rc.2`，检查实际模块解析、构建入口、官方定义包与 Cordis 的共享身份、不变搜索及关闭末尾落盘，并清理副本；它不启动 Host，不改真实安装、profile 或会话。fork4 发布验证不应用到当前本机；日后明确维护窗口中仅替换这两个全局 overrides，不对该两包 Release 运行完整 fork1 升级脚本。

## 5. 不发布，只验证源码

在干净 worktree 中使用 Node 24 和 pnpm 11.24.0。已提交的 workspace override 将 `llm-pi-ai` 使用的 `@earendil-works/pi-ai@0.85.1-fork1` 固定到既有不可变 Release URL；官方 0.85.1 patch 不适用。修改依赖组合时用 `pnpm install --lockfile-only --ignore-scripts` 正规生成源码 lockfile，再使用 frozen 准备入口：

```sh
CI=true node scripts/daily-driver-source.mjs install packages/session/session-persistence-jsonl packages/session-query/session-query-sqlite
pnpm --config.verify-deps-before-run=false run build:native-system
pnpm --config.verify-deps-before-run=false exec vitest run packages/session/session-persistence-jsonl/tests/catalog-migration.spec.ts packages/session/session-persistence-jsonl/tests/jsonl.spec.ts packages/session-query/session-query/ packages/session-query/session-query-sqlite/ packages/session-query/tool-session-query/
node scripts/daily-driver-source.mjs build packages/session/session-persistence-jsonl packages/session-query/session-query-sqlite
```

打包后执行第 4 节的双包 tarball smoke。验证其他 Host 包时替换包目录，并明确选择对应聚焦测试和隔离 tarball smoke。安装只选择目标依赖 closure、native 构建工具、Typert 和 root 工具 importer，不选择 root 的 workspace 依赖 closure。后续源码命令关闭 pnpm `verify-deps-before-run`，避免它静默安装整个 workspace。构建将 tsdown workspace 发现限制到每个目标；仅用 `-F` 仍会加载无关包配置。声明 `dsh.client` 的目标会在打包前同时构建 Host 和 Client 两端。所选 closure 之外的测试需要额外安装目标；默认选择不包括无关的 session-log-export UI 测试。

[源码验证 workflow](../../.github/workflows/daily-driver-verify.yml) 由 `daily-driver` push 或手动 dispatch 触发，只有仓库只读权限，绝不发布。dispatch 接受空格分隔的 `packages`、`tests` 和仓库 Node `smoke` 脚本及参数；自定义包必须显式指定 tests 和 smoke。缓存只保存全局 pnpm store，以 runner OS、pnpm 版本和源码 lockfile 为 key，并使用同 OS/版本恢复前缀。审查后 push 默认分支播种后续 tag workflow 可读取的缓存，再 dispatch 同一 workflow 比较缓存复用。下一次子包发布 job 可复制其 store/cache 步骤和源码准备/构建命令，同时保留该 job 的不可变 tag 身份校验及针对性 smoke。既有 fork1/fork2/fork3/fork4 发布 job 保留旧准备逻辑作为历史路线；重跑固定旧 tag 不会应用本次优化。不要 dispatch 发布 workflow 来测安装性能。

## 6. 发布 Access 配套包

`daily-driver-v0.1.7-rc.2-fork6` job 只发布 `0.1.7-rc.2-fork2` 的 `dsh-client-connection`、`dsh-host-frontend-static`、`dsh-api-gateway` 三包和 `SHA256SUMS`。三个全局 overrides 配套使用，保留不可变 fork5 的 `dsh-client-ui-settings@0.1.7-rc.2-fork1`、官方 CLI/Web 和无关 overrides。历史 fork1–fork5 job 保持不变；通用 build/publish 跳过 fork6。该 job 复用 frozen 源码准备、全局 store 缓存、聚焦回归和双端构建；UI settings 仅下载并校验 checksum 后用于 smoke，不重新发布。

1. 校验三个新 tarball 的 checksum 和 fork5 沿用的 UI settings checksum。按 connection、frontend-static、gateway、UI settings tarball 顺序运行[官方 CLI 冷启动 smoke](../../scripts/smoke-access-navigation-fork6.mjs)。它在 `dist/smoke` 下安装官方 rc.2 与四个 overrides，核对实际版本、共享 peers 和全部四包的兼容性判断，在隔离 home 中用官方 CLI 授予所需精确豁免，再启动真实 Web profile。只 mock 外部 Access JWKS fetch。验收覆盖不依赖 DSH Cookie 的跨站 Access 文档导航、localhost Cookie 回退、管理权限、实际提供的 gateway/controller graph、未放宽的 API 跨站 fence 和假 JWT 拒绝；不声称完成真实 Cloudflare 浏览器验收。
2. 按 [Connection 配置](../../packages/client/connection/README.zh.md)设置 Access，并移除只调用同步认证接口的旧根页登录插件。官方 rc.2 checker 对照 rc.2 runtime 版本时，会拒绝 frontend-static 和 gateway fork2 的精确 Connection peer 要求。明确接受此精确组合可能崩溃或损坏数据的风险后，在另行授权的维护窗口授予这两个 profile 本地豁免：

```sh
dsh plugin --profile web allow-version @deepseek-ai/dsh-host-frontend-static@0.1.7-rc.2-fork2 --dsh-version 0.1.7-rc.2 --accept-risk
dsh plugin --profile web allow-version @deepseek-ai/dsh-api-gateway@0.1.7-rc.2-fork2 --dsh-version 0.1.7-rc.2 --accept-risk
```

3. 仅在该维护窗口停止 Host、安装三个配套 overrides 并重新启动。只安装不会激活成品。豁免仅授权精确 package/runtime 组合，任一版本变化都需重新评估；见[兼容性与豁免](../../packages/boot/plugin-manager/README.zh.md#version-compatibility-and-exemptions)。不要对这个三包 Release 使用完整 fork1 升级脚本。

## 7. 准备仅 SQLite 的 fork11 发布

专用 `daily-driver-v0.1.7-rc.2-fork11` 路线只发布 `deepseek-ai-dsh-session-query-sqlite-0.1.7-rc.2-fork4.tgz` 和 `SHA256SUMS`。通用 build/publish 跳过该 tag。保留不可变 fork9 的 query fork1、不可变 fork10 的 JSONL fork3、官方 CLI/Web 和所有无关 overrides。当前已发布 Release 是 fork10；这条路线不会在日用 Host 安装或激活 fork11。

1. 使用 `scripts/daily-driver-source.mjs` 仅准备和构建 SQLite 目标，并运行其聚焦测试。使用只读验证 workflow 时，明确将 `packages` 设为 `packages/session-query/session-query-sqlite`、`tests` 设为 `packages/session-query/session-query-sqlite/tests`、`smoke` 设为下列脚本及参数；历史默认组合保持不变。

```sh
node scripts/smoke-session-query-fork11.mjs dist/daily-driver/deepseek-ai-dsh-session-query-sqlite-0.1.7-rc.2-fork4.tgz
```

2. [fork11 smoke](../../scripts/smoke-session-query-fork11.mjs) 使用 `gh` 下载沿用的 query/JSONL fixture 并校验其 Release checksum。它复用隔离的官方 CLI 安装、共享 Session/Cordis 身份检查、冷启动 Web Loader 和已保存的精确版本豁免。行为验收覆盖 BM25 literal phrase 排序、相同历史正文转为 live 并与无关长文档共存时的稳定排序、最新 live 正文遮蔽旧历史、未变化搜索和持久化 closing tail。它会删除自己的临时项目，不触及日用 Host。
3. 另行授权发布并校验新 checksum 后，在维护窗口只替换 SQLite 全局 override。使用下列官方命令接受精确 `@deepseek-ai/dsh-session-query-sqlite@0.1.7-rc.2-fork4` / DSH `0.1.7-rc.2` 组合的兼容性风险；不要扩大 peer 范围或复用 fork3 豁免。重启 Host 后安装包才激活。不要对这个单包 Release 使用完整 fork1 升级脚本。

```sh
dsh plugin --profile web allow-version @deepseek-ai/dsh-session-query-sqlite@0.1.7-rc.2-fork4 --dsh-version 0.1.7-rc.2 --accept-risk
```
