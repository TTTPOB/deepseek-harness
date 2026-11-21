# Daily-driver source delivery

## Local validation

Run commands from a dedicated source worktree with Node 24 and the pnpm version declared by the root manifest. [daily-driver-plan.mjs](daily-driver-plan.mjs) owns current capability selections, package directories and focused source tests: `session-query`, `core`, `team-model-selection`, and `access`.

```sh
node scripts/daily-driver.mjs prepare session-query
node scripts/daily-driver.mjs verify session-query
node scripts/daily-driver.mjs build session-query
node scripts/daily-driver.mjs smoke session-query
```

`prepare` installs the frozen selected workspace closure and build tools. `verify` runs the command regressions, native build and focused source tests. `build` packs current manifests and their unpublished fork peer closure into `dist/daily-driver`; `smoke` checks tarball identities, installs copies outside the source tree, resolves packages through the official CLI and imports built entries before testing key behavior. Every selection runs the upstream source-only Typert pass before TypeScript compilation, emitting Host reflection and `/remote` Client projections with face-wide declaration merges. This metadata pass does not compile or bundle the repository: TypeScript builds only the selected artifact packages and their project-reference closure, and tsdown bundles only the artifact packages plus the cosmokit entry needed by browser consumers. Browser builds inline cosmokit; its `lib/index.js` must exist before client bundling, while TypeScript alone emits only `lib/types`.

Package versions and artifact filenames come from the current package manifests. The official consumer version comes from `apps/cli/package.json`; it is an exact registry version, not `latest`. Artifact consumers inherit only the canonical Pi override from `pnpm-workspace.yaml`, not repository-local links or patches. Set `DSH_PI_AI_TARBALL` to qualify another local Pi fork tarball; that explicit input wins over the canonical Release URL. The packed adapter keeps its registry dependency range, so every isolated consumer must stage the Pi override. Core smoke rejects an official Pi and exercises both configurable Responses stream guards regardless of whether the environment variable is set. The source workspace pins the qualified Pi fork to its immutable Release asset; its serializer suite runs by default. For `verify core`, the explicit input temporarily replaces that canonical override through pnpm, runs the serializer suite, then restores both canonical dependency files and the frozen installation even after a failed check. A checkout resolving an official Pi instead prints an explicit serializer skip reason; publishing core still requires the explicit qualified input. `team-model-selection` does not require the Pi input.

Session-query checks the Session, query, JSONL and SQLite packages together. Core checks awaited Agent setup, preset placement, Pi compatibility, MCP stdio limits, PTC direct-call exceptions and raw text. The `team-model-selection` selection packages the subagent manager, spawn tools, control tools, settings UI and Cordis tool reference. Its smoke imports the isolated tarballs and verifies that the browser module registers. Access checks browser entries, cookieless JWT navigation, localhost login, API rejection and served UI routes. Session-query and Access smoke start a temporary loopback Web Loader with a private `DSH_HOME`; run these smoke commands locally only when authorized to start that isolated process.

Independent plugins qualify their releases in their own repositories. Source delivery requires neither a sibling configuration checkout nor an independent plugin checkout. There are no unchanged-package Release fixtures in these selections; smoke prerequisites are built from the current checkout.

Locally, run doc-sync scripts gate by gate with `NODE_OPTIONS=--max-old-space-size=4096`; the aggregate’s `doc-typecheck` builds the entire Host reference graph. Leave whole-repository typecheck to `Daily-driver verify` CI.


## Long-term branch

- The long-term release branch is `daily-driver` on TTTPOB remote `fork` (github.com/TTTPOB/deepseek-harness); local `daily-driver` tracks `fork/daily-driver`, never the third-party upstream `origin`.
- Pi uses the same long-term branch name, `daily-driver`, on its TTTPOB remote `fork` (github.com/TTTPOB/pi); its local branch tracks `fork/daily-driver`.
- Develop and test on a separate branch or worktree.
- Before releasing, merge into `daily-driver`, push, and wait for `Daily-driver verify` (`.github/workflows/daily-driver-verify.yml`) to pass.
- Release only a commit on `daily-driver` through the immutable Release workflow below; tags and Release assets are immutable.
- On a workstation with about 13 GB RAM, run only capability/package-scoped checks locally with `NODE_OPTIONS=--max-old-space-size=4096`; leave heavy whole-repository typecheck, build, test and coverage checks to CI.

## Immutable release

The [release workflow](../.github/workflows/daily-driver-release.yml) is manually dispatched. Select the source ref containing the current workflow, an existing `daily-driver-*` tag at that ref, a capability selection, and optionally space-separated package directories to publish. Only a core release requires an immutable qualified Pi tarball URL; the workflow downloads it and sets `DSH_PI_AI_TARBALL`. A release tag names the source snapshot, not a shared package version: asynchronously versioned packages can coexist.

Publish only through the GitHub Actions Release workflow (`.github/workflows/daily-driver-release.yml`); do not build and upload official Release assets locally. See the long-term upgrade manual in the separate configuration repository: `dsh-config/docs/upstream-upgrade.md`. Create and push a new tag only with separate authorization. Omitting package directories publishes the entire capability selection; selecting a subset still validates and builds the full smoke prerequisites. Existing release assets remain immutable.

Adding a release changes manifests and the explicit package selection, not workflow jobs. Add a capability check only for a new behavior that existing checks cannot exercise.

Installation, real profile changes, compatibility consent and activation of a daily Host require a separate maintenance task. These commands do not install into the user's installation or modify real profiles, sessions or storages.
