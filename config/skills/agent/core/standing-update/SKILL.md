---
name: Standing Update
description: Write, replace or remove one section of a standing-answer page (decisions in force, open gotchas, owner preferences, or your own unfinished work), citing the memory entries it is built from.
natural_language_description: Update the standing answer for a recurring question from the memory entries listed in a refresh WorkItem.
version: 1.0.0
category: memory
skillType: claude-skill
assignableRoles:
  - developer
  - qa
  - tpm
  - designer
  - frontend-developer
  - backend-developer
  - fullstack-dev
  - qa-engineer
  - product-manager
  - architect
  - generalist
  - sales
  - support
  - team-lead
  - orchestrator
triggers:
  - standing answer
  - refresh standing page
  - update standing answers
tags:
  - memory
  - standing-answers
  - knowledge
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Standing Update

Standing-answer pages hold the settled answer to a recurring question, so
agents see it at boot (`## Standing Answers` in the prompt) without calling
`recall`. You normally run this skill while working a **Standing Answer
Refresh** WorkItem: its brief lists the question, the current sections, and
the memory entries to use, each with a citation token such as `dec:<id>`.

| Page id | Scope | Question | Cites |
|---|---|---|---|
| `decisions-in-force` | project | What decisions are in force? | `dec:` |
| `open-gotchas` | project | Which gotchas are still open? | `got:` |
| `owner-preferences` | project | What does the owner prefer? | `pref:` |
| `unfinished-work` | agent | What is my unfinished work, and what is blocking it? | `mem:` |
| `owner-rules` | project | What rules has the owner set explicitly? | none — **owner-only, read it, never write it** |
| `<custom id>` | project | A question the project defined in `.crewly/standing-questions.json` | by its `source` (`dec:`, `got:` or `pref:`) |

**Owner rules.** `owner-rules` (`.crewly/wiki/owner/rules.md`) is written by the
owner only — a write from an agent is refused (`owner_only`). Its sections appear
first in `## Standing Answers` and override the curated pages. When the owner tells
you a rule in chat, do not write it there: record it as a user preference with the
`remember` skill; it reaches the `owner-preferences` page on the next refresh, and
the owner promotes it to a rule if they want it permanent.

**Custom questions.** A project may add up to 10 questions in
`.crewly/standing-questions.json`:

```json
{ "questions": [
  { "id": "release-rules", "question": "What must happen before a release?", "source": "decisions", "match": ["release", "publish"] }
] }
```

Each becomes a page at `.crewly/wiki/llm-curated/standing/<id>.md`, refreshed and
written exactly like the built-in project pages; `match` keeps only entries whose
title or text contains one of the keywords.

Rules the backend enforces:

- One section per call. Same heading (case-insensitive) replaces; a new one appends. Sections you do not write stay as they are.
- **An empty body removes the section.** Use it when a decision was superseded or a gotcha resolved.
- **A section that is still right: write it again unchanged.** The page is not rewritten (`op: unchanged`), but the watermark moves so the page stops being stale.
- Before each content change the previous page is saved under `standing-history/` next to the page, and every write is logged there (`changes.log`).
- Every non-empty section needs at least one citation, and every citation must name an entry in that page's sources.
- Body ≤ 1500 characters, with no `#`/`##` headings, no `---` lines and no `Sources:` line. `###` is fine.
- Anything that looks like a secret is masked before the page is written.

Write the answer as it stands now, not a log of what happened.

## Parameters

| Flag | JSON Field | Required | Description |
|------|-----------|----------|-------------|
| `--page` / `-P` | `page` | Yes | Page id (table above) |
| `--project` / `-p` | `projectPath` | Project pages | Project path (default: `$CREWLY_PROJECT_PATH`) |
| `--session` / `-s` | `sessionName` | Agent page | Your session (default: `$CREWLY_SESSION_NAME`) |
| `--heading` / `-H` | `heading` | Yes | Section heading, one line, ≤ 80 chars |
| `--body` / `-b`, `--body-file` | `body` | Yes | Section body; `""` removes the section |
| `--cites` / `-c` | `cites` | Unless removing | Comma-separated citations (JSON: array or string) |

## Examples

```bash
bash config/skills/agent/core/standing-update/execute.sh --page decisions-in-force --project /path/to/project \
  --heading "Prompt assembly" --body-file /tmp/section.md --cites "dec:0f3c...,dec:9a1b..."

bash config/skills/agent/core/standing-update/execute.sh --page unfinished-work --session dev-1 \
  --heading "PR #818" --body "Waiting on Steve to merge; nothing blocking." --cites "mem:k1..."

# Remove a section that is no longer true
bash config/skills/agent/core/standing-update/execute.sh --page open-gotchas --project /path --heading "Shell globbing" --body ""
```

## Output

`{ success: true, data: { filePath, watermark, op, snapshot, removed, masked } }` where `op`
is `added`, `modified`, `removed` or `unchanged` and `snapshot` is the saved previous page
(null when nothing changed or the page is new). A rejected
write returns HTTP 400 with `code`: `unknown_page`, `invalid_input`,
`missing_cite` or `unknown_cite`, plus a message saying what to fix.

To see the pages, whether each is stale, and how many newer memories exist:
`GET /api/standing?projectPath=<path>&sessionName=<session>`.
