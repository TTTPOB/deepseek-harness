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

[Release workflow](../../.github/workflows/daily-driver-release.yml) 打包五个 DSH fork、Pi AI 与四个独立插件。其 CLI/profile lockfile 对应两套不同安装；项目依赖 smoke 检查兼容性和解析，不等于 Loader 激活。隔离 Host 组合已有独立验收，本操作不重复 LLM 调用，也不表示已修改真实日用安装。
