# Release the daily-driver UI forks

Use this procedure to publish the native plugin-manager modal and mobile terminal adaptation as official-name fork packages. Both packages live in the DSH repository; the independent mobile workbench consumes their UI behavior through public services.

## 1. Prepare the source

Develop and test in a feature worktree, then integrate the verified commits into `daily-driver`. Keep the CLI and Web bundle at `0.1.7-rc.2`. This release uses `0.1.7-rc.2-fork2` for `@deepseek-ai/dsh-client-ui-plugin-manager` and `@deepseek-ai/dsh-client-ui-sidebar-terminal`; retain the existing fork1 archives for recovery.

The [Release workflow](../../.github/workflows/daily-driver-release.yml) builds only these two packages for `daily-driver-v0.1.7-rc.2-fork7`. It downloads the unchanged Access packages from fork6 and UI settings from fork5 for the installed-artifact acceptance test.

## 2. Validate and publish

Run the two packages' focused tests, generate the Host Remote declarations, and build both packages through [the source preparation entry](../../scripts/daily-driver-source.mjs). Execute the terminal bundle-split test after building so its lazy-chunk checks run.

The workflow passes six tarballs to [the installed-artifact smoke](../../scripts/smoke-access-navigation-fork6.mjs): Connection fork2, frontend-static fork2, Gateway fork2, UI settings fork1, plugin manager fork2, and sidebar terminal fork2. The smoke evaluates the packaged manifests with the official compatibility checker, checks shared dependency resolution, and cold-starts the official CLI with a separate home and an ephemeral loopback port. It checks the authenticated boot graph and served UI executable content, including the terminal lazy chunk. The UI packages must pass compatibility without exemptions; the unchanged Access fixtures use the exact exemptions already verified by their release.

Only create and push the new tag after publication is authorized. The workflow publishes the two UI tarballs and `SHA256SUMS`, and refuses to overwrite an existing release. Component tests cover UI interaction; the cold-start HTTP smoke covers packaging and Loader publication. Neither replaces acceptance on the target phone.

## 3. Upgrade during a maintenance window

Publishing does not change the running Host. When installation and restart are separately authorized:

1. Stop the affected Host from an external maintenance process.
2. Replace only the two UI package global overrides with their immutable fork7 Release asset URLs, and install through pnpm. Preserve the official CLI/Web, Access overrides, independent mobile plugin, and existing configuration.
3. Start the Host and verify its served plugin-manager entry, terminal entry, and terminal lazy chunk. Open the phone UI and check the modal and terminal keyboard behavior.

Keep peer declarations accurate. Any required compatibility exemption must be tested on the packaged combination and recorded as an exact package/runtime pair. Keep the running installation unchanged when a restart cannot be scheduled.
