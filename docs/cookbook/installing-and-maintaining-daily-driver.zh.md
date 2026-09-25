# 升级个人 Web 安装

[English](installing-and-maintaining-daily-driver.md) | 中文

源码 checkout 可以已处于 0.1.7，而日用 global 安装和当前 Host 仍保持 0.1.5；只有用户以后在外部终端执行 `--apply` 才升级日用安装。这套 Linux/WSL 操作把官方顶层 `@deepseek-ai/dsh` CLI 升到 `0.1.7-rc.2`，使用源码仓库旁 `../artifacts/daily-driver-v0.1.7-rc.2-fork1` 中已有的 11 个 fork tarball。前提是 Node 24 与 pnpm 11.24；脚本不安装整个源码仓库依赖，也不抓取新的 Release 资产。全局安装仍依赖这些 tarball，应长期保留该目录。迁移只针对 `web` profile；`paper-chew`、`headless`、home 级 `cordis.patch.yml` 和旧 `.agent-presets` 目录保持不变。

## 1. 停旧 Host，预览

先在**外部终端按原来的启动方式停止旧 Host**；脚本不会按进程名寻找或杀死 Host。然后在源码仓库执行：

```sh
node scripts/upgrade-daily-driver.mjs
```

预览仅列路径、旧/目标版本、override 和行数、section 到 row 映射，以及将要创建的备份位置，不输出配置值。未知 settings section 会中止，不会默默丢掉。`!!js` 表达式按带标签数据保存，脚本不会执行。隔离安装可显式指定 `--home`、`--global-dir`、`--global-bin-dir`、`--artifacts`；测试时不能指向日用安装。

## 2. 一次执行升级

```sh
node scripts/upgrade-daily-driver.mjs --apply
```

脚本先完整复制旧 Web profile、全局 workspace overrides、旧 settings 与已安装 CLI 版本到输出的备份目录，并原样复制 `sessions`、`storages` 快照，不解析或修改原件。全局 pnpm workspace 保留其它 overrides 与 `allowBuilds`，设置 `blockExoticSubdeps: false`，将 11 个包名/版本限定键映射到持久 tarball 绝对路径。pnpm 以 `--config.enable-global-virtual-store=false --ignore-workspace add -g @deepseek-ai/dsh@0.1.7-rc.2` 安装官方顶层 CLI。新 Web profile 的 dependencies 为空、bundles 只含 base 和 web-app；patch 迁入原有配置，而已打包的 standard-ptc preset 与工具行不重复插入。执行时才读取当前 settings，保留改名 section 与原有 row 字段；归档旧 `settings.yaml` 以免新版再次自动导入。不必逐项 `dsh plugin remove`，也不手改旧 profile 的 lockfile 或 node_modules。

随后自行按原启动方式启动 Host，并私下检查 profile 与 UI；仅在能够保密输出时运行 `dsh --profile web --dump-config`，避免公开展开的凭据。此入口仅经过隔离 fixture 验证，**不表示日用 Host 已升级**，也不代替联网/LLM 验收。

## 3. 必要时回滚

再次停 Host，并使用 `--apply` 输出的实际备份路径：

```sh
node scripts/upgrade-daily-driver.mjs --rollback /absolute/path/to/backup
```

如果升级指定了隔离路径，回滚时传相同的 `--home`、`--global-dir`、`--global-bin-dir`。它重装旧顶层 CLI 版本、恢复全局 workspace 文件、旧 Web profile 和旧 settings，不碰其它 profile。**回滚不自动逆转 session/storage 数据**：新版 DSH 启动后可能已写入新格式。备份中的升级前快照留作明确的人工数据恢复，不可静默覆盖升级后的新会话。检查数据兼容问题后，自己重新启动旧 Host。升级失败会打印备份位置与回滚命令。

不可变资产的发布仍由[现有 Release workflow](../../.github/workflows/daily-driver-release.yml)负责；此本地入口不会 push、发布或重新打包。
