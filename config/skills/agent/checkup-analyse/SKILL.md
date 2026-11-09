---
name: Check-up Analysis
description: The analysis step of the small-business check-up. Reads what ingest-exports wrote, links the same person across every file, follows inquiry → sign-up → payment → repeat and lists where it breaks (unanswered inquiries, sign-ups with no payment, payments from nobody on the roster, drop-outs, lapsed customers, overdue invoices, double entry, customers missing from the mailing list), each with an hours/week and $/month estimate whose formula is shown. Writes breaks.json and report.md.
version: 1.0.0
category: analysis
skillType: claude-skill
assignableRoles:
  - "*"
triggers:
  - check-up analysis
  - analyse check-up
  - find the breaks
  - where does the business leak
  - checkup report
  - top 3 breaks
tags:
  - check-up
  - small-business
  - analysis
  - report
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 120000
---

# Check-up Analysis

Step 3 of the small-business check-up (crewly#1062). After `ingest-exports`
has turned the owner's CSV exports into one schema, this skill reads that
folder and says where the chain **inquiry → sign-up → payment → repeat**
breaks between the apps, and what each break costs.

```bash
bash execute.sh --in "$CREWLY_HOME/checkup/<customer>/ingest" --out "$CREWLY_HOME/checkup/<customer>/analysis"
bash execute.sh --in …/ingest --as-of 2026-10-31 --assume hourlyValue=40 --assume lapsedDays=60
bash execute.sh '{"in":"…/ingest","out":"…/analysis","asOf":"2026-10-31","assume":{"winBackRate":0.1}}'
```

`--in` is the `--out` folder of `ingest-exports` (or single `<file>.json`
files from it). `--as-of` defaults to the last dated activity in the data;
pass today's date when the exports are fresh so overdue and lapsed are
measured against now.

## The breaks

| type | what it means |
|---|---|
| `inquiry_no_follow_through` | a form submission (Jotform) from someone with no sign-up and no payment at any time |
| `signed_up_unpaid` | a sign-up (Jackrabbit, Mindbody, Calendly) with no payment from that person on or after it (7-day grace before) |
| `paid_not_listed` | a payment from someone on no roster (only checked when a roster export is present) |
| `dropped` | a sign-up marked dropped / cancelled |
| `lapsed` | a customer with no activity for `lapsedDays` (90) before as-of |
| `overdue_invoices` | an invoice with a balance whose due date is before as-of |
| `double_entry` | the same person (by email, then phone) in two or more systems; notes a phone missing in one or differing names on contact rows |
| `not_on_mailing_list` | a paying or signed-up customer the mailing list (Mailchimp) does not have (only when a list export is present) |

People are linked by email first, then phone, then name when a row has
neither. Hashed exports (`ingest-exports --hash-names`) link the same way,
so the counts are identical and no name appears in the output.

## Estimates

Every break carries `estimate: { hoursPerWeek, dollarsPerMonth, formula,
isEstimate: true }`. The formula is written out with the numbers used, e.g.
`$180 in unpaid fees ÷ 1 months = $180/month; 1 × 10 min ÷ 3.3 weeks = 0.1
h/week`. The inputs are assumptions the owner can change with
`--assume key=value`:

- `hourlyValue` 30 — what an hour of the owner's or staff's time is worth
- `minutesPerManualEntry` 4, `minutesPerFollowUp` 10
- `inquiryConversionRate` 0.3, `winBackRate` 0.2, `listReachRate` 0.1
- `lapsedDays` 90
- `avgCustomerValue` — default: the mean paid amount / sign-up fee in the data

Hours and dollars are spread over the period the data covers (first activity
to as-of), so a one-off $180 over one month reads as $180/month.

## What comes out

One JSON line (per-break count and estimate, `top3`, `totals`, `notes` for
checks the data could not support) and, with `--out`:

- `breaks.json` — everything, including every item (person label, dates,
  amounts, systems, conflicts) and the assumptions used
- `report.md` — the owner-facing text: top 3 breaks with count, estimate,
  formula and what an agent could do for each, then every break, the files,
  and the assumptions

## Report back

Give the owner the top 3 in plain words with the count and the estimate, and
say that the dollars are estimates from the assumptions listed. Name people
only when the owner needs to act on them and the exports were not hashed;
otherwise report counts. Do not paste `breaks.json`. If `notes` says a check
could not run (no roster export, no mailing-list export), say which export
would make it possible.
