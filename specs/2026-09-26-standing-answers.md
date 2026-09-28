# Standing answers (#816, part B)

Status: implemented (PR-B of #816; builds on PR-A,
`specs/2026-09-26-startup-briefing-modular-prompt.md`).

## Problem

Settled knowledge never reached an agent at boot. Memory is a flat pile: in this repo,
327 decisions (229 of them `[COMPLETED]` task records), 189 gotchas and 124 patterns,
plus a 1.9 MB `learnings.md`. Agents had to `recall` it, and project recall does a
whole-query substring match, so the startup query almost never hit.

## Idea

This borrows the "mental models" idea from vectorize-io/hindsight, as an idea only, with
no dependency. There are a few pages per scope, each anchored to one recurring question
and holding the settled answer. They are read at boot as plain files, with no retrieval
and no LLM. They are rewritten only when the memory behind them has moved.

## Pages

| Page id | Scope | File | Question | Sources (citation) |
|---|---|---|---|---|
| `decisions-in-force` | project | `<project>/.crewly/wiki/llm-curated/standing/decisions-in-force.md` | What decisions are in force? | `decisions.json`, excluding `[COMPLETED]` task records (`dec:<id>`) |
| `open-gotchas` | project | `…/standing/open-gotchas.md` | Which gotchas are still open? | `gotchas.json`; resolution time counts (`got:<id>`) |
| `owner-preferences` | project | `…/standing/owner-preferences.md` | What does the owner prefer? | `patterns.json` with category `user_preference` (`pref:<id>`) |
| `unfinished-work` | agent | `<CREWLY_HOME>/agents/<session>/standing.md` | What is my unfinished work, and what is blocking it? | the agent's `roleKnowledge`, excluding report-status `Task completed:` learnings (`mem:<id>`) |

Page format:

```
---
question: "What decisions are in force?"
last_refreshed: 2026-09-26T15:00:00.000Z
watermark: 2026-09-26T14:58:12.000Z
---

## <section heading>
<body>

Sources: dec:<id>, dec:<id>
```

**Watermark.** This is the newest timestamp among the page's in-scope entries at the time
of the last write. A page is **stale** when it is missing, has no watermark, or any
in-scope entry is newer than its watermark.

## Components

- **`StandingAnswersService`** (`services/memory/standing-answers.service.ts`)
  - Parses and serialises pages.
  - Loads each page's sources from the memory JSON files. These are file reads; missing
    or corrupt files count as empty.
  - Computes status: stale, newer-entry count, and the entries examined.
  - `writeSection` edits one section at a time: the same heading (case-insensitive)
    replaces, a new heading appends, and an empty body removes. It enforces the
    following:
    - At least one citation, and every citation must resolve to an entry in the page's
      sources (for example, a `got:` citation is rejected on the decisions page).
    - Heading of one line, at most 80 chars. Body of at most 1,500 chars, with no `#`/`##`,
      `---` or `Sources:` lines.
    - Secrets are **masked** with the wiki `SECRET_PATTERNS`.
    - It stamps `last_refreshed` and moves `watermark` to the sources' current value.
  - `buildRefreshBrief` builds the WorkItem brief: the question, the current sections,
    and up to 30 entries (newer than the watermark first, then older in-force ones), each
    with its citation token. Entry text is masked, and the brief gives the exact skill
    command.
- **`StandingAnswersModule`** (prompt module, priority 1.7, compactable)
  - Renders `## Standing Answers` after Active Work and the session briefing and before
    recovery. The agent page comes first.
  - A stale page shows `**STALE** — N newer memories since this page was refreshed`.
  - Caps: 3,000 chars per page body (with a pointer to the full file) and 8,000 chars for
    the section (about 2,000 tokens). Pages that do not fit are named in a
    "Not shown (prompt cap)" line.
  - Output is masked again, since a page can be hand-edited.
  - Fail-soft: a read error yields no section.
  - The recovery protocol's Step 1 now points to this section before `recall`.
- **`StandingRefreshService`** (`services/memory/standing-refresh.service.ts`)
  - Wired in `index.ts` next to the reflect trigger, on the same cadence
    (`CREWLY_WIKI_REFLECT_INTERVAL_MS`, default 1 h). Disable it with
    `CREWLY_STANDING_REFRESH=false`.
  - Each tick checks every project page for every project, and the agent page for every
    **active** member, so a stopped agent is never woken.
  - It raises a WorkItem (`metadata.kind = standing-refresh`) only when **all** of these
    hold:
    1. the page has in-scope entries;
    2. the page is stale;
    3. the current watermark differs from the one last raised for this page, so the page
       is re-raised only when the watermark moves;
    4. no refresh WorkItem for the page is open;
    5. the 6 h per-page cooldown has passed;
    6. fewer than 2 have been raised this tick.
  - Project pages go to the vault owner (`resolveWikiOwner`: the team leader), else to the
    orchestrator. The agent page goes to the agent itself.
  - The last-raised watermark per page persists in
    `<CREWLY_HOME>/standing-refresh-state.json`.
  - Each tick logs pages examined, created, and skipped by reason.
- **API** `/api/standing`
  - `GET ?projectPath=&sessionName=` returns the statuses and `pagesExamined`.
  - `PUT /:pageId/section` backs the skill. Validation errors return 400 with a `code`
    (`unknown_page`, `invalid_input`, `missing_cite`, `unknown_cite`).
- **Skill** `config/skills/agent/core/standing-update` is a thin client for the PUT. Page
  ids are checked as a slug, and the project/session default from `CREWLY_PROJECT_PATH` /
  `CREWLY_SESSION_NAME`.

## Cost

No LLM runs at write time (`remember`, report-status) or at boot. The only model work is
the agent working a refresh WorkItem, which is gated by the watermark and the cooldown.

**Status-report volume.** PR-A made report-status learnings actually land. A report
writes three things:
- a `[COMPLETED]` decision, which is out of scope for `decisions-in-force`;
- a line in `learnings.md`, which no page reads;
- possibly an agent `roleKnowledge` entry. `Task completed:` entries are out of scope;
  `Task failed:` / `Task blocked:` entries are in scope for the agent page, because
  they describe blockers.

The tests below replay 10 reports through the real memory writers.

## Tests

- `standing-answers.service.test.ts`: parse and serialise, section edits, watermark and
  staleness per source, write validation (11 rejection cases), the agent-page exclusion,
  and the brief. It also covers the **secret** requirement: a key in a source memory is
  masked in the brief, and a key copied into a section is masked in the page.
- `standing-answers.module.test.ts`: ordering, the stale label, the per-page and section
  caps (length ≤ cap even with a 300-char cap), masking, and fail-soft behaviour. It also
  covers **acceptance**: a full `PromptAssemblyService` assembly from files on disk
  answers "decisions in force" and "unfinished work" before the recovery protocol, and a
  newer memory makes the page STALE.
- `standing-refresh.service.test.ts`: each gate above, the tick cap, persistence across
  restarts, routing, and that no secret appears in the WorkItem. It also covers the
  **status-report flood**: 10 "done" reports (one tick after each, inside one cooldown
  window) raise 0 WorkItems and leave every page fresh, and 10 "failed" reports raise
  exactly 1.
- `standing.controller.test.ts`: the router over real HTTP with a real service.
- `config/skills/agent/core/standing-update/tests`: the script → router → service → file
  path end to end.
