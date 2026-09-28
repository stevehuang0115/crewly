---
id: CREW-3
title: REQ-X-A — Orc generates duplicate replies for `waiting_confirmation` rows on restart
status: backlog
priority: P2
assignee: null
team: null
labels: [ milestone:backlog ]
ownerReview: false
createdAt: 2026-05-03T18:32:55.740Z
updatedAt: 2026-09-28T16:49:52.979Z
workItemId: null
requestId: null
source: v1-migration
migratedFrom: .crewly/tasks/backlog/open/req_x_a_orc_handling_of_waiting_confirmation_rows_1777832000000.md
---

## Description

### REQ-X-A — Orc generates duplicate replies for `waiting_confirmation` rows on restart

**Severity:** P2
**Filed:** 2026-05-03 (Memory Phase 1 follow-up)
**Filed by:** Max (crewly-product-max-c69ce8e6)
**Owner candidate:** TBD (TL/PM to assign)
**Related:** Memory Phase 1 commit `bc5d24ed` (REQ-X — orc-restart recovery filter); Steve add-on 2026-05-03 17:35

#### Problem

Steve's reported bug: "orc restart should ONLY recover requests that are NOT yet fulfilled — orc currently re-replies to fulfilled requests on restart."

REQ-X investigation (commit `bc5d24ed`) proved that `active-work-briefing.service.ts` already correctly excludes terminal Request statuses (`done`, `cancelled`) from the orc-restart briefing. Cross-checked SessionMemoryService, chat-v2 services, slack-orchestrator-bridge, and v3-data dangling cleanup — none re-inject fulfilled-Request context. So the briefing is NOT the surface that surfaces fulfilled requests.

**Hypothesis (Candidate A from REQ-X investigation):** The briefing IS surfacing `waiting_confirmation` rows (intentional — work done but orc owes a confirm/reject handoff). When the orc reads these rows on restart, the prompt phrasing of `## Open Requests` may cause the orc to interpret them as "user is waiting on me to act now → generate a reply", producing a duplicate ack to the user.

#### Repro (suspected, unverified)

1. User asks orc to do a thing that creates a Request requiring confirmation
2. Orc completes the work, transitions Request to `waiting_confirmation`, sends user the confirm/reject prompt
3. User does NOT respond (the request stays in `waiting_confirmation`)
4. Orc process restarts
5. **Observed:** orc re-prompts the user with the same confirm/reject ask, OR generates a duplicate ack
6. **Expected:** orc recognises the request is awaiting user action, takes no action until user responds

#### Candidate fixes

1. **Prompt-side (cheapest):** In `active-work-briefing.service.ts` `formatBriefingAsMarkdown`, annotate `waiting_confirmation` rows with `[awaiting user — DO NOT re-prompt]` so the prompt makes it explicit.
2. **State-machine side:** Track per-Request whether the orc has already sent the confirm prompt; only show the row in briefing if the prompt has not been sent.
3. **Section reframing:** Move `waiting_confirmation` rows out of `## Open Requests` into a new `## Awaiting User` section with explicit "no action required from you" guidance.

#### Acceptance criteria

- Orc restart with one `waiting_confirmation` Request → orc takes no user-facing action.
- The Request continues to show up in active-work briefing (over-recovery preserved).
- Test added: integration test seeds a `waiting_confirmation` Request, simulates orc-restart, asserts no message is sent to the user.

#### Out of scope (do NOT pull in)

- Rewriting the Request state machine
- Removing `waiting_confirmation` from `ACTIVE_REQUEST_STATUSES`

## Acceptance criteria

- [ ] Orc restart with one `waiting_confirmation` Request → orc takes no user-facing action.
- [ ] The Request continues to show up in active-work briefing (over-recovery preserved).
- [ ] Test added: integration test seeds a `waiting_confirmation` Request, simulates orc-restart, asserts no message is sent to the user.

## Log

- 2026-09-28T16:49:52.979Z · crewly-migration · created (backlog)
