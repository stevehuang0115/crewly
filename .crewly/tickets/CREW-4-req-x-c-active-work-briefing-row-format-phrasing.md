---
id: CREW-4
title: REQ-X-C — Active-work briefing row format phrasing review (orc-side)
status: backlog
priority: P2
assignee: null
team: null
labels: [ milestone:backlog ]
ownerReview: false
createdAt: 2026-05-03T18:33:14.247Z
updatedAt: 2026-09-28T16:49:52.991Z
workItemId: null
requestId: null
source: v1-migration
migratedFrom: .crewly/tasks/backlog/open/req_x_c_briefing_row_format_phrasing_review_1777832001000.md
---

## Description

### REQ-X-C — Active-work briefing row format phrasing review (orc-side)

**Severity:** P3
**Filed:** 2026-05-03 (Memory Phase 1 follow-up)
**Filed by:** Max (crewly-product-max-c69ce8e6)
**Owner candidate:** TBD (likely the agent-improvement / prompt-tuning track)
**Related:** Memory Phase 1 commit `bc5d24ed` (REQ-X — orc-restart recovery filter); REQ-X-A (sister ticket)

#### Problem

REQ-X investigation (commit `bc5d24ed`) found that `active-work-briefing.service.ts` correctly filters terminal Request states. But the briefing markdown that gets injected into the orc's prompt may still cause action-implying interpretation for rows that don't need action.

Specific concerns about the current row format:

- `## Open Requests` section header — the word "open" implies the orc owes a response on every row. But `waiting_confirmation` is technically open AND awaiting user, not orc.
- Row format `- [status] title (age)` does not distinguish "you should act" from "you're already done, just waiting".
- No explicit "no action required" annotation for any row state.

#### Hypothesis

If the orc agent reads `## Open Requests` rows on restart and the row format suggests action-needed, the agent may generate a fresh user-facing reply even when the work is already done. This would produce the symptom Steve reported (re-replies to fulfilled requests on restart) without actually contradicting the briefing's filter.

#### Candidate fixes

1. **Section reframe:** Split `## Open Requests` into:
   - `## Requests Awaiting Your Action` — `open`, `ready`, `running`, `blocked`
   - `## Requests Awaiting User` — `waiting_confirmation` only
2. **Per-row action annotation:** Append `[YOU OWE A REPLY]` / `[awaiting user — no action]` / `[blocked on dependency — investigate]` to each row based on status.
3. **Explicit instruction:** Add a leading "Do not re-act on a row unless explicitly listed under 'Awaiting Your Action'" guidance in the briefing.

#### Acceptance criteria

- A/B test (or eval): orc-restart with mixed briefing (some `running`, some `waiting_confirmation`) → orc takes action only on the `running` rows, leaves `waiting_confirmation` alone.
- No regression on the other briefing sections (Active WorkItems, Pending Reviews, Outbound Delegations).

#### Out of scope

- Changing the Request state machine
- Modifying the briefing's filtering logic (REQ-X covered that)
- Adding new Request statuses

## Acceptance criteria

- [ ] A/B test (or eval): orc-restart with mixed briefing (some `running`, some `waiting_confirmation`) → orc takes action only on the `running` rows, leaves `waiting_confirmation` alone.
- [ ] No regression on the other briefing sections (Active WorkItems, Pending Reviews, Outbound Delegations).

## Log

- 2026-09-28T16:49:52.991Z · crewly-migration · created (backlog)
