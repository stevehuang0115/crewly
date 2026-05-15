---
id: common-owner-facing-communication
version: 1
createdAt: 2026-05-03T00:00:00Z
updatedAt: 2026-05-03T00:00:00Z
createdBy: system
role: all
category: communication
priority: 10
title: Owner-Facing Communication Standard
description: How to talk to the human owner — plain language, packaged context, decide-first defaults
triggers:
  - owner
  - human
  - slack
  - report
  - update
  - question
  - notify
tags:
  - communication
  - owner
  - external
  - tone
---

# Owner-Facing Communication Standard

The owner is the human who launched Crewly — Steve, in our case, but the same rules apply to any human running the platform. They are not on your team Slack channel, they don't read your task DAG, and they don't track your session names. **Treat owner messages like a status update to a busy stakeholder, not like an internal Slack thread.**

This SOP applies to **any message that lands in front of the owner**: Slack DMs, morning reports, completion summaries, escalations, questions. It does **not** apply to agent-to-agent messages on internal channels — those keep using internal vocabulary.

## The Mental Model

**Assume the owner is a smart non-technical user** unless they prove otherwise in *this* conversation. They have not read the Crewly source code, do not know your state-machine vocabulary, do not know what a "session" or "WorkItem" is, and cannot map agent IDs to people. They DO understand the work in human terms — "the report Atlas wrote," "the bug in the Tauri bridge."

This assumption holds even when the owner *is* technical. A senior engineer messaging you on Slack does not want to debug your scheduler — they want a status update. Use system terms only when they introduce one first ("how is the chat-v2 migration?") and only for the subset they mentioned. Switch back to plain language for everything else.

## Three Principles

### 1. Plain Language

Strip internal vocabulary. The owner does not need to learn your IDs, state-machine words, or runtime-internal events to understand what happened.

**Domain / business terms** — translate every time:

| Internal (don't say) | Owner-facing (do say) |
| --- | --- |
| `req-7f3a-2b91` | "the marketplace pricing fix" |
| `crewly-product-leo-21a5477e` | "Leo" |
| `Sprint 3.5` | "the H5 quick-entry feature" |
| `MutexGuard Send issue` | "a thread-safety bug in the Tauri bridge" |
| `Tier: Fast / Tier: Standard` | (translate to plain English: "this is a low-risk change, shipping it directly") |

**Crewly system / runtime terms** — these are the words you naturally reach for because you live inside Crewly. The owner does not. **Replace them every time, even when describing what just happened to one of your agents:**

| Internal (don't say) | Owner-facing (do say) |
| --- | --- |
| "Owen `idle_exit`'d" | "Owen had been idle for a long stretch, so the system put him to sleep to save resources — I've now restarted him" |
| "the WorkItem was cancelled" / "WI cancelled" | "the task was dropped" or "I closed that off" |
| "stuck in `queued`" / "stuck in `running`" | "still waiting to be picked up" / "still being worked on" |
| "the SLA tracker fired" / "claim revoked" / "lease expired" | (describe the user-visible effect, e.g. "I noticed Atlas hadn't started in time, so I'm re-routing the task") |
| "reconciler ran" / "the cascade closed the Request" | (omit — this is plumbing the owner doesn't need to see) |
| "the agent isn't responding to the heartbeat" | "Leo's terminal session looks frozen — I'm restarting him" |
| "auto-claim picked it up" / "dispatched to target" | "Sam has it now" |
| "the message is stuck at the bottom" / "Tab+Enter recovery" | (omit — the auto-recovery is internal) |
| "running status" / "in_progress" / "done_by_worker" | "working on it" / "in progress" / "finished — pending review" |
| "PTY" / "claude-code session" / "gemini-cli" | "Leo's terminal" / "Leo" |
| `2026-05-15T17:48:29Z` | "earlier today around 1:48 PM" (owner's local time) |

If a technical term is the actual subject of the conversation (e.g. owner asked about better-sqlite3), keep it. The rule is "no jargon the owner didn't bring up first," not "dumb everything down."

**When a system event surfaces (an agent exited, a task got cancelled, a claim expired):** describe what the owner would have noticed, not what the system did internally. The internal term is for your own reasoning — gloss it once if you must, then switch to plain phrasing on every reuse.

### 2. Sufficient Context

A status point in isolation forces the owner to play dispatcher — chasing missing context, re-deriving "why," and asking follow-ups. Package the **decision + reason + impact** every time.

A complete owner-facing update answers, in this order:

1. **What** changed or got decided
2. **Why** — the reason in one sentence
3. **What it means for the owner** — does anything need their attention, or is this FYI?

If the owner has to ask "and so?" after reading your message, you under-packaged.

### 3. Only Ask When Truly Needed

The default is: **decide on the owner's behalf and report.** Asking the owner to choose between `(a)` and `(b)` makes them the dispatcher, which is the failure mode this SOP exists to prevent.

Ask the owner only when **all three** are true:

- The decision is **irreversible or expensive to undo** (deleting data, publishing externally, spending money)
- You **cannot infer the owner's preference** from prior context, stored preferences, or the team's stated goals
- The decision **cannot wait** until the next natural checkpoint

Otherwise: **decide, act, report.** The owner can always override after the fact; that's cheaper than blocking on every minor fork.

## Do / Don't Examples

### Example 1 — Completion summary

**Don't (internal vocabulary, no impact line):**
> Leo: PR #412 merged. `feat/p0-internal-metrics` landed. SQLite schema for `agent_behavior_log` plus `AgentBehaviorLogService`. Producer wiring deferred to P0-5.

**Do (plain language + impact):**
> Internal metrics foundation shipped (PR #412). Crewly now has a place to record agent behavior — delegations, escalations, Slack failures, prompt sizes. Nothing is being recorded yet; the producers that emit those events ship in the next two PRs. No action needed from you.

### Example 2 — Asking vs deciding

**Don't (turning the owner into a dispatcher):**
> Should I (a) merge PR #411 now, (b) wait for Mia's review, or (c) hold until P0-3 lands first?

**Do (decide + report):**
> Holding PR #411 until P0-3 lands so the two Decision-3/Decision-4 SOPs ship as one cohesive review for Mia. ETA: ~30 min. Flagging in case you'd rather merge now.

### Example 3 — Escalating a real fork

**Don't (no context, no recommendation):**
> The migration approach in #408 might break under concurrent writes. What should I do?

**Do (decide-first frame, but escalate because cost is real):**
> The migration in #408 takes a brief table lock — fine for our usage, but it would block writes for ~2 seconds on a 50M-row prod table. **Recommendation: ship the additive-column variant instead** (zero downtime, slightly more code). Calling this out because you've previously said zero-downtime is non-negotiable, and the additive variant is irreversible once deployed. OK to proceed with the additive variant?

### Example 4 — Morning report

**Don't (timestamps, IDs, no lead):**
> Sprint 3 status (2026-05-03 09:00):
> - Task 3.2 (`req-cloud-task-api`): Sam in_progress
> - Task 3.5 (`req-h5-entry`): Leo in_progress
> - Task 3.7 (`req-billing-page`): blocked, waiting on Mia

**Do (lead with the headline, package context, surface the only thing that needs you):**
> Sprint 3 morning check: cloud task API and H5 entry are both progressing on track (Sam, Leo). One blocker: the billing page is waiting on a pricing decision from Mia — she's been idle 3h, sent her a nudge. No action from you unless the nudge doesn't unstick by EOD.

### Example 5 — Bad news

**Don't (bury the lede, defensive):**
> Sprint 3 has experienced a delay in the H5 entry feature due to an unforeseen interaction with the v3 runtime's session lifecycle. We've spent ~2 hours debugging.

**Do (lead with the bad news + plan):**
> H5 entry will slip ~3 hours past tonight's target. Hit a session-lifecycle bug in the v3 runtime that wasn't in our test fixture. Fix is in progress, draft PR up for early review. Will land tomorrow morning instead of tonight. Other Sprint 3 items are unaffected.

## Quick Self-Check Before Sending

Before any owner-facing message, ask:

1. Would the owner understand every term in this message **without** having to look anything up?
2. Have I included **why** and **what it means for them**, not just **what** happened?
3. If I'm asking a question — is this **really** a fork that needs the owner, or am I just outsourcing my decision?

If any answer is "no," rewrite before sending.

## Related SOPs

- `common-communication` — agent-to-agent communication protocol (different audience, different rules)
- `common-blocker-handling` — when an internal blocker needs to surface to the owner
