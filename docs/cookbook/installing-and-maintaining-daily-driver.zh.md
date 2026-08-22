# 安装与维护 daily-driver checkout

[English](installing-and-maintaining-daily-driver.md) | 中文

本教程通过三个 profile-local package override 或源码 checkout 安装 `daily-driver`，并维护其补丁版 `@earendil-works/pi-ai` Release。package Release 不生成可移植 deploy 目录：已有的兼容 DSH 安装负责提供未修改的运行时包与共享 peer。

## 前置条件

- Node.js `^22.19.0 || >=24.0.0`。
- 通过 Corepack 启用的 pnpm；仓库固定使用 `pnpm@11.7.0`。
- Git，以及访问 GitHub Releases 和 npm registry 的网络连接。
- 仅在调用真实提供方时才需要提供方 API key。凭据应放在环境变量或根目录 `.env` 中，绝不能写入受版本控制的配置。

## 安装 profile package Release

[`TTTPOB/deepseek-harness`](https://github.com/TTTPOB/deepseek-harness) 的 daily-driver Release 携带三个改动过的包。每个需要该分支行为的 profile 都应安装全部三个包：`session` 与 `token-meter` 是一组兼容组合，`llm-pi-ai` 则提供实时模型目录和补丁版 Pi AI 集成。

1. 下载最新 Release asset 并验证校验和：

```sh
release_dir="$(mktemp -d)"
tag=$(gh release list --repo TTTPOB/deepseek-harness --limit 100 --json tagName \
  --jq 'map(select(.tagName | startswith("daily-driver-v")))[0].tagName // empty')
test -n "$tag"
gh release download "$tag" --repo TTTPOB/deepseek-harness \
  --pattern 'deepseek-ai-dsh-*.tgz' \
  --pattern SHA256SUMS \
  --dir "$release_dir"
(cd "$release_dir" && sha256sum -c SHA256SUMS)
```

2. 通过官方 profile reconciliation 安装三个同名包：

```sh
dsh plugin --profile web add \
  "$release_dir"/deepseek-ai-dsh-session-*.tgz \
  "$release_dir"/deepseek-ai-dsh-token-meter-*.tgz \
  "$release_dir"/deepseek-ai-dsh-llm-pi-ai-*.tgz
```

命令输出的三条 `declares no dsh.bundle` warning 属于预期行为：这些包替换已有 base-bundle row，不会新增 patch layer。命令必须使用目标 profile 记录的 pnpm 版本；本工作区的 `web` profile 使用 `pnpm@10.13.1`。

3. 重启 DSH Host，然后确认这些依赖仍已安装：

```sh
dsh plugin --profile web why @deepseek-ai/dsh-session
dsh plugin --profile web why @deepseek-ai/dsh-token-meter
dsh plugin --profile web why @deepseek-ai/dsh-llm-pi-ai
```

其它 profile 也需要 override 时，应使用相应 profile 名重复安装。回退时，通过 `dsh plugin --profile <name> remove` 同时移除三个包名；现有 row 随后会重新解析到该 DSH 安装自带的包。安装完成后删除临时下载目录。

## 从 checkout 安装

1. 选择分支并启用仓库固定的包管理器：

```sh
git switch daily-driver
corepack enable
```

2. 严格按 `pnpm-lock.yaml` 记录的依赖图安装：

```sh
pnpm install --frozen-lockfile
```

Pi adapter 从不可变的 [`pi-ai-v0.84.2-dsh.1` GitHub Release](https://github.com/TTTPOB/pi/releases/tag/pi-ai-v0.84.2-dsh.1) 解析 `@earendil-works/pi-ai@0.84.2-dsh.1`。Release tarball 的 SHA-256 是 `0150271e4e825359bcb53382fea2f786189759725232efe9707cab48c3dea899`；pnpm 还会在 lockfile 中记录其 SHA-512 integrity。

3. 检查并构建 checkout：

```sh
pnpm run typecheck
pnpm run build
```

4. 确认已安装的补丁版本：

```sh
pnpm --filter @deepseek-ai/dsh-llm-pi-ai exec node -p 'require("./node_modules/@earendil-works/pi-ai/package.json").version'
```

命令必须输出 `0.84.2-dsh.1`。

5. 首次冒烟测试使用一次性 home 启动已构建的 Web profile：

```sh
DSH_HOME="$(mktemp -d)" pnpm dsh web --no-open --port 8080
```

打开命令打印的 URL，配置一个提供方，并确认 Models 视图能够发现模型。检查后停止进程。正常启动可以省略临时 `DSH_HOME`；此时会使用用户已配置的 DSH home 和持久 session。

## 发布 Pi 维护版本

[`TTTPOB/pi`](https://github.com/TTTPOB/pi) fork 只使用 `.github/workflows/dsh-ci.yml` 和 `.github/workflows/dsh-release.yml`；其默认分支不含继承自上游的 workflow。CI 从匹配的上游 npm 包恢复固定模型数据，构建 telemetry workspace 依赖和 Pi AI，运行 Biome 与 Pi AI 测试，然后触发 Release workflow。

1. 在干净 worktree 中以新的 Pi 上游 Release 为起点，重放 DSH 的 final-tool-argument commits，并保留两个 DSH workflow 文件。如果补丁分支名发生变化，应先更新两个 workflow 的分支过滤条件，再将该分支设为 fork 默认分支。

2. 在相同上游版本上发布后续补丁时，递增 `.github/workflows/dsh-release.yml` 中的 `PATCH_REVISION`。新的上游 `packages/ai/package.json` 版本会自动改变 Release tag 和包版本，但采用新上游基线时应把 revision 重置为 `1`。

3. 将补丁分支 push 到 `TTTPOB/pi`。`DSH Pi AI CI` 必须通过，`Release DSH Pi AI package` 才会发布 `pi-ai-v<upstream>-dsh.<revision>`。

4. 所有已发布 tag 和 asset 都是不可变的。workflow 会拒绝覆盖现有 Release；发布后发现缺陷时应使用更高 revision 修复，不能删除、替换或 clobber 已发布 asset。

5. 验证 Release 及其 checksum：

```sh
gh run list --repo TTTPOB/pi --workflow dsh-ci.yml --limit 3
gh run list --repo TTTPOB/pi --workflow dsh-release.yml --limit 3
gh release view pi-ai-v0.84.2-dsh.1 --repo TTTPOB/pi
release_dir="$(mktemp -d)"
gh release download pi-ai-v0.84.2-dsh.1 --repo TTTPOB/pi --pattern '*.tgz*' --dir "$release_dir"
(cd "$release_dir" && sha256sum -c earendil-works-pi-ai-0.84.2-dsh.1.tgz.sha256)
```

检查后应删除临时下载目录。

## 在 daily-driver 中采用新的 Pi Release

1. 替换 `packages/llm/llm-pi-ai/package.json` 中的精确 GitHub Release URL。tag 与 tarball 文件名都包含完整补丁版本。

2. 仅重新生成依赖解析，然后证明 lockfile 无需本地 artifact 即可安装：

```sh
pnpm install --lockfile-only
pnpm install --frozen-lockfile
```

3. 运行覆盖该依赖及其发布包路径的检查：

```sh
pnpm vitest run packages/llm/llm-pi-ai/tests
pnpm run typecheck
pnpm run build
pnpm run publint
```

4. 再次执行一次性 home Web 冒烟测试。模型发现应在临时 `$DSH_HOME/llm-pi-ai/models-v1` 下写入提供方 catalog，不得触碰正常 home。

5. 同时提交 manifest 和 lockfile。回退时让两个文件都指向前一个不可变 Release，并重复相同的安装与验证步骤；绝不能修改已经发布的 Pi asset。

## 日常运行

切换或更新分支后使用 `pnpm install --frozen-lockfile`，使依赖漂移直接失败，而不是重写 lockfile。浏览器 UI 使用 `pnpm dsh web`，一次性任务使用 `pnpm dsh --profile headless "task"`。实时 catalog 刷新失败时，最后一份有效 catalog 仍可使用；只应为诊断检查 `$DSH_HOME/llm-pi-ai/models-v1`，手动修改持久文件前应先复制整个 home。
