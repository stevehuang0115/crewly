---
name: Sheets Write
description: Create a Google Sheet with rows, or append / overwrite rows in a spreadsheet Crewly created (via the Google Workspace grant held by Crewly Cloud). Takes JSON rows or a CSV file. Writes as the owner — share the link when done.
version: 1.0.0
category: productivity
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
  - developer
  - operations
  - ops
  - sales
  - support
  - generalist
triggers:
  - create spreadsheet
  - write to google sheet
  - add rows to the sheet
  - export to sheets
tags:
  - google
  - sheets
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Sheets Write

```bash
bash execute.sh --title "Leads Sept" --csv-file /tmp/leads.csv --sheet "Raw"
bash execute.sh --id 1AbC… --rows '[["Bob","bob@x"]]'                      # append below the table at A1
bash execute.sh --id 1AbC… --rows '[["done"]]' --range "Raw!C2" --mode update
```

## Output

```json
{"success":true,"action":"create","id":"1AbC…","title":"Leads Sept","sheets":["Raw"],"webViewLink":"https://docs.google.com/spreadsheets/d/1AbC…/edit"}
{"success":true,"action":"append","spreadsheetId":"1AbC…","updatedRange":"Raw!A3:B3","updatedRows":1}
```

Values are entered as if typed (`USER_ENTERED`): `=SUM(A1:A9)` becomes a
formula, `2026-09-19` a date. Max 5000 rows per call. Writing to a sheet
the owner made outside Crewly needs the Sheets write scope (`403 google_error`).

## Failures

`{"success":false,"reason":"not_connected","hint":"<connect URL>"}` (exit 1)
when the owner has not connected Google Workspace (Settings → Integrations).
A `403` with `reason: "google_error"` on a write means the file was not
created by Crewly — the grant only edits files Crewly made (`drive.file`).

## Choosing a Google account

Several Google accounts can be connected at once. Without `--account` the call uses the default one (the first you connected, or whichever you marked default on the Connections page). Name one explicitly when it matters:

```bash
bash execute.sh --account work@company.com ...
```

The account must be connected *for this product* — Google consent is per product (Gmail / Calendar / Drive), so an account connected only for Calendar cannot read Drive.
