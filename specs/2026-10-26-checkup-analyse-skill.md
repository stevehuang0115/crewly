# Check-up analysis skill (crewly#1062, slice 1)

Step 3 of the small-business check-up (#1055): after `ingest-exports` has put
the owner's CSV exports into one schema, say where the apps disagree and what
each break costs. Slices still to come for #1062: the intake form App, the
report App page and the team template that strings intake → connect →
analyse → report together with a reviewer step and a time log.

## Shape

`config/skills/agent/checkup-analyse/` — bundled, assignable to every role,
Node only, no dependencies, no model calls.

- `execute.sh` — flag or JSON input (`in`/`inputs`, `out`, `asOf`,
  `assume`/`assumptions` map), execs `node analyse.mjs`.
- `analyse.mjs` — exports `classify`, `analyse`, `renderReport`,
  `DEFAULT_ASSUMPTIONS`.
  - Input: the `--out` folder of `ingest-exports` (every `*.json` except
    `summary.json`) or single record files. `summary.json` is not needed.
  - People: a union-find over identity keys. A row's keys are `e:<email>`
    and `p:<phone digits>`; `n:<name>` only when the row has neither. Hashed
    values (`h:…`) are used as they are, so hashed exports link identically.
    The label shown for a person is the name on a contact or payment row
    (the adult) before the name on a booking row (often the child).
  - Events: `payment` / `refund` / `failed_payment` (kind payment by status),
    `invoice`, `inquiry` (booking from a form tool: Jotform), `signup` /
    `dropped` (booking from a roster tool: Jackrabbit, Mindbody, Calendly;
    dropped/cancelled/withdrawn status), `listed` (contact from a mailing
    list: Mailchimp), `contact` (any other contact), `other` (ignored, counted).
  - Period: first dated activity (inquiry, sign-up, payment, invoice; not
    contact creation) → as-of (default: the last dated activity). Weeks and
    months are floored at 1 so a short export is not divided into nothing.
  - Breaks (each `{ type, label, count, items, estimate, whatAnAgentCouldDo }`):
    `inquiry_no_follow_through`, `signed_up_unpaid` (no payment from the
    person on or after the sign-up, 7-day grace before), `paid_not_listed`
    (only when a roster system is present), `dropped`, `lapsed`
    (`lapsedDays` before as-of, judged on `at` and `endAt`), `overdue_invoices`
    (balance > 0, due before as-of; `openNotYetDue` counted),
    `double_entry` (2+ distinct sources; conflicts: phone missing on one
    contact row, names differing across contact rows only), `not_on_mailing_list`
    (only when a mailing list is present).
  - Estimates: `{ hoursPerWeek, dollarsPerMonth, formula, isEstimate: true }`
    plus `outstanding` / `extraEntries` where they apply. `formula` is the
    sentence with the numbers used. Inputs come from `DEFAULT_ASSUMPTIONS`
    (`hourlyValue` 30, `minutesPerManualEntry` 4, `minutesPerFollowUp` 10,
    `inquiryConversionRate` 0.3, `winBackRate` 0.2, `listReachRate` 0.1,
    `lapsedDays` 90, `avgCustomerValue` = mean paid amount / sign-up fee in
    the data, $50 with a note when there is none). `--assume k=v` overrides;
    an unknown key or a non-number is a usage error.
  - `top3`: breaks with count > 0 by $/month, then h/week.
  - `notes`: checks the data could not support ("no roster export", "no
    mailing-list export", "no paid amounts").
- Output: one JSON line (`success`, `asOf`, `period`, `people`, `systems`,
  per-break `{type, count, hoursPerWeek, dollarsPerMonth}`, `top3`, `totals`,
  `notes`, `problems`, `out`); with `--out`, `breaks.json` (the full result)
  and `report.md`.
- Exit codes: 0 analysed; 2 nothing to analyse or a file could not be read
  (the rest is still analysed and `problems` names the file); 1 usage.

## Tests

`execute.test.sh` (77 checks, not in CI; `bash execute.test.sh`): runs
`ingest-exports` on its fixtures, then checks each planted break by person,
the period and label rules, estimate formulas and ranking, the report text,
`--as-of` moving overdue/lapsed, `--assume`, hashed input (same counts, no
names), partial data notes, single-file input, JSON input and every error
path. The skill-lint jest test covers the frontmatter.

## Not in this slice

- The intake form and the report App page (Crewly Apps) — #1062 next slices.
- Linking by fuzzy name or address; a person is one email or one phone.
- Reading connector data directly; the skill reads ingest-exports output
  only, so API connectors (#1057–#1059) will need to write the same schema.
