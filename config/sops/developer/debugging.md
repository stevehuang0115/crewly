---
id: dev-debugging
version: 2
createdAt: 2026-10-13T00:00:00Z
updatedAt: 2026-10-26T00:00:00Z
createdBy: system
type: sop
role: developer
category: debugging
priority: 9
title: Debugging
description: How to debug a failure — a red-capable loop first, ranked falsifiable hypotheses, tagged debug logs, cleanup
triggers:
  - debug
  - failing test
  - bug
  - regression
  - flaky
  - broken
  - repro
tags:
  - debugging
  - testing
  - quality
# Rule metadata (#877): what this rule prevents, where seen, when to re-test
prevents: "none recorded as an incident — no debugging SOP existed; added with a pre-commit scan for leftover [DEBUG- markers, borrowed from mattpocock/skills"
seenOn: "unknown (2026-10)"
reviewBy: 2027-01-31
source: https://github.com/stevehuang0115/crewly/pull/1277
---

# Debugging

Long form: mattpocock/skills `diagnosing-bugs`. Redact secrets in every command and artifact you show.

## 1. Loop first

Name **one command** you have already run at least once that shows the user's exact symptom (red-capable), is deterministic, fast and runnable by you. If you are reading code to build a theory before this command exists, stop and build the command.

## 2. Reproduce and minimise

For a dashboard (UI) report, run the `reproduce-ui` skill on the feature first. A screenshot and a sentence is enough: read the screenshot, then `bash config/skills/agent/core/reproduce-ui/execute.sh --report "<the sentence> <headings, tab names and labels you see>"` matches it to a `frontend/FEATURE_MAP.md` entry and opens it (exit 3 = ambiguous: it lists the candidate routes, run again with `--route`; `--feature <word>` and `--route "/tickets?tab=runs"` work when you already know the page). Read its `console.json` and `requests.json` before the screenshot — a failed `/api/...` call explains most blank or stale pages. Put its `ticketLine` (from the JSON it prints, also in `report.md`) in the ticket; after the fix run it again and add the second line as proof.

Cut inputs one at a time. Done when every remaining element is load-bearing.

## 3. Hypotheses

Write 3-5 ranked hypotheses before testing any. Each is falsifiable: "If X is the cause, then changing Y makes the bug disappear." If you cannot state the prediction, it is a guess. Test one at a time.

## 4. Instrument

Tag every debug log with a unique prefix, e.g. `[DEBUG-a4f2]`, so cleanup is one grep. Untagged logs survive; tagged logs die. If no correct seam exists to test the bug, that is itself the finding.

## 5. Fix with a regression test

Turn the loop into a test. See it fail first, then fix (see `testing-requirements`: red before green).

## 6. Clean up

`grep -rn "\[DEBUG-" .` returns nothing. The pre-commit hook rejects a staged `[DEBUG-` line.
