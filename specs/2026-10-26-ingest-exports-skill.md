# Ingest exports skill (crewly#1061)

Part of the small-business check-up (#1055). Tools without a self-serve API
almost all have an Export to CSV button; this skill is the universal fallback
that needs no vendor approval.

## Shape

`config/skills/agent/ingest-exports/` — bundled with Crewly, assignable to
every role.

- `execute.sh` — flag or JSON input (`in`/`inputs`, `out`, `hashNames`,
  `detectOnly`, `source`), execs `node ingest.mjs`.
- `ingest.mjs` — the work, Node only (no npm dependencies):
  - `parseCsv`: RFC 4180 (quoted fields, doubled quotes, CR/LF, BOM); blank
    lines dropped; headers trimmed.
  - `detectSource(headers)`: first signature whose `requires` headers are all
    present (case-insensitive). Signatures: Square transactions (payment),
    Square customers (contact), QuickBooks invoice list (invoice), QuickBooks
    customer list (contact), Mailchimp audience (contact), Jotform submissions
    (booking), Jackrabbit enrollments (booking), Mindbody clients (contact),
    Calendly scheduled events (booking), Stripe payments (payment).
  - `toRecord`: `{ kind, source, file, row, id?, name?, email?, phone?, at?,
    dueAt?, endAt?, amount?, balance?, currency?, status?, item?, tags?,
    original }`. `at` is ISO (`YYYY-MM-DD` or with `THH:MM:SS`; US
    `MM/DD/YYYY` converted); amounts are numbers (`$`, thousands separators
    and `(neg)` handled). `original` keeps every exported column.
  - Unknown headers: `source: "unknown"`, `kind: "other"`, records with
    `original` only, note "could not map: …". Nothing is dropped.
  - `--hash-names`: `name`/`email`/`phone` and every original column whose
    header names a person (name, child, parent, email, phone, address, …, but
    not age/count/rating/total/spend/visits) become
    `h:<sha256(lower(trim(v)))[:12]>`, stable across files so one person
    still counts once.
  - Output: one JSON summary line on stdout; with `--out`, `<name>.json` per
    file (`schemaVersion`, `file`, `source`, `sourceLabel`, `kind`, `rows`,
    `columns`, `unmappedColumns`, `dateRange`, `namesHashed`, `notes`,
    `records`) and `summary.json`. Exit 0 all loaded, 2 some file unreadable
    (the rest still written), 1 usage.
- `fixtures/` — seven small fake exports (one per recognised tool required
  by the issue plus one unknown); `execute.test.sh` runs the skill over them
  and checks detection, counts, date ranges, normalisation, the unknown-file
  path, hashing, `--detect-only`, JSON input, missing files and `--source`.

## Not in this slice

Reading the files from Drive is done with the existing `drive-search` /
`drive-read --out` skills (SKILL.md says so). Deleting ingested data at the
end of a check-up is #1055's "end check-up" item.
