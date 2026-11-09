---
name: Ingest Exports
description: Load CSV exports from the tools a small business already uses (Square, QuickBooks, Mailchimp, Jotform, Jackrabbit, Mindbody, Calendly, Stripe) into one common schema (contact / booking / payment / invoice) with the original columns kept, and report rows and date range per file. Unknown CSVs still load with a "could not map" note. --hash-names keeps people's names, emails and phones out of what you store.
version: 1.0.0
category: analysis
skillType: claude-skill
assignableRoles:
  - "*"
triggers:
  - ingest exports
  - load csv export
  - import csv
  - square export
  - quickbooks export
  - mailchimp export
  - jotform export
  - check-up data
tags:
  - csv
  - export
  - check-up
  - small-business
  - square
  - quickbooks
  - mailchimp
  - jotform
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 120000
---

# Ingest Exports

Most tools a small business uses have an **Export to CSV** button even when
they have no API you can get a key for. This skill is the universal fallback
of the small-business check-up (crewly#1055): the owner exports, you ingest,
and every file ends up in the same shape so the analysis does not care where
it came from.

```bash
bash execute.sh --in ~/Downloads/exports --out "$CREWLY_HOME/checkup/<customer>" --hash-names
bash execute.sh --in square-transactions.csv --in invoices.csv --out /tmp/checkup
bash execute.sh --in exports/ --detect-only          # what is each file? writes nothing
```

## Getting the files

- **Google Drive** (the usual drop point): `drive-search` for the folder the
  owner shared, then `drive-read --id <id> --out <path>` per file. Save them
  into one folder and pass that folder as `--in`.
- **App form / attachment**: files land under `$CREWLY_HOME/received/`;
  pass the file paths.

Never ask the owner to paste exported rows into chat.

## What comes out

One JSON line, and under `--out` one `<name>.json` per file plus
`summary.json`:

```json
{"success":true,"files":[{"file":"square-transactions.csv","source":"square","kind":"payment","rows":4,
  "dateRange":{"from":"2026-09-02","to":"2026-09-20"},"unmappedColumns":["Tax","Tip","Card Brand"],"notes":[]}],
 "totals":{"files":1,"rows":4,"byKind":{"payment":4}}}
```

Every record has `kind` (`contact`, `booking`, `payment`, `invoice`, or
`other`), `source`, `file`, `row`, the mapped fields it could fill (`id`,
`name`, `email`, `phone`, `at`, `dueAt`, `endAt`, `amount`, `balance`,
`currency`, `status`, `item`, `tags`) and `original` — every exported column
as it was. Dates are ISO (`2026-09-02` or `2026-09-02T10:14:03`); amounts are
numbers (`"$1,250.00"` → `1250`).

Recognised exports: Square transactions and customers, QuickBooks Online
invoice and customer lists, Mailchimp audience, Jotform submissions,
Jackrabbit enrollments, Mindbody clients, Calendly scheduled events, Stripe
payments. A file that matches none still loads: `source: "unknown"`,
`kind: "other"`, records carry `original` only, and `notes` says
"could not map". Tell the owner which file that was and what tool it came
from; `--source <name>` forces a known mapping when the headers are close.

## People's data

Children's names, parents' emails and phone numbers are in most of these
exports. Run with `--hash-names` unless the analysis truly needs the names:
`name`, `email`, `phone` and every original column that looks personal become
a short stable hash (`h:3f1a…`), so the same person still counts once across
files but nobody's name is stored. Report counts, not names, and run
`checkup-end` when the check-up is over so the `--out` folder goes with a receipt.

## Report back

Per file, in one line each: tool, kind, rows, date range, and anything in
`notes`. Then the totals. Say plainly which files could not be mapped.
