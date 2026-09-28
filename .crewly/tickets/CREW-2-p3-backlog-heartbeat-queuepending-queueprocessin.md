---
id: CREW-2
title: '[P3 — backlog] heartbeat `queuePending`/`queueProcessing` rendering "?" in UI'
status: backlog
priority: P2
assignee: null
team: null
labels: [ milestone:backlog ]
ownerReview: false
createdAt: 2026-04-30T13:39:01.341Z
updatedAt: 2026-09-28T16:49:52.967Z
workItemId: null
requestId: null
source: v1-migration
migratedFrom: .crewly/tasks/backlog/open/p3_heartbeat_queue_pending_processing_render_question_marks_followup_pr386_1777517501000.md
---

## Description

### [P3 — backlog] heartbeat `queuePending`/`queueProcessing` rendering "?" in UI

#### Source
- Filed as out-of-scope follow-up in PR #386 (commit ee024829, merged 2026-04-30 05:27 UTC)
- Quoted from PR #386 commit body, Out-of-scope section:
  > heartbeat queuePending/queueProcessing rendering "?" (UI exposure, not terminal)

#### What we know
- Symptom: in the UI somewhere (likely a heartbeat / agent status display), the `queuePending` and `queueProcessing` counts render as `?` instead of a number
- Likely root cause: backend heartbeat payload doesn't include those fields, OR frontend code defaults to `?` when value is `undefined`/`null` instead of `0`
- This is purely cosmetic — does not block agent operations
- Did not block PR #386 because it's UI exposure, not core terminal logic

#### Investigation steps (when picked up)
1. Search frontend/src for `queuePending` and `queueProcessing` to find the rendering site
2. Inspect the data source: is it a heartbeat WS payload, a REST API call, or computed from another field?
3. Check what value triggers the `?` placeholder (likely `value ?? '?'` or similar)
4. Backend side: search for `queuePending`, `queueProcessing` in heartbeat-emitting services to see if/when they're populated
5. Decide: fix backend to always emit (even as 0), or fix frontend to default `?` → `0` when source is missing — generally prefer backend-source-of-truth since 0 has different semantics from "we don't know"

#### Expected fix scope
~5-15 lines across 1-2 files. Trivial.

#### Priority justification — why P3
- Cosmetic only — no functional impact
- Not a regression (existed pre-PR #386)
- Trivial fix when capacity is available
- Triage post-demo per orc directive 2026-04-30

#### Task Information
- **Priority**: P3
- **Milestone**: backlog
- **Created at**: 2026-04-30T13:50:00.000Z
- **Status**: Open
- **Created by**: crewly-product-sam-dd2b46f7

#### Assignment Information
- **Assigned to**: (unassigned — pick up when capacity available)
- **Status**: Open

#### References
- PR #386 commit ee024829 (Out-of-scope section)
- Likely files: frontend/src (heartbeat / agent status display), backend/src/services (heartbeat emitters)

## Acceptance criteria

_None yet._

## Log

- 2026-09-28T16:49:52.967Z · crewly-migration · created (backlog)
