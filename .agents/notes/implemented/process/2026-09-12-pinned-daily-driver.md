# Agent Note: pinned daily-driver adapter release

Status: implemented

English | [中文](2026-09-12-pinned-daily-driver.zh.md)

## Problem

The daily-driver fork needs live builtin model catalogs and final-only tool argument parsing. Official DSH 0.1.5-rc.1 supplies indexed Session reads and incremental token metering. Carrying old core overrides across its Session format changes would replace those maintained implementations. Automatic master merges also move the runtime beyond the deliberately selected release.

## Decision

The baseline is the immutable `dsh-v0.1.5-rc.1` commit `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`. Only the Pi adapter differs among DSH runtime packages. Its immutable Pi AI 0.85.1-dsh.1 dependency carries the final parsing option; DSH passes it on each request. Raw tool deltas and authoritative end arguments retain their protocol semantics.

The adapter restores validated provider catalogs before registering settings, refreshes active builtin routes, and forces refresh through model discovery. Explicit model selections inherit current descriptors; configured fields still win. Request snapshots remain immutable. The release baseline's deferred settings diagnostics remain available for repairing catalog-invalid models. Failed refreshes retain the last catalog, caller cancellation stops only that waiter, and fiber disposal aborts and awaits owned refreshes.

The manual release workflow never merges upstream or changes a branch. It checks the baseline and an explicit changed-path allowlist, builds the adapter, and installs the tarball through official reconciliation in an isolated home using a registry-installed official Host. The smoke fixes every transitive DSH package to the baseline because CLI caret ranges alone do not pin the runtime. The resulting runtime manifest and lockfile ship beside the single adapter tarball and SHA256SUMS. Tags include the DSH version and commit; an existing release cannot be overwritten.

Deferred-tool compatibility declarations remain deployment-owned even when the installed catalog sets them for named vendors. Private gateways can expose or reject these formats independently of the catalog model. The adapter offers the upstream-typed `deferredToolsMode`, `supportsToolSearch`, `supportsAdditionalTools`, and `supportsToolReferences` fields with protocol-specific validation and the existing model-over-route-over-catalog precedence. It does not synthesize pi-ai `addedToolNames`; an independently installed context integration owns that input. The two Responses switches preserve pi-ai's `additional_tools` precedence, so integrations requiring tool-search output disable or omit `supportsAdditionalTools`.

## Alternatives considered

Retaining three overrides duplicates upstream core behavior and couples the release to Session internals. Rebuilding the entire runtime archive duplicates package-manager dependency resolution. A bare exact CLI dependency still admits newer internal packages through caret ranges. Withholding deferred-tool fields forces gateways to impersonate catalog providers; enabling them globally assumes endpoint support and changes unrelated routes. The tested runtime manifest and lockfile keep ordinary package-manager installation while fixing the selected package family.

## Consequences

The development checkout and the daily runtime are independent. Consumers install the published runtime project with its frozen lockfile and install the adapter in each chosen profile themselves. Shared Cordis identity and official core packages remain installation-owned. Updating the baseline requires an explicit code review, new tests, and another immutable release; the scheduled sync is absent. The prior fork history is retained through integration commits, while its core changes and three-package release machinery are absent from the baseline diff.

## Testing

Pi provider regressions cover raw-delta order, final arguments, and default partial parsing. Adapter tests cover persistence, selection, forced refresh, failure retention, caller cancellation, and teardown. The Loader composition test restores a remote-only selected model before settings registration and observes descriptor updates. The release smoke verifies the actual published Pi dependency, official core versions, full Web composition startup, and live catalog behavior from the built override. Deferred-compat tests accept valid values and reject invalid, empty, misspelled, and misplaced fields. Keyless payload snapshots run configuration resolution and the real pi-ai serializers, including disabled paths and Responses precedence. The Loader test accepts all four declarations and verifies ordinary tools still reach the wire. No recorded Session transcript changes: the adapter does not add deferred context or model-visible text; serializer expectations stay beside their owning tests.
