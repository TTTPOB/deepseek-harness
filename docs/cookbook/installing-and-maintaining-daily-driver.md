# Install the personal Web distribution

English | [中文](installing-and-maintaining-daily-driver.zh.md)

This procedure keeps the official `@deepseek-ai/dsh@0.1.7-rc.2` CLI as the top-level package. The Web bundle fork owns its five runtime plugin dependencies and personal composition; the Web profile selects only `dsh-base` and `dsh-web-app`, with empty profile dependencies. Install in an isolated pnpm global directory and `$DSH_HOME` before changing a daily installation.

## 1. Obtain immutable inputs

Build and pack all six DSH forks from this baseline, not from an earlier DSH release: `dsh-subagent`, `dsh-llm-pi-ai`, `dsh-mcp-client`, `dsh-agent`, `dsh-agent-preset-registry`, and `dsh-web-app`, each at `0.1.7-rc.2-fork1`. Obtain Pi AI `0.85.1-fork1` from [its immutable release](https://github.com/TTTPOB/deepseek-harness/releases/download/daily-driver-v0.1.5-rc.2-fork1/earendil-works-pi-ai-0.85.1-fork1.tgz). Obtain progressive-tools `0.3.0`, workspace-overlay and workspace-envrc `0.2.0`, and the adapted Firecrawl `0.1.0-fork1` tarballs. MCP Panel `0.6.19` comes from npm. Do not put local `file:` paths in the published Web manifest.

The Release workflow downloads Pi AI from the existing immutable Release and progressive-tools from its own Release. Firecrawl needs an explicit immutable tarball URL (`firecrawl_tarball_url`, or `DSH_FIRECRAWL_TARBALL_URL` for a tag run). The exact tested source commits of overlay and envrc are required as `overlay_ref` and `envrc_ref` (or tag-run variables `DSH_OVERLAY_REF` and `DSH_ENVRC_REF`). Those sources must be available before release; local validation does not run the remote workflow.

The first release bootstraps in order: temporarily omit only overlay and envrc from the Web manifest while installing the DSH source tree; build the six DSH forks without changing the published manifest; restore its original bytes before packing the Web bundle. Then install, build and pack overlay against the new agent and preset-registry tarballs, followed by envrc against the same agent and preset-registry forks plus the new overlay tarball. The temporary overrides and derived source lockfiles stay on the CI runner. The original Web manifest with all five runtime dependencies is the only one packed. Finally the workflow checks the eleven-tarball project dependency closure and uploads the immutable release assets. Overlay and envrc do not require a separate preliminary Release.

## 2. Verify installation resolution

Pass the 11 tarball paths to `node scripts/daily-driver.mjs smoke`, in the order printed by its usage error: six DSH forks, Pi AI, progressive-tools, overlay, envrc, and Firecrawl. The script performs a temporary **project installation** of the official top-level CLI with pnpm 11.24 overrides, checks the Web bundle's dependency resolution and imported plugin entries, and records the tested runtime package, workspace and lockfile next to the first tarball. Its temporary project is removed on completion. It does not test pnpm global installation, profile bundle discovery, the Cordis Loader, a Web Host, or network-backed providers.

For the isolated production-style installation, configure pnpm global overrides for the same eleven fork/plugin tarballs, leaving `@deepseek-ai/dsh` itself official. Keep the plugin tarballs in an immutable directory for the lifetime of the installation. Initialize a separate `$DSH_HOME`, confirm the Web profile bundles are precisely `@deepseek-ai/dsh-base` then `@deepseek-ai/dsh-web-app`, and keep profile dependencies `{}`. Run `dsh --profile web --dump-config` to check personal rows and `standard-ptc`, then boot the isolated Host on a separate port. Endpoint addresses, credential references, user preset selection and private MCP server lists belong in that isolated profile patch, never the bundle.

## 3. Preserve immutable releases

Commit and integrate validated package changes into the release branch, tag `daily-driver-v0.1.7-rc.2-fork1` only after the prerequisite Pi AI/progressive assets, Firecrawl URL, and pinned overlay/envrc source commits are available, and run the existing release workflow. Never reuse an existing tag or replace its tarballs. A missing Firecrawl URL or plugin asset stops the release before publishing.
