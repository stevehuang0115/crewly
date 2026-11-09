# Check-up end skill (crewly#1055, "end a check-up")

The last step of the small-business check-up (#1055): when the 7 daily
lines are posted or the owner says stop, everything the check-up left on
the machine goes, and the owner gets a receipt. The issue's item reads
"revoke all keys/tokens and delete ingested data, with a receipt — depends
on the connectors". The connectors (#1057–#1059) do not exist yet, so this
slice is the half that does not depend on them: the local data and the
receipt. Revoking a connector token is a line in the receipt's "Still to do"
until a connector exists to revoke from.

## Shape

`config/skills/agent/checkup-end/` — bundled, assignable to every role.

- `end.mjs` — the work, Node only.
  - `--dir <project>` is the folder the team worked in. The slots default to
    the template's layout (`ingest/`, `analysis/`, `checkup-data/` or
    `data/`, `checkup-app/`, `intake.json`); `--ingest`, `--analysis`,
    `--data`, `--app-dir`, `--intake` override one each. `--exports <dir>`
    adds the raw CSV folder the owner handed over.
  - **Only files the check-up skills are known to write are deleted**, by
    name per folder: ingest `*.json` (+ `summary.json`, `unknown-report.json`),
    analysis `breaks.json` / `report.md`, data `report-doc.json` /
    `daily-YYYY-MM-DD.json` / `timelog.json`, app-dir `index.html`,
    `intake.json`, and `*.csv` directly in `--exports`. Everything else in
    those folders (other files, sub-folders, symbolic links) is a
    **leftover**: left alone and listed. Links are never followed
    (`lstat`). A folder left empty is removed.
  - **Guard:** at least one of `ingest/summary.json`, `analysis/breaks.json`,
    `report-doc.json`, `timelog.json`, `intake.json` must exist, else exit 2
    and nothing is touched — the skill cannot be pointed at an arbitrary
    folder. Running it a second time therefore refuses too.
  - `--dry-run` lists and writes the receipt (marked) without deleting.
  - **Receipt** `checkup-end-receipt.json` + `.md` in `--dir` or
    `--receipt <dir>`: `{ schemaVersion, business, endedAt, dryRun, root,
    deleted[{ path, bytes, kind, people }], bytes, failed[], removedFolders[],
    leftovers[{ path, note }], namesHashed (from ingest `summary.json`),
    todo[], receipt }`. `todo` is always the two things the skill cannot do:
    unpublish the App (`publish-app --app <id> --delete`, exact when `--app`
    is passed) and revoke access (the apps from the intake answers, with the
    note that Crewly stored no key or login for them — exports only).
  - Output: one JSON line `{ success, dryRun, deleted, bytes, peopleFiles,
    leftovers, failed, receipt, next[] }`. Exit 0 done or dry run; 2 not a
    check-up folder, missing folder, or a file would not delete; 1 usage.
- `execute.sh` — flags or JSON (`dir`, `business`, `app`, `exports`,
  `ingest`, `analysis`, `data`, `appDir`, `intake`, `receipt`, `dryRun`).
- `execute.test.sh` — builds a real check-up with the three sibling skills
  over the ingest fixtures and checks: dry run deletes nothing and writes the
  marked receipt; a real run removes every known file and empty folder, keeps
  and lists a stray file, a sub-folder and a symlink; `--exports` removes
  only top-level CSVs; a non-check-up folder is refused with nothing touched;
  JSON input, slot override and `--receipt`; a second run refuses.

## Team template

`small-business-checkup`'s Checkup Lead prompt gains the end step: after the
seventh daily line or the owner's word, `checkup-end` (dry run first if
unsure, `--exports` when CSVs were handed over), then
`publish-app --app <appId> --delete`, then the receipt to the owner in plain
words. `checkup-report` and `ingest-exports` SKILL.md point at it.

## Not in this slice

Revoking a connector's token from inside the skill: there is no connector to
revoke from yet. When #1057–#1059 land, `checkup-end` should call each
connector's disconnect and move "revoke access" from `todo` to `deleted`.
Deleting the App from inside the skill was left to `publish-app --delete` on
purpose: that skill already owns the private/public rule and the API call,
and the receipt carries the exact command.
