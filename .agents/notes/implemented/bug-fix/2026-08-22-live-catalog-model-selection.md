# Agent Note: builtin model selection retains live descriptors

Status: implemented

English | [中文](2026-08-22-live-catalog-model-selection.zh.md)

## Problem

Builtin-provider discovery returns the current catalog, including remote-only model ids and corrected wire metadata. The settings model picker persists selected candidates as a non-empty `models` list containing editable profile fields, but route resolution treated that list as an instruction to abandon the current catalog and inherit only from the installed static catalog. A remote-only selection then lacked its per-model protocol on mixed-protocol providers, while an installed selection could silently recover an obsolete protocol and endpoint.

## Decision

For an installed builtin provider, descriptor selection and model selection are independent. The current catalog view remains the descriptor source whether `models` is absent, empty, or non-empty. An absent or empty list serves every current descriptor; a non-empty list selects descriptors by id, and every configured field beside `id` overrides the selected descriptor through the existing capacity, reasoning, modality, and compatibility resolution.

Every configured builtin route remains active for periodic catalog refresh because selected models still inherit current descriptors. When startup has no restored or published remote view, the installed catalog remains the offline baseline. Hand-declared routes have no live descriptor source and retain their route-level `api`, `baseURL`, explicit `models`, and configured fallbacks.

`modelOverrides` remains the whole-catalog customization form. It cannot coexist with a non-empty `models` list because selected entries already carry the same override fields, and merging both would create two configuration sources for one model.

## Alternatives considered

**Persist complete descriptors through the settings UI.** This would preserve deployment-owned snapshots, but it would expand the generic discovery wire format, duplicate provider metadata into `settings.yaml`, and require every future pi-ai descriptor field to survive a browser round trip.

**Add an `enabledModels` or `liveCatalog` setting.** Separate fields could preserve the old static-list meaning, but they would make ordinary model selection choose among overlapping catalog controls. The existing picker already writes `models`, and treating that list as selection plus overrides matches its visible behavior.

**Update the installed pi-ai catalog for each remote addition.** This repairs known ids temporarily but restores the release-cadence coupling that the durable live catalog exists to remove.

## Consequences

A builtin route can select remote-only models and retain each model's current protocol, endpoint, compatibility metadata, and modalities. Explicit per-model fields still take precedence and an explicit `maxTokens` remains a deployment-selected request default. A non-empty builtin `models` list no longer freezes catalog metadata; deployments that require fully owned descriptors use hand-declared routes.

The [live-catalog architecture decision](../architecture/2026-08-22-pi-ai-live-model-catalogs.md) owns refresh, persistence, and immutable request snapshots; this note narrows how configured model selection consumes that catalog.
