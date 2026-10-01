# Runtime fallback when a runtime runs out of usage

Status: implemented (feat/runtime-fallback)
Date: 2026-10-01

## Problem

Every agent runs on one runtime (Claude Code, Codex, Antigravity, the
in-process Crewly Agent on DeepSeek, …). When that runtime's account runs out
of usage (Claude's 5-hour / weekly limit, Codex's usage limit, a Gemini daily
quota, an empty DeepSeek balance) every agent on it stops answering until the
limit resets — hours, sometimes days. The owner is usually away from the
machine and only notices when nothing gets done.

## What happens now

1. **Detect.** The agent's live terminal output (and, for the in-process
   Crewly Agent, the error of a failed run) is matched against
   `usage-limit-rules.ts`. A match is one of:
   - `usage_limit` — the account is out of usage. The reset time is parsed
     when the message carries one ("resets 3pm (America/Los_Angeles)",
     "try again at 4:05 PM", "try again in 2 days 3 hours", `|1767225600`).
   - `transient` — a plain 429 / overloaded / "Too Many Requests". The
     runtime retries those itself, so nothing happens — unless the same
     session keeps hitting them (4 within 10 minutes), which is then treated
     as a usage limit with a 30-minute horizon.

   Login expiry (`login-expiry-rules.ts`) is checked first and always wins:
   it goes to the existing re-login flow, never to a fallback.
   Usage-limit rules require the context a real limit message carries
   (a reset time, the `·` separator, `/upgrade`, an API 429 error), so an
   agent reading this very code does not trip them.

2. **Confirm.** For Claude Code the live probe (`claude -p … --model haiku`,
   the harness-login-probe approach) is run once: if the account answers
   normally the match was a false positive and is ignored for 10 minutes.
   Other runtimes are trusted (their errors come from the API, not text an
   agent could echo).

3. **Mark the runtime exhausted** (account-wide, per machine), with the
   parsed reset time when known.

4. **Switch the agent** that hit the limit, at its next safe point (the
   moment it is not mid-turn — a limit ends the turn anyway; at most 3
   minutes of waiting):
   - pick the first runtime in its fallback chain that is installed, has a
     working login and is not exhausted itself;
   - save its conversation: a handover file under `<CREWLY_HOME>/handover/`
     (the same mechanism a too-big conversation uses at restart) with the end
     of the old conversation and the WorkItem it was on;
   - remember the old conversation id (for the switch back) and clear it so
     the new runtime starts fresh;
   - record `runtimeOverride: { runtime, primary, reason: 'usage_limit',
     since, until? }` — the member's configured runtime is NOT changed;
   - stop the session and relaunch the same member (same session name,
     role, team, project) — `createAgentSession` resolves the override;
   - the kickoff tells the agent to read the handover and continue its
     WorkItem; the owner messages it had not answered are re-delivered
     (owner-message watchdog), and queued messages are flushed.

5. **Account-wide.** Other agents on the exhausted runtime are not woken.
   They switch when they next get work: a message for such an agent is
   queued, the switch runs, and the queue is flushed by the new session's
   registration. A stopped agent that is started while its runtime is
   exhausted starts directly on the fallback.

6. **The orchestrator** follows the same rule (setting `orcFollows`,
   default on).

7. **Switch back.** While a runtime is exhausted, a periodic check runs:
   at the parsed reset time (+2 min), and otherwise every
   `probeIntervalMinutes` (default 15). For Claude Code the probe decides;
   for runtimes without a probe the reset time decides, or — without one —
   the interval (an optimistic retry; a new limit is detected again). When
   the runtime is back, every overridden agent reverts **at its next idle
   boundary** (never mid-turn, never while a message is being delivered or
   queued): the override is cleared, the old conversation id is restored so
   the primary resumes its own conversation, and a note tells it what
   happened. Stopped agents just lose the override.

8. **Notify the owner once per event**, in English, through the machine's
   orc-bot DM (the re-login notifier):
   - "Claude Code hit its usage limit on iriss-air (resets ~3:00 PM PDT).
     12 agents switched to DeepSeek until then." — sent 45 s after the first
     switch so the count is meaningful; agents that will switch later are
     mentioned ("others switch when they next get work").
   - When no fallback is available: "… No fallback runtime is available, so
     its agents wait until it resets. Set one in Settings → Runtimes."
   - Once on switch-back: "Claude Code is available again on iriss-air.
     5 agents are switching back from DeepSeek as they finish their turn."
   Notice flags are persisted, so a restart never re-sends one.

## Settings (Settings → Runtimes → Fallback)

Stored in `<CREWLY_HOME>/runtime-fallback.json` (`settings` section).

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `chain` | `['claude-code', 'crewly-agent', 'antigravity-cli']` | Global fallback order |
| `memberChains` | `{}` | Per-member override, keyed by member id |
| `orcFollows` | `true` | The orchestrator switches too |
| `crewlyAgentModel` | `deepseek/deepseek-chat` | Model a Crewly Agent fallback runs |
| `probeIntervalMinutes` | `15` | Switch-back probe cadence |

The chain lists every runtime in order; an agent uses the entries that are
not its current runtime. Only runtimes that are installed and have a working
login are selectable in the UI; the others are shown disabled with the
reason ("Not installed", "Not signed in", "No DeepSeek API key", "Retired").
Availability is checked again at switch time.

## API

- `GET /api/system/runtime-fallback` — settings, every runtime with
  `selectable` / `reason`, exhausted runtimes (since, until, rule), and the
  active overrides (session, member name, runtime, primary, since, until,
  revertPending).
- `PUT /api/system/runtime-fallback/settings` — partial update; unknown
  runtime ids are rejected (400).
- `POST /api/system/runtime-smoke-test { runtime }` — starts a smoke test
  and returns `{ jobId }` (`?wait=1` waits for the result, ≤ 5 min).
- `GET /api/system/runtime-smoke-test/:jobId` — job state and result.
- Team member objects in `GET /api/teams` carry `runtimeOverride` while one
  is active; the UI shows a badge "on DeepSeek (Claude limit)".

## Runtime smoke test

For one runtime, through the backend's own REST API (the same calls the
owner's dashboard makes):

1. `create_team` — temp team `zz-runtime-smoke-<runtime>` with one member
   (`smoke`, role `developer`, that runtime). A leftover team of that name
   is deleted first.
2. `start_member` — start it.
3. `agent_ready` — wait until the member is registered (`active`). While
   waiting, the screen is read: if Antigravity shows its first-run Terms
   screen the test fails with "Antigravity needs its terms accepted once"
   and the captured screen text. Crewly never accepts terms for the owner.
4. `send_task` — deliver: run `echo ok > <tmp file>` with bash, then reply
   with a fixed token (`SMOKE-<nonce>`) through the reply/report skill.
5. `bash` — the file exists and contains `ok`.
6. `reply` — the token shows up in the agent's output / reply.
7. `cleanup` — stop and delete the team (always, also on failure).

The whole test is bounded by 5 minutes. The result names the failing step
and carries the last screen text. Smoke-test sessions never get a fallback
override (they must test the runtime itself).

## Antigravity login state

`/api/harness` reports Antigravity `logged_in` via `env:GEMINI_API_KEY` only
when the variable holds a real value: empty, whitespace-only, quote-only
(`""`, `''`) and placeholder values (`undefined`, `null`, `changeme`,
`your-…-key`) count as not set. Note: the backend loads `.env` from its
working directory (dotenv), so a key there counts even when the owner's
shell has none.

## Non-goals

- No change to a member's configured runtime.
- No automatic acceptance of any runtime's terms.
- No fallback for login expiry (that is the re-login flow).
