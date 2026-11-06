---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-06-archive-teammates

English | [中文](2026-11-06-archive-teammates.zh.md)

## Summary

Adds archived to the persisted Team member lifecycle while preserving immutable member identities.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-archive-teammates
baseline: false
changes:
  - root: "event:team/member"
    previous: "2026-09-11-initial"
    after: "d4ad0a54d4e25bee3022571b82cc697f63c1ce55d6c5e02de897354e902c7023"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

New readers continue to accept existing provisioning, active, and failed member events. Existing readers reject archived through their strict member-phase decoder and fail the Team projection instead of interpreting the member as active. The team/member discriminator and event version remain unchanged; projection cache version 5 rebuilds older checkpoints from the log. Session header version remains unchanged.

<a id="verification"></a>
## Verification

Scoped Agent Team service, projection, persistence, tool, model-selection, and client tests pass (168 tests). Mutation checks reject broken capacity, restoration, authority, task release, listing, schemas, projection metadata, collapsed grouping, navigation, and on-duty counting.

<a id="dev-note"></a>
## Dev Note

None.
