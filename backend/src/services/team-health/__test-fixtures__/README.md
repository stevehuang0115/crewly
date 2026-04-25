# Team-Health-Watchdog — Test Fixtures

These JSON fixtures freeze real wire-state at the moment seven 2026-04-25 incidents fired. Each fixture has a co-located test that loads the JSON, builds a `TeamHealthSnapshot`, runs `detectTeamHealth` (or the watchdog service), and asserts the verdict.

The fixtures are the **regression contract** per §E.1 of the SEALED design and the post-SEALED §B.6 amendment: a watchdog change that breaks any of these seven cases breaks CI.

## Fixture format

| Key | Type | Description |
|---|---|---|
| `_description` | string | Human-readable scenario summary (ignored at load time). |
| `now` | ISO 8601 | Wall-clock time the snapshot represents. |
| `bootedAt` | ISO 8601 | Backend boot time. Drives the boot-grace silence rule (FP-1). |
| `teams` | TeamSummary[] | Teams to evaluate. |
| `agentHealth` | (AgentHealth & {workingStatus?})[] | Per-session health snapshot. |
| `workItems` | WorkItem[] | Active (non-terminal) WorkItems across the system. |
| `requests` | Request[] | Active Requests (used by orphan-Request rule). |
| `triggers` | Trigger[] | Triggers (used by team_silent axis). |
| `priorDoneCounts` | `{workItemId, count}[]` (optional) | Counts of prior `done` tasks with overlapping AC. |
| `artifactProbes` | `{workItemId, probes: ArtifactProbeResult[]}[]` (optional) | Pre-resolved artifact probes for stale-trigger detection. |

The fixture loader (`loadFixture` in `team-health-detector.fixtures.test.ts`) translates the array shapes into the Map<string, …> shapes that the detector consumes.

## The seven cases (#1–#4 from SEALED §E; #5–#7 from post-SEALED amendment)

1. **case-1-marketing-cascade** — Marketing parent + Marketing-Content + Marketing-Ops all idle 3h20m with pending WorkItems and no triggers. Expected: `🚨 cascade` for the two leaf teams.
2. **case-2-sam-stale-disable-relay** — `wi-stale-relay` has 4 prior done with overlapping AC + source already in target state. Expected: `🟪 stale` short-circuit.
3. **case-3-arch-crewly-web-1.3.33** — `wi-rebuild-1.3.33` references a package.json version no branch contains. Expected: `🟪 stale`.
4. **case-4-orphan-request** — Request open for 30 min with zero matching WorkItems. Expected: `🟡 stalling` for the team; `🚨 cascade` system-wide if ≥3 orphans.
5. **case-5-mia-lost-dispatch** — PM dispatch at 18:55, Mia (PM) restarted at 19:05, status stuck at proposed. Expected: `🟡 stalling` (lost-dispatch detector).
6. **case-6-ava-lost-dispatch** — UX dispatch at 18:45, Ava (UX) restarted at 19:00, status stuck at accepted. Expected: `🟡 stalling` (lost-dispatch detector).
7. **case-7-sam-restart-slack-chat** — TL dispatch at 19:00, Sam (TL) restarted at 19:15, status stuck at proposed. Expected: `🟡 stalling` (lost-dispatch detector).

### Documented but not yet a binding fixture

**Case #8 — Shared-checkout multi-agent destructive-op without coordination (the rm-rf incident, 2026-04-25T15:35Z).** Two agents (Sam TL, Max dev) sharing the single working tree at `/Users/yellowsunhy/Desktop/projects/crewly-projects/crewly`; Sam ran `rm -rf backend/src/services/team-health/` to clean what he believed were his own untracked drafts. The directory was actually Max's in-progress, untracked work for THW v0; ~25 files were destroyed. Recovery only possible because Max held the file content in conversation context.

This signal is **filesystem-level**, not WorkItem-level — THW v0 has no axis for it (THW reads only WorkItem/Trigger/Request state). Documenting the case here so:
- The team coordination norm doc (`crewly-product-team-coordination-norm-2026-04-25.md`) captures the pre-destructive-op checklist.
- A future v0.5 multi-agent-conflict detector can use this as a fixture target.
- Operators reading these fixtures get the full failure-class taxonomy.

The bug class is "two simultaneous editors of the same untracked path", caught at v0.5+ either by a `pre-rm-rf` git hook + `.crewly/path-claims.json` ownership map, or by a worktree-isolation migration. Out of scope for THW v0.

## Negative cases

`team-health-detector.test.ts` covers N1–N6 from §E.7 (no false positives) inline — those don't need standalone fixture files because they're permutations of small synthetic snapshots.
