# Agent follow-through (2026-10-10)

Incident: Pia (Flopost PM) was asked for three videos. She told the owner "I'm breaking down the shot list now",
ended her turn twice ("I haven't started yet — next step is …"), and was idle-stopped. 2h45m later the owner asked
where the videos were. Nothing tracked the request.

## Root causes
1. A statement of intent ("doing X now") had no consequence: the sentinel's promise detector only timed promises that
   carry "~N min", and ignores posts in threads it does not watch (a decision card's thread).
2. The ticket (`assignee`) never became a WorkItem, and the briefing listed Requests by `ownerAgent` only, so the
   ticket was invisible to the agent at launch.
3. Idle stop protected only queued/proposed/accepted WorkItems and a 30-minute owner window. Pia had neither: the
   window ended 30 min after the owner's message and she was stopped.

## Behaviour
- **Guard** (`services/agent/follow-through.service.ts`): remembers the last stated intent per agent (text heuristics,
  `stated-intent.ts`). At turn end (`settleAfterTurn`, after background work settles): no `PreToolUse` hook since the
  statement (after a restart: fewer than two), nothing handed off (WorkItem for itself or delegated since), not
  waiting on an owner card, not owner-stopped/paused, statement < 30 min old → one nudge into the same conversation.
  Once per statement; once per agent per 10 minutes. Runtimes without hooks fall back to PTY output span; unknown = no nag.
- **Ticket work** (`services/v3/ticket-work-guard.ts`): at turn end, an open, review-needing, non-question ticket
  assigned to the agent, with no WorkItem, and not already answered by a real reply (or with several deliverables, or
  an unfulfilled stated intent) gets a WorkItem for the agent, linked to the ticket. Several deliverables (numbered,
  "three videos", "one … another …") become the ticket's checklist; `ticket-check --index n --result pass` marks one
  delivered; the briefing shows "1 of 3 delivered". An agent post that only states an intent is no longer an "answer"
  that submits the ticket.
- **Idle stop** (`services/agent/idle-work-guard.ts`): an agent with a queued/accepted/running WorkItem, an assigned
  open ticket, an owner promise (6h) / unanswered owner message (2h), or an open stated intent is kept. In resource
  *pressure* mode and in the emergency stop, it is stopped anyway but its running WorkItems are first put back in the
  queue (`releaseBack`) and an open intent is parked as a WorkItem, so the next start redelivers them.

Off switch: `CREWLY_FOLLOW_THROUGH=off` (guard only).
