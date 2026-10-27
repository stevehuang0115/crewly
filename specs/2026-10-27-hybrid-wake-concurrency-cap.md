# Hybrid wake and the "Max concurrent agents" setting

**Date:** 2026-10-27 · **Scope:** `backend/src/services/reconciler/reconciler.service.ts` `runHybridWake`

## Problem

`Settings › General › Max concurrent agents` (`general.maxConcurrentAgents`, default 10) was read in exactly one
place: the reconciler's hybrid wake. When at least that many agents were `active`, `runHybridWake` returned before
computing any wake action and logged nothing. Every other path that starts an agent — a message to a down agent
(#929), the restore queue, the stalled-agent recovery (CREW-303), the member start API — ignores the setting; under
memory pressure the start path has its own running-agent cap (`pressureMaxRunningAgents`, CREW-304) that queues a
start and evicts an idle agent for it.

Observed 2026-10-27 02:30Z: 11 agents up, setting 10. Trigger d88e3d9c enqueued a WorkItem targeted at
`ce-owen-ad0320ab` (stopped since the 02:08 restart). The dispatcher's write got 404 (by design: a WorkItem hand-over
to a down target is left to the pool, which "already wakes offline targets"). The fast wake rule
(`detectUnclaimedTasks`) would have woken Owen on the next 10 s pass, but the pass never reached it. The stall
recovery, which does not read the setting, started Owen at 02:50:52 — `queuedMinutes: 20`. Redelivers (a re-push of a
brief to an active-but-idle target, which creates no session) were dropped the same way.

## Change

- The early return is gone. Wake actions are computed and executed whatever the active count.
- When the count is at or over the setting and the action is a `start` / `rehydrate`, one `info` line is logged:
  `Waking the named target although the configured max concurrent agents is reached` with `activeAgents` and
  `maxConcurrentAgents`. Redelivers log nothing extra.
- Tests: a named suspended target is rehydrated at the cap; an idle named target is redelivered at the cap.

## Not changed (owner decision)

The setting is now enforced nowhere. Either wire it into the resource-mode running-agent cap for normal mode (which
would start evicting idle agents at the limit) or drop the field from Settings. Left as is until the owner decides.
