# Agent Note: Archive teammates and resume on Lead messages

Status: implemented

English | [中文](2026-11-06-archive-teammates.zh.md)

## Problem

Long-lived Teams exhaust their member limit when completed or failed teammates retain permanent roster slots. Deleting a teammate would lose its stable identity and conversation, while keeping it active obscures which members can still make progress.

## Decision

Only the Lead can call `archive_teammate(target)`. Archiving first drains the teammate's resident activation, then records an `archived` member snapshot in the Lead log and releases its in-progress shared tasks to pending and unowned. Names, Session ids, and conversation logs remain unchanged and cannot be reused. Only provisioning and active teammates count toward `maxMembers`; failed and archived teammates do not.

A Lead message to an archived teammate first checks available capacity. A full Team rejects the send without restoring the teammate, delivering the message, or appending events. Otherwise the member becomes active before ordinary inbox delivery cold-resumes its existing Session, preserving context and the persisted model selection. The response reports automatic restoration and its capacity cost. Released tasks remain unowned. A teammate cannot restore an archived peer and receives an instruction to ask the Lead.

Default member lists and progress checks exclude archived members. The Web panel keeps them in a collapsed group with navigable conversation rows and shows the configured on-duty capacity. This partially supersedes the slot-lifetime decision in [Agent Teams](2026-08-05-agent-teams.md); its roster identity, task board, and inbox ownership decisions remain active.

## Alternatives considered

**Add `unarchive_teammate`.** Restoration belongs to a Lead message that actually dispatches work. A separate tool permits restored-but-unassigned members to occupy capacity and adds another tool for the model to learn.

**Delete members or reuse names.** This loses conversation continuity and makes old task ownership or messages ambiguous.

**Count all historical members.** This prevents long-lived Teams from replacing completed or failed workers despite retaining ample execution capacity.

## Testing

Behavior tests cover released capacity, rejection without mutation when full, Lead-only restoration and archiving, task release and assignment denial, retained context and Team-tool access after cold resume, filtered lists, and the collapsed but navigable Web archive group. Each new or rewritten test is checked against a broken implementation. Old Team logs remain readable.

## Consequences

A successful restoration followed by a delivery failure leaves an active member, consistent with ordinary inbox rejection semantics; Team does not add another retry owner. Archived conversations remain retained and consume log storage. Real-model context recall and Web rendering still require isolated Host acceptance beyond keyless local tests.
