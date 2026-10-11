# Agent Note: Synchronous read-only SessionQuery capture

Status: proposed

English | [中文](2026-10-10-session-query-synchronous-capture.zh.md)

## Problem

A general context map needs the current Surface node order, message previews, route information, and measurement together. Reading the Surface and measuring separately can observe different states; restoring historical Sessions in a tree-external consumer duplicates Query source resolution, cold preparation, and lease management.

The [observation decision](../../implemented/architecture/2026-08-25-session-observations-and-projection-owned-client-state.md) already owns same-source reads and unpublished prepared Sessions; the [incremental memory analysis decision](../../implemented/architecture/2026-10-09-session-query-incremental-memory-analysis.md) further distinguishes canonical analysis from the latest Session state. This proposal adds synchronous Session sampling without superseding either decision or restoring the [convenience APIs proposed for removal](../simplification/2026-09-19-trim-session-query-convenience-api.md).

## Proposal

Add a narrow `captureSession` entry point to the owned SessionQuery fork. Source resolution and preparation may be asynchronous; after selecting a live or prepared Session, sample in one synchronous, read-only callback, return a fixed consumer-owned DTO, and release the read lease in finally.

Query owns source resolution, cancellation, preparation mode, observation cut, and leases; the consumer copies the required nodes, previews, and metadata and calls the existing token-meter. Query does not depend on token-meter, map DTOs, or active compaction policy. The map and measurement consumer is specified in [session-tools ADR 0004](../../../../../dsh-session-tools/docs/adr/0004-context-map-and-metering.md).

### TypeScript read-only view and metering adapter

The callback parameter uses a narrow TypeScript reading interface exposing only the reading methods and read-only properties and collections needed for sampling, omitting mutation methods such as append.

At runtime, Query passes the selected original, complete Session instance through the narrow interface, providing a TypeScript-level read-only constraint.

session-tools calls the unchanged token-meter through one internal metering adapter that directly asserts this reading view as Session. The adapter is used only for captureSession callback parameters: captureSession always supplies the original Session instance, not an arbitrary object implementing the reading interface. Do not expose the conversion as a public entry point accepting arbitrary readers. Members hidden by the reading view remain present on the actual object, so the meter continues to use the complete Session.

### Sampling and ownership

The callback must not yield, mutate the Session, create or activate an agent, or return the Session, observation, or mutable containers. Copy ordered nodes, request header/context, replacement/content generations, required immutable messages, and measurement results; per-node measurement must align with the sampled node order.

The callback returns a fully owned DTO, and Query releases the lease when the callback completes, throws, or is cancelled. Collect nodes and previews inside the callback; retain existing Query error categories without automatically retrying provider failures.

Capture describes a historical session's current logical Surface, not an arbitrary past `as_of_seq`. A cold prepared Session remains unpublished: no enter/announce, agent creation, or target persistent-log writes; preparation and meter memory caches may update. First-cold reads may still restore the complete log, and the meter may still traverse the entire Surface; bounded display windows do not imply windowed disk I/O.

### Cuts and preparation modes

Record the source observation cut, measurement `logRevision`, and replacement/content generations separately; different revision numbers alone do not establish misalignment. Cold repair may include synthetic interrupted closers; a prepared Session may also have an end-seed marker, so the logical cut is not described as the raw disk tail.

Capture uses the existing store-definition read preparation path without a public prepareMode switch. After asynchronous source resolution, pass the selected live Session or entry.session and the current observation to the consumer in the same synchronous resolve/consumeLive segment, releasing the lease in finally; do not await observeSession and then fetch the latest Session or accept an old observation for current capture. Canonical Surface/trace analysis retains its existing purpose and is not treated as an equivalent store Session; see [source resolution and preparation](../../../../packages/session-query/session-query/src/observation.ts#L152-L268).

Reuse a still-valid prepared object with the same mode and source revision; the map does not restore it again independently. The existing cache stores one entry per sid and checks mode/revision; switching mode, changing revision, or eviction can require preparation again; see [cache checks](../../../../packages/session-query/session-query/src/observation.ts#L311-L334).

Read and interpret each event by seq from session.surface.nodes, retaining zero-price nodes without messages; do not zip nodes with deriveMessages, which filters empty messages; see [message derivation](../../../../packages/core/session/src/index.ts#L835-L880). The meter synchronously reads the same Session log, independently folds original events, and applies its image/offload and attachment route logic; it requires neither Session activation nor arbitrary Session plugin interpretation results. Align nodes by index/seq and label preview/pricing basis separately without promising identical priced text; see [meter sampling](../../../../packages/llm/token-meter/src/index.ts#L146-L190) and [meter fold](../../../../packages/llm/token-meter/src/surface-fold.ts#L107-L127).

Use `projectionMode: none` for node-only maps and `all` when recorded context summaries are needed. Both retain existing projection semantics; `none` does not skip restoration validation. The I/O entry `getContextMap(ctx, exec, ...)` authorizes the source before sampling, with the same scope rules as the public model tool. The pure `buildContextMap(reader, observation, measurement, ...)` performs no I/O or authorization: it projects Session data already held by its caller and also serves the reminder projection.

## Alternatives considered

**Use only `Readonly<Session>`.** It restricts property assignment but still exposes mutation methods such as append; a narrow reading interface expresses the operations callers actually need.

**Runtime read-only wrapper or proxy.** This could omit mutation methods from the exposed object, but the existing token-meter accepts a complete Session. Retaining the original instance behind a TS interface allows direct reuse of the meter. JavaScript calls or deliberate bypasses of type checking are outside this proposal’s scope, so it adds no runtime mutation isolation for those calls.

**Change the meter to accept the reading interface.** This would remove the internal type assertion, but captureSession already guarantees that the actual object is a complete Session. Concentrating the assertion in session-tools’ internal adapter preserves the existing meter interface.

**Restore Sessions in the consumer.** This duplicates source resolution, full restoration, cancellation, and cache ownership and risks bypassing Query read rules, so it is rejected.

**Read the Surface and then call the meter.** Live state can change between the two operations, preventing a same-sample guarantee for nodes, previews, and prices, so it is rejected.

**Have Query supply maps or depend on the meter.** This moves consumer presentation and pricing into foundational querying and restricts other read-only sampling uses, so it is rejected.

**Use only existing context pressure projections.** Summaries do not provide per-node prices aligned with the current Surface and cannot support a general segment map, so this is rejected.

## Acceptance criteria

- Live/cold capture uses existing resolution and store preparation paths to acquire nodes, messages, and measurement synchronously; historical sessions activate no agent and write no persistent log; still-valid objects with the same mode and source revision are reused without promising zero restoration across mode switches.
- Verify store/canonical preparation differences, old cuts, in-memory end-seeds, synthetic closers, empty nodes, and image offload, with explicit source-cut and meter-revision meanings.
- Later append/replacement does not mutate returned DTOs; cancellation, callback failure, and dispose/HMR neither leak leases nor let old calls refill disposed caches.
- Query gains no meter dependency; the public reading interface omits mutation methods and uses read-only property and collection types. Type tests cover available reads and rejected mutation calls; a sampling test covers passing the original Session and calling the unchanged meter through the internal adapter. Formal public types, JSDoc, owning subsystem documentation, and all callers update together, with public imports verified in released packages.

## Risks

Same-sample capture observes the same Session without guaranteeing that previews are the text priced by the meter or that final provider wire text and prices match. Consumers must label preview/pricing basis. TypeScript cannot enforce callback-scoped reference lifetimes at compile time; reference lifetime relies on callers following the sampling and ownership rules.

Cold reads and measurement retain full-input costs: this entry point reduces repeated preparation and payload cloning without promising constant time.
