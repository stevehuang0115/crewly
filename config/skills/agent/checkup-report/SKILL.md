---
name: Check-up Report
description: The intake and report steps of the small-business check-up as one Crewly App. Copies the bundled App page (five intake questions, the report with the top 3 breaks and what an agent could do, a 7-day daily summary) into the project for publish-app, turns checkup-analyse's breaks.json into the App's report document (with the number the owner asked to see first), and writes daily-summary documents for app-data.
version: 1.0.0
category: productivity
skillType: claude-skill
assignableRoles:
  - "*"
triggers:
  - check-up report
  - checkup app
  - publish the check-up
  - intake questions
  - daily check-up summary
tags:
  - check-up
  - small-business
  - apps
  - report
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Check-up Report

Steps 1 and 4 of the small-business check-up (crewly#1062), on one Crewly
App the owner opens on their phone: **Your answers** (five intake questions),
**Report** (the top 3 breaks with estimate, formula, examples and what an agent
could do; every break; files; assumptions) and **Daily** (a line a day for the
7 free days after the report). The page is built once; the data is per
business.

## 1. Intake — publish the App and get the five answers

```bash
bash execute.sh --app-dir ./checkup-app          # copies the page into the project (publish-app needs a project path)
bash publish-app --dir ./checkup-app --name "<Business> check-up" --notify
```

The owner lands on **Your answers** (no report yet): which apps, the slowest
weekly task, what they fear slipping through, how many apps one customer
passes through, which number they want to see first. Saving writes
`intake/answers` and sends you a message. Read it:

```bash
bash app-data --app <appId> --get intake answers > ./intake.json
```

Use `apps` to decide the connect path per app (connector, `ingest-exports`,
or the browser as last resort) and `firstNumber` for the report.

## 2. Connect and analyse

`ingest-exports` (exports → common schema) then `checkup-analyse`
(breaks + estimates → `breaks.json`). See those skills.

## 3. Report — put the result in the App

```bash
bash execute.sh --breaks <analysis>/breaks.json --business "<Business>" --intake ./intake.json --out ./checkup-data
bash app-data --app <appId> --set report current --data-file ./checkup-data/report-doc.json
bash publish-app --app <appId> --share          # a fresh one-tap link to the owner
```

`report-doc.json` holds the top 3, every break with its estimate and formula,
up to three short examples per break (none when the exports were hashed),
notes for checks the data could not support, the files and the assumptions.
When the intake said which number to see first, the report leads with it
(`firstNumber`): money owed (overdue invoices + unpaid sign-ups), missed
inquiries, hours lost to double entry, or lapsed customers. The whole list of
people never goes into the App; it stays in `breaks.json` on this machine.

## 4. Daily — one line a day for 7 days

```bash
bash execute.sh --daily "Replied to 3 open inquiries; 1 booked. Sent 2 invoice reminders." --out ./checkup-data
bash app-data --app <appId> --set daily 2026-10-27 --data-file ./checkup-data/daily-2026-10-27.json
```

Say what changed and what was done, in the owner's language, under 300
characters. Seven entries, then stop unless the owner asks for more.

## Time log

Record the start and end of each step (intake, connect, analyse, report) in
your work notes; the check-up is measured by how long it really takes.

## Report back

Tell the owner in plain words: the App is ready (the card has the link), the
top 3 with count and estimate, that the dollars are estimates from listed
assumptions, and the one thing you would start on. Do not paste the document.
