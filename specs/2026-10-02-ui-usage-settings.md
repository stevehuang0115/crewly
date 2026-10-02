# UI redesign: Usage and Settings (2026-10-02)

Page work for the redesign in `specs/2026-10-02-ui-redesign.md`, at the
approved simplify level (`simple/Usage`, `simple/Settings-Runtimes`; the other
Settings tabs follow `new/Settings-*` with the simplify rules on top). Nothing
the owner could reach before is gone: it is visible, or one click away
(collapsed section, "⋯", "Show all", "Details").

## Usage (`/usage`)

One job: how many tokens are we using today, and is anything capped?

- Header: title, a Today / 7 days / 30 days switch (default Today) and Refresh.
- Headline: Today → "X of Y today" when an all-agents cap is set, with a 6px
  bar (attention colour at 80%+), else "X today". 7 / 30 days → "X in the last
  N days" with "Today so far: …" under it.
- "Estimated cost (API prices)" beside the tokens: under the headline (today /
  7 / 30 days), on each agent, team, runtime and work item, with a "?" saying
  subscriptions may cost less. Caps stay in tokens.
- Top agents and Teams side by side as thin bars, five each, then "Show all N".
  A stopped agent or team says so in the attention colour. Tapping a bar
  shows its input / cached / output split inline (also its hover text).
- "By model": each model with tokens (input / cached / output) and estimated
  cost; usage without a recorded model (or a `<runtime>-default` placeholder)
  is "Unknown model"; a model priced at the default rate shows "≈".
- "Caps & boosts", collapsed, with a one-line summary and "Boost a team" (opens
  the section and the per-team list). Inside: the all-agents and per-agent
  caps, Save caps, today's boosts with End boost and "Unlimited today for
  everyone"; one click further, per-team and per-agent caps with "+XM today",
  "Unlimited today" and End boost in "⋯".
- "Details", collapsed: input / cached / output split, by runtime, by work item
  (five, then "Show all", each linked to its run under `/tickets/runs/:id`).
- Data: `GET /api/system/usage`, `GET|PUT /api/system/usage/caps`,
  `POST|DELETE /api/system/usage/boost` through `hooks/useUsage`. Per-agent
  caps and boosts are new in the UI; the API already had them (empty = back to
  the default cap).
- Replaces the $ cost dashboard (`/monitoring/costs` already redirects here) and
  the usage panel in Settings › System.

Backend (additive): `GET /api/system/usage` takes `groupBy=model` and returns
`costUsd` on every row and on both totals, priced by the ledger's one
cache-aware formula (`eventCostUsd`; `model-pricing.ts` gained GPT-5,
`gpt-5.1-codex-mini` and Gemini 2.5 family rates so Codex and Antigravity are
not priced at the Sonnet default; an exact model id wins over a family match).
Models not priced by exact id show "≈". Model ids were already recorded on every ledger entry
(Claude transcripts, Codex rollouts, crewly-agent runs).

Not carried over from the $ dashboard (owner, 2026-10-02): auto-refresh and the
browser-only $ budget limits (token caps replace them).

## Settings

Tabs: General · Runtimes · Roles · API Keys · Credentials · Cloud & devices ·
Security · System. Skills is not a tab (it redirects to Marketplace ›
Installed).

- **Runtimes** (`RuntimesTab`, replaces `HarnessTab`): one row per runtime with
  a status word (Not installed / Out of usage / Sign-in needed / Terms not
  accepted / Update available / Ready) and one action (Install, Sign in,
  Update); "⋯" holds Sign in again, Update, Test this runtime, Install log and
  Details (version, latest, sign-in source). Non-CLI runtimes from the fallback
  list (Crewly Agent / DeepSeek) get a row too. "The orchestrator runs on X ·
  Change" opens the orc picker. Then the fallback switch and order (with
  runtimes out of usage and agents on a fallback). Advanced (collapsed): Terms
  of service, per-agent order, "The orchestrator switches too", Test a
  runtime. The fallback draft is shared (`hooks/useRuntimeFallback`), so a
  change under Advanced saves with the same Save. A runtime whose Terms wait
  for the owner (pending, declined, failed) leads with "Accept terms…" (also in
  "⋯" for any runtime with a Terms flow): it opens Advanced on that runtime's
  Terms and asks — matching the backend's "Settings → Runtimes → <runtime> →
  Accept terms…". A pending Slack re-login opens "Sign in" on the methods.
- **Cloud & devices** (`CloudDevicesTab`, replaces the CloudPortal page): the
  account row, devices and browser extensions; the cloud address and plan
  details behind "Connection details". Logic in `hooks/useCloudAccount`.
  "Add a device" (shown, open, while this machine is not connected) holds
  device-code pairing of this machine from a phone. The legacy relay invite /
  join codes are gone (`POST /api/relay/connect` was removed in 50080b07).
- **Security** (`SecurityTab`, replaces SecurityOverview): approvals and blocks
  over 7 / 30 days from `GET /api/security/approvals` (read-only,
  `services/security/approval-activity.service.ts`): decision cards (asked;
  approved / denied / expired / withdrawn / still waiting; sensitive publish /
  email / deploy / spend; runtime-terms consents), held browser actions,
  WhatsApp replies waiting for the owner, Gmail sends held now; then the recent
  items, linked to their request / run, or "Answer" when waiting. Blocked
  commands (control-plane guard, mission policy, quality gate, team budget,
  cold launch) leave no record: "Not tracked yet". A quiet agent-isolation line
  stays; a WhatsApp draft being sent counts as in progress. The score,
  isolation map and data-sovereignty report were dropped
  (owner, 2026-10-02).
- **System**: version & restart (install kind and supervisor under Details) and
  the agent heartbeat as rows, online first, five then "Show all". A one-line
  link points at the Usage page.
- **General, Roles, API Keys, Credentials**: the common settings visible, the
  rest under a collapsed Advanced, rows with at most two actions plus "⋯".
