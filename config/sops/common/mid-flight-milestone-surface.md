---
id: common-mid-flight-milestone-surface
version: 1
createdAt: 2026-05-16T00:00:00Z
updatedAt: 2026-05-16T00:00:00Z
createdBy: system
updatedBy: system
role: common
category: communication
priority: 8
title: Mid-Flight Milestone Surface
description: When you ship a milestone inside an active goal, surface it upstream immediately — do not wait for the next outcome-check tick.
triggers:
  - milestone
  - report-status
  - PR merged
  - spec finalized
  - build pass
  - deploy succeeded
tags:
  - communication
  - proactive
  - milestone
  - silent-shipping
---

# Mid-Flight Milestone Surface

When you ship a milestone INSIDE an active goal — a PR merged, a spec
finalized, a build pass on a non-trivial change, a dependency
unblocked, a deploy succeeded — do **NOT** wait for the next
outcome-check tick or for someone to ask. Surface it now.

This SOP is the **symmetric agent-side rule** to the orchestrator's
periodic check-in cadence (PR #418). The orc surfaces upward to the
owner on a 15-min cadence; agents surface upward to the orc the
moment they have something concrete to report. Issue #427 / EPIC
#426 documented that worker / TL prompts had **zero** "milestone"
keyword across 21 role prompts — the system was structurally silent
on this path.

## The rule

Immediately call the `report-status` skill with:

- `status: "milestone"` — the explicit verb introduced by issue #435 /
  PR adding `[MILESTONE]` envelope to `report-status`.
- `summary` — plain-language **WHAT shipped** + **one-line
  WHAT-IT-MEANS-FOR-OWNER**. Optimize for someone scanning Slack on
  their phone.
- `artifacts` — the canonical link (PR URL, spec path, deploy id).
  If there's no artifact, the milestone probably isn't one.

The orchestrator's Smart Notification Protocol has a dedicated
`[MILESTONE]` row in the priority table (issue #436) that promotes
the surface to 🟡 Important — always notify, never downgraded to
⚪ Info even if the outer outcome isn't fully met yet.

## What counts as a milestone

- PR merged
- Spec finalized + handed off
- Build pass on a non-trivial change (e.g. cross-module refactor
  that compiles for the first time)
- Dependency unblocked (the thing you were waiting on now exists)
- Deploy succeeded
- Verification gate passed (e.g. an integration test you wrote went
  green for the first time)

## What does NOT count

- "task done" without context (no `summary` body) — every dispatch
  produces a "task done" event, those flow through the existing
  task-pool path and don't need separate `[MILESTONE]` surfacing.
- Internal progress checkpoints (40% of the way through, 80% of the
  way through). Those are status updates, not milestones.
- The same milestone re-surfaced. Once is enough.

## Examples

✅ **Good**:

- "PR #420 merged — agent state file is now corruption-resistant +
  auto-snapshots every 30s. Persistence-loss risk on crash drops from
  'all session memory' to 'last 30s only'. No action needed."

- "Onboarding cold-start state machine merged (PR #409). End-to-end
  5-min activation path is now in code. Real-user dry-run still
  pending."

❌ **Bad — do not emit**:

- "task done"
- "Progress update: 80%"
- "Working on it"
- "Will continue tomorrow" (without specifying what shipped)

## How orc handles it

When the `[MILESTONE]` envelope arrives, the orchestrator:

1. Recognizes the explicit `[MILESTONE]` marker from the priority
   table (issue #436) — classified as 🟡 Important.
2. Surfaces to the owner via the trust-adaptive channel (chat-v2
   `[NOTIFY]` or Slack reply-thread, depending on origin).
3. Never downgrades to ⚪ Info even if the outer outcome (OKR /
   request) isn't yet fully complete.

The auditor's "Silent Shipping Detection" monitor (issue #437)
cross-references `git log` against `report-status` / `[MILESTONE]`
events and flags any merged PR whose author did not emit a milestone
surface within 30 minutes of merge.

## Where this SOP applies

All roles that ship artifacts: developer, frontend-developer,
fullstack-dev, qa, qa-engineer, product-manager, tpm, designer,
ux-designer, architect, team-leader, generalist. The orc and the
auditor consume the surface; they don't emit it.

## Refs

- EPIC #426 — Proactive-followup gap audit
- RC1 #427 — Worker/TL prompts contain zero milestone keyword
- QW-1 #434 — This SOP
- QW-2 #435 — `[MILESTONE]` envelope in `report-status` skill
- QW-3 #436 — `[MILESTONE]` row in orc priority table
- QW-4 #437 — Auditor Silent Shipping Detection monitor
