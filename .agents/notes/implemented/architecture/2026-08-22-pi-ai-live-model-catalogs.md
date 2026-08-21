# Agent Note: pi-ai builtin routes follow a durable live model catalog

Status: implemented

English | [中文](2026-08-22-pi-ai-live-model-catalogs.zh.md)

## Problem

The installed pi-ai catalog is pinned to the adapter dependency, while provider model ids and descriptors change independently. Treating that static data as the complete builtin catalog makes a newly available model require a dependency release or an explicit deployment-owned `models` list. A one-shot settings discovery can show newer models, but without durable descriptors the route cannot use `modelOverrides` for a remote-only id after restart and an offline process cannot reconstruct the model metadata it previously served.

The [declared-provider decision](2026-08-03-pi-ai-declared-provider-catalog.md) rejected a dynamic catalog while the product requirement was only one-shot endpoint interrogation. Builtin catalog discovery now has a separate authoritative source with complete pi-ai descriptors, persistence, and an offline path, so that rejection no longer applies to builtin providers. Hand-declared gateways retain their one-shot `/models` interrogation because their endpoint remains the only available source and usually reports ids rather than complete descriptors.

## Decision

`llm-pi-ai` owns an isolated pi-ai `Models` collection for builtin catalog management. Each installed provider is wrapped with a refresh implementation for `https://pi.dev/api/models/providers/<provider>`; validated complete descriptors replace matching static entries by id and append remote-only entries. Request providers never enter this mutable collection. Every list, resolve, and stream operation still captures an immutable adapter snapshot, and a successful publication only invalidates the memoized profiles used by the next operation.

The provider cache lives under `$DSH_HOME` through `FileModelsStore`. It persists models, `checkedAt`, ETag, and Last-Modified with provider-scoped locked atomic writes and owner-only permissions. Plugin startup restores every installed provider cache without network before registering the settings namespace, because settings validates its persisted section synchronously and a `modelOverrides` entry may name a remote-only model. Configured builtin routes with no non-empty `models` list refresh periodically; `catalogRefreshIntervalMs` is both the freshness TTL and cadence, defaulting to five minutes. A non-empty explicit list resolves only against the installed static catalog and never receives remote additions or metadata changes.

Refresh work is shared per provider and ordered by strength: cache restore, normal TTL refresh, then forced refresh. A stronger request arriving during weaker work runs after it rather than adopting its result. Caller cancellation stops only that waiter; configuration replacement and plugin disposal abort the shared operation. Replacing a provider wrapper creates a new pi-ai publication generation, so a late response cannot publish into the replacement.

The existing `llm.discoverModels` operation forces and awaits a builtin refresh even when no route is active. It returns the current complete descriptor projection, reports refresh failure as `DISCOVERY_FAILED`, and leaves the last published catalog serving. Hand-declared providers continue to interrogate their configured OpenAI-compatible `/models` endpoint with the draft or stored request credential.

## Alternatives considered

- **Keep the installed catalog authoritative and require dependency upgrades.** This has no runtime mutable state, but couples model availability and corrected metadata to the adapter release cadence.
- **Make discovery return remote candidates without persistence.** This keeps route behavior static, but a remote-only override accepted after discovery cannot be reconstructed after restart and the result disappears offline.
- **Use each provider's own `/models` endpoint for builtin routes.** Those endpoints require provider credentials, use incompatible protocols, and commonly omit capacities and compatibility metadata. `pi.dev` provides one public complete-descriptor format.
- **Mutate the request-path `Models` collection in place.** This avoids rebuilding profiles, but pi-ai resolves a provider lazily after credential awaits, so an in-flight request could cross catalog generations. The isolated mutable manager plus immutable request snapshots preserves per-operation consistency.

## Consequences

Builtin routes without explicit models follow remote additions and corrected descriptors while retaining a static offline baseline. Explicit lists remain deterministic deployment-owned replacements. Startup performs bounded local reads for every installed provider before settings registration; it performs no catalog network request. The fixed public endpoint needs no provider credential, while deployments that cannot trust remote metadata opt out per route with a non-empty `models` list.

`tests/models-store.spec.ts` and `tests/remote-catalog.spec.ts` pin persistence, conditional HTTP, validation, bounded responses, and stale-generation publication. `tests/catalog-manager.spec.ts` pins restore, refresh ordering, cancellation, active-route cadence, configuration replacement, and disposal. `tests/catalog.spec.ts` pins immutable request snapshots, explicit-list precedence, live overrides, and persisted remote-only override startup. `tests/discovery.spec.ts` pins forced dormant-provider refresh, failure preservation, and the unchanged hand-declared endpoint path.
