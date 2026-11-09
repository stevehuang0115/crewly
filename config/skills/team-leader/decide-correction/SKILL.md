---
name: Decide Correction
description: "Record which rung of the correction ladder closes a repeated correction class: structural change, lint/test/CI check, state-triggered hook, or prose with a stated reason (#810)."
version: 1.0.0
category: management
skillType: claude-skill
assignableRoles:
  - team-leader
triggers:
  - decide correction
  - correction ladder
  - make it impossible
  - add a check for this
tags:
  - correction
  - ladder
  - quality
  - management
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Decide Correction

The correction ladder counts corrections per **class** (a short slug such as `git-add-all`) in each project. The second time a class is recorded you receive a WorkItem: the same kind of mistake came back, and prose (memory, SOP, prompt) did not stop it. This skill records your answer and closes the ladder for that class.

## The rungs, highest first

| Rung | Meaning | Example |
|------|---------|---------|
| `structural` | Change the API, type or file layout so the mistake can no longer be expressed | the helper takes a typed enum instead of a free string |
| `check` | A lint rule, test or CI step fails before merge | an ESLint rule, a test that greps for `git add -A` in scripts |
| `hook` | A state-triggered hook or skill guard catches it the moment it happens | a pre-commit hook; a skill script that refuses the argument |
| `prose` | Keep it as memory/SOP text — with the reason nothing above is worth it | "happens once a quarter, the fix costs more than the mistake" |

Do the work for the rung you pick (or open the PR / ticket for it) **first**, then record the choice with the link. A `prose` decision is not final: if the class comes back twice more, the ladder raises it again and names your earlier reason.

## Usage

```bash
bash {{SKILLS_PATH}}/team-leader/decide-correction/execute.sh \
  --project /projects/app --class git-add-all --rung check \
  --reason "test in scripts.test.ts fails on 'git add -A'" --link https://github.com/org/repo/pull/321
```

## Parameters

| Flag | JSON Field | Required | Description |
|------|-----------|----------|-------------|
| `--project` / `-p` | `projectPath` | Yes | Absolute project root the class was recorded in |
| `--class` / `-c` | `correctionClass` | Yes | The class slug from the WorkItem title |
| `--rung` / `-r` | `rung` | Yes | `structural`, `check`, `hook` or `prose` |
| `--reason` | `reason` | Yes | Why this rung (required for every rung) |
| `--link` | `link` | No | PR, file, rule or hook that implements it |
| `--by` | `decidedBy` | No | Your session name (default `$CREWLY_SESSION_NAME`) |

## Output

The class record: tally, occurrences, and the decision just made. To see every class of a project: `GET /api/memory/corrections?projectPath=<root>`.

The owner is not involved in ladder decisions. Never post them in the owner's thread.
