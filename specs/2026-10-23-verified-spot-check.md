# Verified work spot check (crewly#1315)

**Status:** shipped 2026-10-23. **Code:** `backend/src/services/task-pool/verified-spot-check.service.ts`,
`recheckArtifacts` in `completion-evidence.service.ts`, `spotCheckDigest` on the ticket autopilot.

## Problem

Once a WorkItem is `verified`, nothing looks at it again. The evidence check (#873, #1313) only
confirms an artifact existed at completion time. A deliverable deleted or moved later is never noticed.

## Behaviour

- Once per local day (first check 5 min after boot, then hourly until done), the service takes the
  `verified` WorkItems completed in the last 24 h that name at least one `artifact`, samples up to 10
  of them (all when fewer; an even spread over the window otherwise, newest first, deterministic),
  and re-checks each artifact: a local path must still exist and be non-empty; URLs pass. No age
  check (the file was accepted then; only its presence is in question now). Nothing is mutated.
- The result is one line in the evening ticket digest the owner already reads:
  `Spot check: N verified item(s) from the last day re-checked, M discrepancies` — zero is stated.
  Discrepancies are listed under it (WorkItem id, title, artifact, problem; 5 listed, the rest counted).
- A discrepancy also goes to the owner at once through the owner-alert notifier (Slack), same text.
- State (`~/.crewly/verified-spot-check.json`): the last run's local day and result. A restart does
  not re-run or re-report the same day. Kill switch: `CREWLY_VERIFIED_SPOT_CHECK=0`.

## Not in this phase

Re-running `command` evidence marked replayable (read-only commands such as `test -s`). The
sampler's `recheck` hook is where that plugs in.
