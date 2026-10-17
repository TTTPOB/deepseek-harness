# Daily-driver source delivery

## Local validation

Run commands from a dedicated source worktree with Node 24 and the pnpm version declared by the root manifest. [daily-driver-plan.mjs](daily-driver-plan.mjs) owns current capability selections, package directories and focused source tests: `session-query`, `core`, and `access`.

```sh
node scripts/daily-driver.mjs prepare session-query
node scripts/daily-driver.mjs verify session-query
node scripts/daily-driver.mjs build session-query
node scripts/daily-driver.mjs smoke session-query
```

`prepare` installs the frozen selected workspace closure and build tools. `verify` runs the command regressions, native build and focused source tests. `build` packs current manifests and their unpublished fork peer closure into `dist/daily-driver`; `smoke` checks tarball identities, installs copies outside the source tree, resolves packages through the official CLI and imports built entries before testing key behavior. Access builds include Host declarations needed by Client programs.

Package versions and artifact filenames come from the current package manifests. The official consumer version comes from `apps/cli/package.json`; it is an exact registry version, not `latest`. Artifact consumers do not inherit repository overrides or patches. Set `DSH_PI_AI_TARBALL` to an explicitly qualified local Pi tarball to test the Responses serializer fork; otherwise consumers resolve the adapter’s declared registry dependency. The source workspace pins the qualified Pi fork to its immutable Release asset; its serializer suite runs by default. For `verify core`, the explicit input temporarily replaces that canonical override through pnpm, runs the serializer suite, then restores both canonical dependency files and the frozen installation even after a failed check. A checkout resolving an official Pi instead prints an explicit serializer skip reason; publishing core still requires the explicit qualified input.

Session-query checks build the current Session, query, JSONL and SQLite packages together, including when publishing only one of them. Core checks cover setup/disposal, packaged configuration, Team preset scope switching/disposal, and the new subagent manager: resident sibling denial before holds and cold denial/resume hold cleanup. Access checks the shared package graph, browser entries, cookieless JWT navigation, localhost login, API rejection and served UI routes. Session-query and Access smoke grant exact-version permissions in their temporary profiles for artifacts whose packaged dsh peers fail the official runtime compatibility check; core checks the same exact-version admission in memory. Session-query and Access smoke launch a temporary loopback Web Loader with private `DSH_HOME` and an ephemeral port, then stop it and remove the temporary installation. Local execution of the session-query or Access smoke requires explicit authorization to launch that isolated Web process; CI executes it in the disposable runner. They do not test live Cloudflare ingress or an existing Host.

Independent plugins qualify their releases in their own repositories. Source delivery requires neither a sibling configuration checkout nor an independent plugin checkout. There are no unchanged-package Release fixtures in these selections; smoke prerequisites are built from the current checkout.

## Immutable release

The [release workflow](../.github/workflows/daily-driver-release.yml) is manually dispatched. Select the source ref containing the current workflow, an existing `daily-driver-*` tag at that ref, a capability selection, and optionally space-separated package directories to publish. A core release also requires an immutable qualified Pi tarball URL; the workflow downloads it and sets `DSH_PI_AI_TARBALL`. A release tag names the source snapshot, not a shared package version: asynchronously versioned packages can coexist.

Publish only through the GitHub Actions Release workflow (`.github/workflows/daily-driver-release.yml`); do not build and upload official Release assets locally. See the long-term upgrade manual in the separate configuration repository: `dsh-config/docs/upstream-upgrade.md`. Create and push a new tag only with separate authorization. Omitting package directories publishes the entire capability selection; selecting a subset still validates and builds the full smoke prerequisites. Existing release assets remain immutable.

Adding a release changes manifests and the explicit package selection, not workflow jobs. Add a capability check only for a new behavior that existing checks cannot exercise.

Installation, real profile changes, compatibility consent and activation of a daily Host require a separate maintenance task. These commands do not install into the user's installation or modify real profiles, sessions or storages.
