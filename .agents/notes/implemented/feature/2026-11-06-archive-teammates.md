# Agent Note: Archive teammates and resume on Lead messages

Status: implemented

English | [中文](2026-11-06-archive-teammates.zh.md)

## Problem

Every teammate ever created, including completed and failed ones, counted toward `maxMembers`, and nothing could remove a teammate. A long-lived Team eventually reached the limit and could not spawn new workers. Deleting teammates would also discard the conversations that the Lead may need when a finished piece of work turns out to be wrong.

## Decision

Only the Lead can call `archive_teammate(target)`. Archiving drains the teammate's resident activation, records an `archived` member snapshot in the Lead log, and returns the teammate's in-progress shared tasks to pending without an owner. The name, Session id, and conversation log stay unchanged, and the name cannot be reused. Only provisioning and active teammates count toward `maxMembers`; failed and archived teammates do not.

When the Lead sends a message to an archived teammate, the Team checks capacity first. If the Team is full, the send fails and nothing changes: the teammate stays archived, the message is not delivered, and no event is appended. Otherwise the teammate becomes active and ordinary inbox delivery cold-resumes its existing Session, which keeps its context and its persisted model selection. The result includes `unarchived: true` and a sentence telling the Lead that the teammate counts toward the limit again. Tasks released at archive time stay unowned. A teammate cannot restore an archived peer; the error tells it to ask the Lead.

`list_agents` omits archived teammates unless called with `include_archived: true`, and `wait_agent` does not wait on them. The Web panel lists them in a collapsed group whose rows still open the conversation, and shows on-duty members against the configured limit. This note replaces the slot-counting part of [Agent Teams](2026-08-05-agent-teams.md); that note's roster identity, task board, and inbox decisions still apply.

## Alternatives considered

**Add `unarchive_teammate`.** The Lead restores a teammate only to give it more work, and that work arrives as a message. Restoring on the message keeps the two steps together. A separate tool would let the Lead restore a teammate without assigning anything, which occupies a slot for nothing, and would add one more tool for the model to learn.

**Delete members or reuse names.** Deleting loses the conversation. Reusing a name makes old task owners and messages ambiguous.

**Keep counting every member ever created.** Long-lived Teams would keep hitting the limit even when most counted members have finished.

## Testing

Behavior tests cover: capacity freed by archiving; a send to an archived teammate in a full Team failing without changing state; Lead-only archiving and restoration; task release and rejection of assignments to archived teammates; context retention and Team tool access after cold resume; list filtering; and the collapsed, navigable archive group in the Web panel. Team logs written before this change remain readable.

## Consequences

If restoration succeeds and the following delivery fails, the teammate stays active, as with any other rejected inbox delivery; the Lead can resend. Archived conversations stay on disk and keep using log storage.
