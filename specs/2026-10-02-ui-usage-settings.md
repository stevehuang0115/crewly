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
- Top agents and Teams side by side as thin bars, five each, then "Show all N".
  A stopped agent or team says so in the attention colour.
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

The $ dashboard's dollar figures (total cost, cost per agent / task, average
cost per task), its browser-only budget limits and the model mix have no token
equivalent in the usage API and are not carried over; flagged to the owner.

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
  change under Advanced saves with the same Save.
- **Cloud & devices** (`CloudDevicesTab`, replaces the CloudPortal page): the
  account row, devices and browser extensions; the cloud address and plan
  details behind "Connection details". Logic in `hooks/useCloudAccount`.
- **Security** (`SecurityTab`, replaces SecurityOverview): agent isolation from
  `/api/monitoring/pty-status`; tool approvals and data storage say "Not
  connected yet" (their endpoints do not exist), and there is no overall score.
- **System**: version & restart (install kind and supervisor under Details) and
  the agent heartbeat as rows, online first, five then "Show all". A one-line
  link points at the Usage page.
- **General, Roles, API Keys, Credentials**: the common settings visible, the
  rest under a collapsed Advanced, rows with at most two actions plus "⋯".
