---
name: Trace Read
description: Read how a run went, sized for your context — where the time went (agents working, waiting on the owner, waiting on an agent, idle), owner touches, rework, stalls with their cause, harness interventions, tokens and cost by agent and model, the key events and links. Look a run up by trace, work item, ticket, request or experiment, or list recent runs. For team leads and the orchestrator reviewing runs (retros), and for any agent checking what happened to its own work.
version: 1.1.0
category: monitoring
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
  - developer
  - qa
  - tpm
  - designer
  - frontend-developer
  - backend-developer
  - fullstack-dev
  - qa-engineer
  - product-manager
  - architect
  - generalist
  - marketing
  - content-strategist
  - sales
  - support
triggers:
  - trace
  - how did the run go
  - what happened to my work
  - why was it stuck
  - where is it now
  - who has it
  - stalls
  - retro
  - autonomy
tags:
  - traces
  - monitoring
  - retros
  - autonomy
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Trace Read

Every unit of work has a **run trace**: one id from the owner's request (or
a goal / experiment) through its tickets, work items, agent turns, messages,
decisions and token usage. `trace-read` turns one into a short summary you
can reason about without pulling hundreds of raw events into your context.

## Read one run

```bash
bash execute.sh --trace tr-20261003-ab12cd34
bash execute.sh --work-item 2c2a1c55-…        # the run a work item belongs to
bash execute.sh --ticket CE-7                  # a project ticket
bash execute.sh --ticket TKT-12                # an owner ticket
bash execute.sh --request <request id>
bash execute.sh --experiment EXP-3
```

You get, in at most `--max-chars` (default 4000):

- **Outcome** — done / cancelled / failed / waiting on the owner / in
  progress, the ticket's status, work items done / failed / open, the
  experiment's verdict.
- **Time** — wall time split into *active* (an agent turn was busy),
  *waiting on owner* (an open decision card, a ticket in review), *waiting on
  agent* (open work, an unanswered agent message) and *idle* (nobody held
  anything).
- **Owner touches** — answered, approved, sent back, corrected (the owner
  stepped in unprompted).
- **Rework** — send-backs, retries, failed verifications, subagent
  send-backs.
- **Harness interventions** — nudges, redeliveries, wakes, corrections,
  guard blocks, misroutes (agent messages that were refused or not
  delivered).
- **Tokens and cost** by agent and by model.
- **Stalls** — gaps longer than `--stall-minutes` (default 30) where nobody
  worked and nothing moved, each with a cause: runtime out of usage or signed
  out, a message not delivered, waiting on the owner, waiting on an agent, or
  nobody pushing.
- **Key events** — state changes, refusals, errors, interventions and owner
  touches, in time order (routine skill calls and usage lines are only
  counted).
- **Links** — the dashboard page with its Timeline tab, and the API.

## Where a request is now

```bash
bash execute.sh --where TKT-12          # or the request id
```

Who holds the owner's request right now, what they are doing (working,
queued, blocked, reviewing, waiting on another agent, waiting on the owner)
and for how long. It follows plain-message hand-offs too: if Ella passed it
to Pia and Pia to Dex, you see all three and that Dex has it. Use this when
the owner asks "how is X going" or "is it forgotten", before guessing.

## Recent runs

```bash
bash execute.sh --since 2026-10-01T00:00:00Z --limit 10
bash execute.sh --since 2026-10-19T00:00:00Z --until 2026-10-26T00:00:00Z --project careerengine --limit 100
```

One line per run, newest first: state, wall / active / waiting-on-owner
time, touches, rework, stalls (and whether one is still going on, and how
the stalled time splits between the harness, the owner and the team),
interventions, cost. Pick one and read it with `--trace`.

Narrow the list:

| Option | Meaning |
|---|---|
| `--until ISO` | Close the window: only runs whose last event is at or before this time |
| `--project ID\|NAME\|PATH` | Only runs of that autopilot project (you must be a member or a supervisor of it) |
| `--day YYYY-MM-DD` | Only runs tagged with that autopilot day (owner / orchestrator unless `--project` is given) |
| `--label LABEL` | Only runs tagged with that ticket label (same rule) |

With `--json`, each row carries `project`, `day`, `labels` and `metrics`
(including `stallMsByCause`), so a weekly review can group runs itself.

### Reading a whole week

The backend embeds metrics in at most 100 rows per call. A busy project has
more runs than that in a week, so page by day: one call per
`--since <day 00:00> --until <next day 00:00>` and add the rows up. Raise
`--max-chars` (up to 64000) when the text of one page is cut.

Idle time by cause, per run, from `metrics.stallMsByCause`:

- **harness**: `runtime_quota` + `delivery_failure` — the system was stuck
  (a runtime out of usage, a message not delivered);
- **owner**: `waiting_on_owner`;
- **team**: `waiting_on_agent` + `nobody_pushing` — the team was stuck.

## Options

| Option | Meaning |
|---|---|
| `--max-chars N` | Output size bound (600–64000, default 4000; one run's summary is at most 16000) |
| `--stall-minutes N` | Stall threshold in minutes (default 30) |
| `--json` | `{traceId, links, text, metrics}` — the full metrics object (not size-bounded) |

## Using it well

- In a retro, name the stage that failed and cite the stall or event by its
  time; say whether it was agent judgement, a missing skill, a harness gap or
  an owner dependency.
- A *waiting on the owner* stall is not a failure by itself; many in a row,
  or long ones with nothing to decide, are.
- *Nobody pushing* means work sat with no owner of the next step: that is
  the run's real gap, not the agent that eventually picked it up.
- Only work started after run traces were enabled (2026-10-03) has a trace.
