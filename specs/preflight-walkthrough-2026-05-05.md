# ESTestNode Pre-flight Walk-through — 2026-05-05 (KR3 acceptance gate)

> **Visibility mirror.** The canonical checklist doc lives at `.crewly/specs/2026-05-04-estestnode-deploy-preflight-checklist.md` (gitignored — local agent workspace). This file is the tracked PR-visible mirror of the walk-through appendix Sora produced for Sam's KR3 outcome check (cron-8164bb86, AC#8). Edits to the canonical happen in the agent workspace; this file is updated only when a walk-through is performed and PR-shared.

**Walked by:** Sora (Customer-Support team) — dispatched by Sam (TL, Crewly Product) for AC#8 of the KR3 outcome check (cron-8164bb86).
**Target:** ESTestNode (DigitalOcean) `137.184.113.118` — root-running Crewly Pro 1.6.4, pm2 process `crewly-pro`.
**Live profile snapshot at walk time:** host uptime 1097d, process uptime 35h, restart count 12.
**Health (pre-walk):** `/health` → `{status:"healthy", version:"1.6.4", latestVersion:"1.6.4", mode:"standard", agents:{active:1,total:1}, team_health.shadowMode:true}`.

## Pre-flight walk-through 2026-05-05 (KR3 acceptance gate)

| Item | Pre-state | Action taken | Expected post-deploy |
|---|---|---|---|
| 1 | `runtimeType=crewly-agent` already correct on `/root/.crewly/teams/orchestrator/config.json` (last `updatedAt` 2026-05-03T17:49:57Z, matches pm2 last restart). Teams dir clean — only `orchestrator/` present, no stale subdirs. No `--dangerously-skip-permissions cannot be used with root` errors anywhere in last 1000 pm2 lines. | None — `jq` patch not required; file-level state already canonical. | `runtimeType=crewly-agent` persists across the next `pm2 restart crewly-pro --update-env`; orchestrator subprocess boots cleanly without uid-0 permission rejection. |
| 2 | `/api/slack/status` → `{connected:true, socketMode:true, isConfigured:true}`. pm2 logs show **two clean Bolt-builtin Socket Mode reconnects** (2026-05-04T23:50:13 — 353ms; 2026-05-05T04:50:18 — 429ms) with `[SlackService] Socket Mode reconnected` confirmation lines. **Zero `Orchestrator offline — queuing message for replay` warnings in last 500 lines** — B0 PR #408 SlackBridge auto-recovery confirmed live. | None — auto-recovery functional; no remediation needed. | Next OAuth-scope refresh / token rotation / Slack reconnect survives without manual `POST /api/orchestrator/setup` re-init. DM reply path remains intact through the reconnect window. |
| 3 | Live pm2 logs (last 500 lines) contain **no `missing_scope` and no `reactions.add` failures** → installed Slack app DOES have `reactions:write` (added during prior OAuth-scope refresh path). **However** manifest source-of-truth `config/slack-app-manifest.json` was missing `reactions:write` from the bot scopes block — drift between installed app and checked-in manifest, regression risk on any future fresh install. | **Patched manifest source-of-truth** — added `"reactions:write"` to `oauth_config.scopes.bot` array in `config/slack-app-manifest.json` (non-destructive; affects only future installs, not the running ESTestNode app). Diff included in this PR. | Manifest matches installed app's bot scopes; future re-installs from this manifest preserve 👀 typing-indicator UX. Live ESTestNode behaviour unchanged (already has scope). |
| 4 | **Endpoint drift discovered:** `/api/orchestrator/state` returns **HTTP 404** on live profile (canonical endpoint is `/api/orchestrator/status` — 200, returns `{isActive:true, agentStatus:"active"}`). **Persistence dual-state observed:** `/api/orchestrator/status` reports `agentStatus:active` while `/api/teams/orchestrator` member-level reports `agentStatus:inactive` for both `crewly-orc` (updatedAt 2026-05-03T17:49:57Z, stale) and `crewly-orc-assistant` (updatedAt 2026-05-05T04:52:24Z, fresh — runtime is alive and writing but persisted state still says `inactive`). Consistent with Persistence Fix P0 being merged on `main` but **not yet deployed** to the 35h-uptime live profile. Teams list otherwise clean (only orchestrator team, no stale entries from item 4's failure mode). | None — destructive remediation (pm2 restart, state reset) explicitly out of scope per dispatch. **Flagged for ORC**: (a) Persistence Fix P0 ships with the next deploy — re-walk this row post-deploy to confirm dual-state resolved; (b) doc-bug `/api/orchestrator/state` → `/api/orchestrator/status` to be addressed in successor checklist per the canonical doc's own Maintenance policy (do not edit historical version). | Post `pm2 restart crewly-pro --update-env` carrying Persistence Fix P0: `/api/orchestrator/status` and `/api/teams/orchestrator` member-level both consistently report `agentStatus:active, runtimeType:crewly-agent`. Stale `crewly-orc` member `updatedAt` advances past the restart timestamp. |

## Net pre-state verdict

Items 1, 2, 4 all clean at the runtime layer — the live profile is healthy and the KR3 walkthrough can proceed. Item 3's manifest drift is a code-side hygiene fix (committed in this branch); zero impact on the live profile or Steve's pending walkthrough. Item 4's persistence dual-state is the deploy-gated outcome — verifying P0 fix lands cleanly is the next-deploy acceptance signal, not a blocker for the current walkthrough.

## Code-side change in this PR

- `config/slack-app-manifest.json` — added `reactions:write` to bot scopes (Item 3 manifest hygiene). Non-destructive; aligns checked-in manifest with installed Slack app scope set so a future fresh install from this manifest does not regress 👀 typing-indicator UX.

## Coordination

- Mia + Ava are running the live KR3 walkthrough in parallel (Proposal A from cron-8164bb86) — neither side gates the other.
- Sam (TL) routes this PR to verify-output → ORC chain on merge readiness.
