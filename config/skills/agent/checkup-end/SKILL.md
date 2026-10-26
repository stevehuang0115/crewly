---
name: Check-up End
description: End a small-business check-up. Deletes every file the check-up produced on this machine (ingested exports, the analysis with its list of people, the report and daily documents, the intake answers, the time log, the App page copy, and optionally the raw CSV exports) and writes a receipt the owner can keep that says what was deleted, what was kept and what is still to do (unpublish the App, revoke any access). --dry-run lists without deleting.
version: 1.0.0
category: productivity
skillType: claude-skill
assignableRoles:
  - "*"
triggers:
  - end the check-up
  - check-up is over
  - delete check-up data
  - wipe the check-up
  - check-up receipt
tags:
  - check-up
  - small-business
  - privacy
  - cleanup
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Check-up End

The last step of the small-business check-up (crewly#1055). The check-up
leaves rows of people on this machine: the ingested exports, `breaks.json`
with every person behind every break, the report document, the intake
answers. When the check-up is over (the 7 daily lines are posted, or the
owner says stop), delete all of it and give the owner a receipt.

```bash
bash execute.sh --dir . --business "Oak Pottery" --app <appId>        # from the project the team worked in
bash execute.sh --dir . --exports ~/Downloads/oak-exports              # also the raw CSVs the owner handed over
bash execute.sh --dir . --dry-run                                      # list what would go, delete nothing
```

## What it deletes

Only the files the check-up skills are known to write, in the folders the
team template uses under `--dir` (override any with a flag):

| Folder / file | Flag | Files |
|---|---|---|
| `ingest/` | `--ingest` | `*.json` from `ingest-exports` (rows of people), `summary.json`, `unknown-report.json` |
| `analysis/` | `--analysis` | `breaks.json`, `report.md` from `checkup-analyse` |
| `checkup-data/` (or `data/`) | `--data` | `report-doc.json`, `daily-YYYY-MM-DD.json`, `timelog.json` from `checkup-report` |
| `checkup-app/` | `--app-dir` | `index.html` (the App page copy) |
| `intake.json` | `--intake` | the answers read with `app-data --get intake answers` |
| raw exports | `--exports <dir>` | `*.csv` in that folder, not recursive; only when you pass it |

Anything else in those folders (a stray file, a sub-folder, a symbolic link)
is **left alone and listed in the receipt as a leftover**. A folder that ends
up empty is removed. If none of `ingest/summary.json`, `analysis/breaks.json`,
`report-doc.json`, `timelog.json` or `intake.json` exists the skill refuses
(exit 2) and deletes nothing, so it cannot be pointed at the wrong folder.

Run `--dry-run` first when you are not sure what is there; it writes the same
receipt marked as a dry run.

## The receipt

`checkup-end-receipt.json` and `checkup-end-receipt.md` in `--dir` (or
`--receipt <dir>`): the business, when, every file deleted with its kind,
size and whether it held people data, whether names were hashed at ingest,
the leftovers, and **Still to do**. Send the owner the `.md` or say the same
in plain words: what was deleted, that nothing about their customers stays on
this machine, and what you are doing next.

## Still to do — the two things this skill cannot do itself

1. **Unpublish the App.** The report, the intake answers and the daily lines
   live in the App until it is deleted. Run `publish-app --app <appId> --delete`
   (pass `--app` here so the receipt carries the exact command). A public App
   needs `--private` first.
2. **Revoke access.** Crewly stored no key or login for the apps named in the
   intake (this check-up runs on exports); if the owner handed you a key, a
   login or a read-only share, tell them to revoke it in that app. The receipt
   lists the apps from the intake answers.

Never delete before the owner has the report: the 7 daily lines come first,
or the owner's word that the check-up is over.
