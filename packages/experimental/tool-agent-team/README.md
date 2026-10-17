---
description: "Nine tools that let the model create, message, and coordinate teammates, for compositions mounting the experimental Team plugins."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-agent-team

English | [中文](README.zh.md)

## Summary

This package lets the model create named teammates, send them messages, inspect availability, wait for progress, interrupt stuck work, and coordinate through a shared task board. Every team member receives the same nine coordination tools and guidance for coordinating in a shared workspace. When the composition enables child model selection, members also receive `list_agent_models` and `spawn_teammate` accepts an optional LLM route. It replaces legacy subagent controls with the same tool names, so compositions that need both must disable the legacy definitions. The package is published under its experimental name and provides no stability guarantee.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Add this package on top of `@deepseek-ai/dsh-experimental-agent-team` when the model should run a team through tools. When mounted inside an Agent preset, only Team members whose scope descends from that preset receive the tools and coordination policy. Other presets can keep ordinary subagent controls without name conflicts. A Host-scoped mount applies to all Team members. Each member receives its current role and name through required runtime context; `spawn_teammate` sends the initial task unchanged.

### When to choose it

Choose it when the model should create and coordinate teammates by itself rather than a human driving subagent controls. Avoid it when the legacy global subagent tools with the same names must stay available: the team tools replace them for team members, so a composition that wants both must disable the legacy definitions.

### Smallest working example

The smallest addition to an existing composition is the two-package fragment from the [agent-team README](../agent-team/README.md#smallest-working-setup): durable session storage, the team domain package, and this package. The routing settings are optional:

```yaml
- id: tool-agent-team
  name: '@deepseek-ai/dsh-experimental-tool-agent-team'
  config:
    freshProvider: spawn
    forkProvider: fork
    modelSelectionSettings: false
```

| Field | Default | Meaning |
|---|---|---|
| `freshProvider` | `spawn` | Provider that starts fresh teammates |
| `forkProvider` | `fork` | Provider that starts fork teammates |
| `modelSelectionSettings` | `false` | Sample the Host `subagent-model-selection` preference for each Team Session and, when that Session carries an exact route policy, expose the child LLM route fields and `list_agent_models` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-tool-agent-team) is the exhaustive source for every accepted field and its JSDoc.

Try it by asking the Lead model: "create a teammate named reviewer to check the diff, then send reviewer the change summary". The model calls the creation tool and then the messaging tool.

### What the model can do

The nine tools group into four capabilities:

- **Create a teammate** — `spawn_teammate` takes a name, a description, and the initial task; only the Lead can call it.
- **Send messages** — `send_message` steers a running member at its nearest step boundary, starts or resumes an inactive member.
- **See and wait** — `list_agents` returns each member’s `target` and availability; `wait_agent` waits for the next team change; `interrupt_agent` stops a teammate's current turn (Lead only).
- **Manage the task board** — `team_task_create`, `team_task_list`, `team_task_get`, and `team_task_update` add, browse, read, and update shared tasks.

When model selection is enabled for the Session, `spawn_teammate` also accepts `provider`, `model`, and `reasoning_effort`, and `list_agent_models` discovers the routes that Session may select. The roster `provider` stays the execution provider (`spawn` or `fork`), never the child LLM provider.

Creation and listing results identify members by `target`, with no member Session ID. Use that value in message and interrupt calls or the task tools’ `owner` parameter; task `ownerName` uses the same value. `inactive` means no turn is executing, whether the member is loaded or must be resumed; it does not describe task completion or outcome. `provisioning` and `failed` describe member creation. Any member can message any other member and use the task board; only the Lead creates and interrupts teammates. Task updates keep the domain's owner and revision checks, so an outdated edit is rejected instead of overwriting newer work.

### Select a teammate model

Off by default. Set `modelSelectionSettings: true` and load the Host-owned `@deepseek-ai/dsh-tool-subagent/model-selection-settings` service; the plugin fails to load without it instead of silently keeping the fixed route. Each fresh top-level Team Session samples that service's `subagent-model-selection` preference and records the exact allowed routes as `subagent/model-selection-policy`; a teammate Session inherits its Lead's recorded routes, and a restored Session keeps the routes it was composed with. Settings edits affect only later top-level Sessions, so a running Team keeps a stable authority set.

`spawn_teammate` then accepts `provider` and `model` as one pair plus optional `reasoning_effort`; omission inherits the Lead's current logged route. The executor checks the argument pair, the Session's exact-route policy, `ctx.llm.resolveCallConfig()`, and the executing provider's `agentOptions` capability before `ctx.agentTeams.spawnTeammate` reserves the name, so a rejected request leaves the roster unchanged. `list_agent_models` lists only the Session's authorized routes and their adapter-owned reasoning efforts.

The fields select the child Agent's input LLM route. They never change `freshProvider`/`forkProvider`, and `list_agents` continues to report the execution provider. For a `fork` teammate, changing provider or model can prevent provider-side reuse of the inherited conversation prefix.

### What success and failure look like

`send_message` returns `{ "sent": true }` after inbox acceptance, without exposing the message ID. Success does not confirm recipient processing or a synchronous storage flush; send failures are reported as tool errors. `wait_agent` returns `noProgress` right away when no other member is running or provisioning, telling the caller to wake a teammate first; otherwise it waits for the next change and the caller re-reads state afterward. Task edits based on an outdated revision are rejected rather than overwriting newer work.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the adapter and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The adapter is built on three commitments:

- **Scoped, not global.** Every registration lives on the member Agent's own `ctx`; installation uses the member identity available when the Agent is published.
- **Declared results, compact JSON.** Every tool declares its complete result schema and renders that value as compact JSON, so the compiler checks `execute` against what the model is promised and no result spends tokens on indentation.
- **The domain owns authority.** Tools delegate to `ctx.agentTeams`, which enforces Lead authority and revision checks; the adapter adds no weaker path.
- **The Host owns route authority.** Child model selection exists only through the Host `subagent-model-selection` setting; the adapter reuses the shared subagent policy, preflight, and discovery functions instead of adding a Team allowlist.

The [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.md) owns the model-facing and scoping decisions.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, the fixed policy text, the nine coordination tool registrations, and the optional model-selection definition |

### Policy and tools

One `team:policy` section on the member scope states the shared coordination rules; the fixed text and the nine tool registrations are declared in [`src/index.ts`](src/index.ts). The nine tool schemas are registered in scopes recognized as Team members at publication. Scoped registrations with the same names as the legacy global continuable-subagent controls shadow those globals for team members only.

With `modelSelectionSettings`, the adapter registers the shared `subagentModelSelectionPolicy` projection, freezes each Agent Session's route policy when its tools are installed, and adds `list_agent_models` plus the route fields only for a frozen policy. Policy selection, authorization, LLM preflight, and discovery are the shared subagent functions; this package owns only the tool schema, the executor checks, and the frozen-policy application point.

### Scoped registration and teardown

Installation checks both Team membership and the plugin scope’s presence in the Agent’s scope chain. `agent/created` and `tools/change` reconcile registrations, including blank-session preset switches. Each installation freezes its Agent Session’s route policy, so the visible schema and the executor’s authority cannot drift apart or change under a running Session. Leaving the composition removes the Agent-owned tools and policy. Agent disposal and plugin HMR unwind installed registrations in reverse order; registration reserves the Agent before emitting tool changes to contain synchronous re-entry. The Team domain service remains Host-owned.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the domain service to the exact schemas and the decisions behind the design.

- [agent-team package](../agent-team/README.md) — the `ctx.agentTeams` domain service behind these tools.
- [Agent Teams subsystem](../../../docs/subsystems/agent-team.md) — durable Team types and service API.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-agent-team) — every tool schema the model receives.
- [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.md) — model-facing, scoping, and isolation decisions.

-----

<a id="model-experience"></a>
## Model Experience

### Team policy and tools

#### What the model sees

One shared system policy covers Team availability, shared-cwd safety, task coordination, Steer delivery, inbox acceptance, and the Lead’s duty to wait. All nine schemas are identical for Leads and teammates; execution enforces Lead-only operations. Required runtime context states `You are the Team Lead named "lead".` or `You are teammate "<name>".` with `Your Team Lead is named "lead".`, plus roster and messaging instructions. Identity comes from current Team membership, survives optional-context suppression, and is restored when compaction removes its snapshot. An ordinary fork from a teammate receives its current Lead identity.

#### Token effect

Fixed policy and schema cost on every Team member request. Identity is part of the complete runtime-context snapshot. An unchanged retained snapshot adds no message; changed or removed context causes the loop to append a complete snapshot, including identity. Tool calls add compact JSON roster, task, wait, or receipt results. Peer content is retained by the Team domain in the target's history.

#### KV Cache effect

With the same provider/model, shared system policy, and tool schemas, a fork retains the parent request prefix and appends its task and current runtime context. Tool results and peer messages append after the reusable request prefix. Sessions recorded with identity inside the system prompt can change that prefix on their first request under this layout; actual provider cache hits remain best-effort.

### Teammate model selection

#### What the model sees

Only an enabled Session's `spawn_teammate` exposes `provider`, `model`, and `reasoning_effort`, together with `list_agent_models`; a disabled or restored fixed-route Session exposes neither, and the fork route warning appears only while selection is enabled. Discovery returns the intersection of the Session's authorized routes and the live adapter directory, so a newly registered provider or model never widens an existing Session, and the authorization list itself never enters a request.

#### Token effect

The route fields and discovery tool add their fixed schema and description to every Team request in an enabled Session; the authorization list adds no request tokens. `list_agent_models` output enters the transcript only when the model calls it.

#### KV Cache effect

A fresh teammate's route change affects only its own later requests. A fork teammate keeps the Lead's copied prefix only when the route is unchanged; changing provider or model requires re-prefilling that history, which can dominate the delegated task's cost.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what the policy and tools cannot guarantee for a team. They are current package constraints, not a comparison with other collaboration surfaces.

- **Prompt policy is coordination, not confinement** — it cannot stop Bash or external processes from writing overlapping files.
- **No Web controls** — browser roster and task-board presentation is outside this runtime package.
- **Host-authorized routes only** — child model selection requires the Host `subagent-model-selection` setting and an executing provider that advertises `agentOptions`; Team adds no separate allowlist, unrestricted mode, or fallback to the fixed route once enabled.
- **Experimental prototype with no stability promise** — the package is public, but its schemas can change freely while it incubates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
