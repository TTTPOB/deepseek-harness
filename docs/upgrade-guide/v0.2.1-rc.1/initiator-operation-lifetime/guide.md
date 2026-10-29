---
kind: upgrade-guide
description: "Inherited callbacks lose Agent initiator attribution after their originating operation settles."
---

# Initiator attribution ends with its operation

English | [中文](guide.zh.md)

## Change

`ctx.agents.withInitiator(agent, operation)` previously left the initiating Agent visible to asynchronous resources created inside the operation until those resources ended or the registry was disposed. The initiator slot now clears when the operation returns a non-Promise value, throws, or its returned Promise settles. Callbacks on surviving resources read `undefined` from `currentInitiator()`; `requireInitiator()` throws when no new initiator is established. Plugins that use ambient attribution in detached callbacks are affected. A Promise whose species prevents settlement observation retains its attribution.

## Migration

1. Return the complete foreground lifetime from the operation passed to `withInitiator()` so attribution remains available across its awaits.
2. For detached Agent-owned work, pass the required Agent or Session explicitly and retain its cancellation and disposal ownership. Start unrelated shared resources under `withoutInitiator()` when they must never inherit an Agent.
3. Confirm that foreground code still reads its Agent and that a callback captured inside the operation reads `undefined` after settlement. See the [Agent package reference](../../../../packages/core/agent/README.md) for lifecycle details.
