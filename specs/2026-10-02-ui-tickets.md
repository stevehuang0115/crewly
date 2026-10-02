# UI redesign: Tickets (2026-10-02)

Page spec under `specs/2026-10-02-ui-redesign.md` (§1 Tickets, §2 Routes).
Design sources: `simple/Tickets` (board, approved density),
`new/Tickets-Requests`, `new/Tickets-Runs`, `new/RequestDetail`,
`new/RunDetail`, `new/TicketDrawer`; parity checklist from `current/Tickets`,
`current/Requests`, `current/WorkItems`, `current/RequestDetail`,
`current/WorkItemDetail` and `current/ProjectDetail-Tasks`.

Job of the page: **what is waiting for me, and what is my crew working on.**

## Hub (`/tickets`, `pages/hubs/TicketsHub.tsx`)

- `PageHeader` "Tickets" + a one-line subtitle per tab; **New ticket** in the
  header on every tab.
- `UnderlineTabs` Board · Requests · Runs in `?tab=`. The Board pill is the
  number of tickets in To review, in the attention colour (hidden at 0).

## Board (`components/Tickets/TicketBoard.tsx`)

One board for all work: the owner's **asks** (`TKT-n`, `/api/tickets`, no
project) and every project's **tickets** (`CE-n`,
`GET /api/project-tickets` without an agent session = all projects).

| Board column | Asks (`column`) | Project tickets (`status`) |
|---|---|---|
| To review | `to_review` | `review` |
| In progress | `in_progress` | `in_progress` |
| To do | `todo` | `backlog` (card says "Backlog"), `ready` |
| Blocked | `blocked` | — |
| Ideas (quiet line) | `idea` | — |
| Done (quiet line) | `done` | `done` |
| Cancelled (only with the filter) | `column=cancelled` | `cancelled` |

- Order: **To review** (attention-soft background, "Needs you"), In progress,
  To do, Blocked. Up to 5 cards each, then "Show all N" / "Show less".
  Inside a column: P0 first, then most recently updated.
- Ideas and Done fold into one line ("Ideas 0 · Done 181 — Show"); "Show"
  opens them (and Cancelled when included) as card grids, 8 cards then
  "Show all N".
- Card: title (leading `[Tag]` and pasted `[Slack Image: …]` removed for
  display; full title in the tooltip and aria label with the ref), assignee's
  name (team member name from the session, "Orc" for the orchestrator,
  "Unassigned"), priority only for P0 (danger) / P1 (attention), and one
  status word when it matters: auto-accept countdown, "Sent back ×N" (when
  there is no countdown; otherwise in the tooltip), "Accepted" /
  "Auto-accepted · not reviewed" on Done, "Backlog".
- `FilterButton`: Project (single; each project + "No project (your asks)"),
  Type (single; asks only, so project tickets step aside while it is set,
  with a one-line note), Include → Cancelled. Active filters are chips.
  Search is an icon that opens a box: asks are searched server-side (`q`),
  project tickets locally (id, title, description, labels, assignee).
- Click an ask → `TicketDetailDrawer` (unchanged: title / priority / type
  edits, origin, description, agent's answer, discussion, acceptance editor,
  Verified / Send back with reason / Dismiss). Click a project ticket →
  `ProjectTicketDialog` (all fields, allowed status moves, assign, file, run
  link, last 10 log lines).
- New ticket creates a **project ticket** (title, project, priority,
  Backlog/Ready, labels, description, acceptance, owner review). Asks have no
  create API; they come from Slack / chat.
- Polls every 15 s; Refresh button; one failing source shows an error and
  the other still renders. Unreadable ticket files are listed in a warning.

### Reuse (Projects › Tasks)

```tsx
import { TicketBoard } from '../components/Tickets/TicketBoard';
<TicketBoard projectId={project.id} teams={assignedTeams} onCountsChange={({ total }) => setTaskCount(total)} />
```

| Prop | Meaning |
|---|---|
| `projectId?` | Lock to one project: `GET /api/project-tickets/:project`, no asks, no Project / Type filter, a one-line hint about `.crewly/tickets/`, New ticket goes to that project |
| `teams?` | Teams for names and assignee choices (members of teams whose `projectIds` include the project; all teams if none) — fetched when omitted |
| `showNewTicket?` | Board's own New ticket button (default `true`; the hub passes `false`) |
| `refreshKey?` | Change to reload |
| `onCountsChange?` | `{ toReview, total }` after each load (`total` excludes cancelled — the old Tasks tab badge) |
| `pollIntervalMs?` | Default 15 000; 0 disables |
| `now?` | Clock for tests |

## Requests tab (`pages/RequestsPage.tsx`)

`CompactRow` per request: source icon (name in tooltip), title, meta =
open items owed (attention) · category · "via <agent>" · Urgent · N runs ·
goal link text · updated; status = colour + word (Active / Blocked / Waiting
/ Done). `FilterButton`: Status (single, **Active by default**, counts),
Only → Assigned to me / Urgent. Search icon. 25 rows then "Show all N".
Footer line: "N requests · total cost $X" (the old summary cards' total and
cost; per-status counts are in the filter).

## Runs tab (`pages/WorkItems.tsx`)

`CompactRow` per run: title (short id in the tooltip), meta = type · agent
"Name · Team" · ticket ref (`TKT-n` / `CE-n` from the title) · created;
status = colour + word. `FilterButton`: Status (single; Running / Queued
(incl. scheduled) / Completed / Failed / Blocked / Cancelled with counts).
Search (title, id, agent session or name, type). Running, blocked, failed
first. Refresh. 25 rows then "Show all N".

## Request detail (`/tickets/requests/:id`)

Breadcrumb Tickets / Requests; title; subtitle = created · category · intent
level · priority (when not normal); Refresh. Status line: status, "Requires
confirmation", `TKT-n` when it is a ticket, progress rail. Approve / Reject
bar when awaiting confirmation. Open items card (Skip). Original message,
source reference and tags as one quiet line. Runs as compact rows (click =
timeline inline, "Details" = run page). Statistics (tokens in/out, cost,
elapsed, runs) in a collapsed section.

## Run detail (`/tickets/runs/:id`)

Breadcrumb Tickets / Runs; title; subtitle = owner · agent · created · run
id; Refresh. Status line: status, type, retries, ticket ref, links to the
request and the goal. Description, activity timeline. Metrics (tokens, cost,
retries, duration, owner, agent, linked ids, timestamps) in a collapsed
"Details" section. Running runs refresh every 10 s.
