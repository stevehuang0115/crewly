# Check-up report App skill (crewly#1062, slice 2)

Steps 1 (intake) and 4 (report + 7-day daily summary) of the small-business
check-up (#1055), as one Crewly App the owner opens on their phone. Slice 1
was `checkup-analyse` (`specs/2026-10-26-checkup-analyse-skill.md`); the
team template that strings the steps together is the remaining slice.

## Shape

`config/skills/agent/checkup-report/` — bundled, assignable to every role.

- `app/index.html` — the App page, built once, data per business. Three
  tabs:
  - **Report**: reads `report/current`. Headline (as-of, period, people,
    systems, total h/week and $/month, "estimates" note), the number the
    owner asked to see first (`firstNumber`, when the intake named one), the
    top 3 (rank, label, count, estimate, formula, up to three examples, what
    an agent could do), every break as a table, "Could not check" notes,
    files, assumptions, and an "Ask about this report" button that calls
    `crewly.notify` so the publishing agent answers in the DM. With no
    report, an empty card points to the intake.
  - **Your answers**: the five intake questions (apps as chips + free text;
    slowest weekly task; fears as chips + free text; apps per customer;
    which number first as chips + free text). Save writes `intake/answers`
    (`{ apps[], slowestTask, fears[], appsPerCustomer, firstNumber, savedAt }`)
    and calls `crewly.notify` so the agent starts the connect step. Needs at
    least the apps or the task.
  - **Daily**: lists `daily/*` (`{ date, summary, postedAt }`) newest first.
  - Opens on the intake when there is neither a report nor answers; subscribes
    to `report` and `daily` so the page updates when the agent writes.
  - Follows the Crewly Apps rules: no network, no storage, no alert, text
    only (`textContent`), `data-crewly-id` on the key elements, ES2019-free
    syntax and a `replaceChildren` polyfill for iOS 12.
- `report.mjs` — exports `buildReportDoc(breaks, { business, intake, examples })`.
  - `--app-dir <dir>`: copies `app/*` into the project (publish-app needs a
    project path). Output `next` = the publish-app command.
  - `--breaks <breaks.json> [--business] [--intake answers.json] [--examples N] --out <dir>`:
    writes `report-doc.json` = `{ business, generatedAt, asOf, period, stats
    { people, systems, records }, totals, breaks[{ type, label, count,
    estimate { hoursPerWeek, dollarsPerMonth, formula, isEstimate },
    whatAnAgentCouldDo, examples[] }], top3, notes, files, assumptions,
    firstNumber? }`. Items are not copied; `examples` are up to N (3) short
    lines per break, none when the labels are hashes (then one line "N people
    (names hashed)"). `--intake` accepts the plain document or app-data's
    `{ success, data }` output. `firstNumber` maps the owner's choice (chip or
    free text) to one of: money owed (overdue invoices + unpaid sign-ups
    outstanding), missed inquiries (count), double-entry hours (h/week),
    lapsed (count); an unmappable choice becomes a note. The document is
    refused above 200 KB (App documents cap at 256 KB). `next` = the
    app-data `--set report current` command.
  - `--daily "<summary>" [--date YYYY-MM-DD] --out <dir>`: writes
    `daily-<date>.json`; `next` = app-data `--set daily <date>`.
  - Exit 0 done; 2 an input missing or not a breaks.json; 1 usage.
- `execute.sh` — flags or JSON (`appDir`, `breaks`, `business`, `intake`,
  `examples`, `out`, `daily`, `date`, `logStep`, `mark`, `at`).

### Time log (slice 3)

`--log-step <intake|connect|analyse|report|daily> --start|--end [--at <iso>]
--out <dir>` keeps `<dir>/timelog.json`:

```json
{ "steps": [ { "step": "intake", "startedAt": "…", "endedAt": "…", "minutes": 12.5 } ] }
```

`--start` opens an entry (a second start on a still-open step restarts it);
`--end` closes the latest open entry of that step, fills in `minutes` (one
decimal) and refuses when nothing is open (exit 2) or the end is before the
start (exit 1). Unknown step → exit 1. `--breaks` reads `timelog.json` from
the same `--out` and adds `timing: { steps, totalMinutes, open }` to the
report document; the page shows it under "How long it took" (minutes per
step, "still running" for open ones, the total). No log → no `timing` and
no block.

### Team template (slice 3)

`config/templates/small-business-checkup.json` — free, flat (members only,
no workflows): **Checkup Lead** (product-manager; runs intake → connect →
analyse → report → daily, logs every step, waits for the Reviewer when one is
on the team), **Data Analyst** (researcher; connectors or `ingest-exports`,
`--hash-names` for children's data, `checkup-analyse`, reports the files and
unsupported checks), **Reviewer** (qa; checks `report-doc.json` against
`breaks.json` and the intake, answers "approved" or a numbered fix list).
The reviewer is the switch for the review step: remove the member and the
lead publishes on its own check. `templates.test.ts` pins the member list,
the skills named, the `--log-step` instruction, the removable reviewer and
the no-people-in-chat rule.

## Flow for the agent (SKILL.md)

1. `checkup-report --app-dir ./checkup-app` → `publish-app --dir ./checkup-app --name "<Business> check-up" --notify`.
2. Owner saves the five answers → `[APP CHANGES]` + notify → `app-data --get intake answers`.
3. Connect (`ingest-exports`, connectors) → `checkup-analyse` → `breaks.json`.
4. `checkup-report --breaks … --business … --intake … --out ./checkup-data` →
   `app-data --set report current --data-file …` → `publish-app --app <id> --share`.
5. Seven days of `checkup-report --daily "…"` → `app-data --set daily <date>`.
6. `checkup-report --log-step <step> --start|--end --out ./checkup-data`
   around every step; the report carries the minutes.

## Tests

`execute.test.sh` (98 checks, not in CI): the page's sandbox rules by grep
and a Node syntax parse; `--app-dir` copy; the report document from the
analyse fixtures (shape, no items, examples per type and cap, each
first-number mapping incl. free text and app-data output shape, unmappable
→ note, hashed → counts only); `--daily`; the time log (start/end, restart,
minutes, JSON input, folded into the report, every error path); every other
error path. The
page was also rendered in jsdom with a mock `window.crewly` in both the
report and the empty/intake state (not committed; tabs, first number, top 3
cards, table, daily list, ask → notify, chips → saved document all behaved).

## Not in this slice

- A visitor (public) view; the App stays private to the owner.
- Charts; the report is text and one table on purpose (phone, old iPads).
