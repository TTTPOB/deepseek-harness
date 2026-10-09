# Daily-driver source delivery

## Local validation

Run commands from a dedicated source worktree with Node 24 and the pnpm version declared by the root manifest. [daily-driver-plan.mjs](daily-driver-plan.mjs) owns current capability selections, package directories and focused source tests: `session-query`, `core`, `access`, and `subagent`.

```sh
node scripts/daily-driver.mjs prepare session-query
node scripts/daily-driver.mjs verify session-query
node scripts/daily-driver.mjs build session-query
node scripts/daily-driver.mjs smoke session-query
```

`prepare` installs the frozen selected workspace closure and build tools. `verify` runs the command regressions, native build and focused source tests. `build` packs current manifests into `dist/daily-driver`; `smoke` checks tarball identities, installs copies outside the source tree, resolves packages through the official CLI and imports built entries before testing key behavior. Access builds include Host declarations needed by Client programs.

Package versions and artifact filenames come from the current package manifests. The official consumer version comes from `apps/cli/package.json`; it is an exact registry version, not `latest`. The external Pi fork source has one owner: the override in [pnpm-workspace.yaml](../pnpm-workspace.yaml), shared by frozen source installation and the core artifact consumer.

Session-query checks build the current Session, query, JSONL and SQLite packages together, including when publishing only one of them. Core checks cover setup/disposal and packaged configuration; subagent checks rejected sibling messaging without orphaned holds. Access checks the shared package graph, browser entries, cookieless JWT navigation, localhost login, API rejection and served UI routes. Session-query smoke grants exact-version permissions in its temporary profile for artifacts whose packaged dsh peers fail the official runtime compatibility check. Session-query and Access smoke launch a temporary loopback Web Loader with private `DSH_HOME` and an ephemeral port, then stop it and remove the temporary installation. Local execution of the session-query or Access smoke requires explicit authorization to launch that isolated Web process; CI executes it in the disposable runner. They do not test live Cloudflare ingress or an existing Host.

Independent plugins qualify their releases in their own repositories. Source delivery requires neither a sibling configuration checkout nor an independent plugin checkout. There are no unchanged-package Release fixtures in these selections; smoke prerequisites are built from the current checkout.

## Immutable release

The [release workflow](../.github/workflows/daily-driver-release.yml) is manually dispatched. Select the source ref containing the current workflow, an existing `daily-driver-*` tag at that ref, a capability selection, and optionally space-separated package directories to publish. A release tag names the source snapshot, not a shared package version: asynchronously versioned packages can coexist.

With explicit publishing authorization, the equivalent local command is:

```sh
GH_REPO=TTTPOB/deepseek-harness RELEASE_TAG=daily-driver-example \
  node scripts/daily-driver.mjs release session-query \
  packages/session-query/session-query packages/session-query/session-query-sqlite
```

The example tag is a placeholder; create and push a new tag only with separate authorization. The command requires the local and remote tag objects to agree and the tag commit to be HEAD. It refuses an existing Release, runs prepare/verify/build/smoke, then creates a Release with exactly the selected tarballs and their `SHA256SUMS`. It never uploads to or edits an existing Release and never moves a tag. Omitting package directories publishes the entire capability selection; selecting a subset still validates and builds the full smoke prerequisites. Existing release assets remain immutable.

The [verification workflow](../.github/workflows/daily-driver-verify.yml) runs `session-query` on daily-driver pushes and accepts another capability through manual dispatch. Adding a release changes manifests and the explicit package selection, not workflow jobs. Add a capability check only for a new behavior that existing checks cannot exercise.

Installation, real profile changes, compatibility consent and activation of a daily Host require a separate maintenance task. These commands do not install into the user's installation or modify real profiles, sessions or storages.
