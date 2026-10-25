# Correction ladder (#810)

Status: shipped 2026-10-25 (1.20.420).

## Problem

When a team lead, the orchestrator or the owner corrects an agent, the
correction becomes prose: a learning, an SOP line, a prompt paragraph. Prose
is read every turn and still lets the same mistake back in, while memory and
prompts keep growing. Nothing turned a **repeated** correction into something
enforced (a type, a lint rule, a test, a hook).

## What ships

A per-project tally of corrections by **class** and one team-lead WorkItem
per class the second time it comes back.

### Class

A short slug the recorder chooses for the *kind* of mistake, not the
instance: `git-add-all`, `skip-tests-before-pr`, `owner-thread-status-lines`.
Normalised to `a-z0-9-`, 2–48 chars (`normalizeCorrectionClass`). Agents
reuse the slug; `GET /api/memory/corrections?projectPath=…` lists the
project's classes.

### Where classes come from

| Path | How |
|---|---|
| `record-learning --class <slug> [--task <id>]` | the learning is recorded as before; the class is counted on top (`source: learning`). The answer carries `correction: { class, count, raised }`. |
| Team-leader `handle-failure` with `failureInfo.correctionClass` + `projectPath` | the failure decision is unchanged; the class is counted (`source: failure`) and the output carries `correction`. |
| `POST /api/memory/corrections` | direct count (`source: manual`). |

### The ladder

`CorrectionLadderService` (`backend/src/services/memory/correction-ladder.service.ts`),
store `<project data dir>/correction-ladder.json`:

- every occurrence is appended (newest 20 kept, text trimmed to 400 chars);
- at `THRESHOLD` (2) occurrences with no decision and no open item, the
  lead gets a `delegate` WorkItem: title `Correction ladder: "<class>" came
  back (N×)`, brief with the recorded texts, the four rungs and the
  `decide-correction` command. Target: the lead of a team assigned to the
  project (`resolveWikiOwner` with the project root), else the orchestrator.
  A dormant target is not woken (`target_dormant`); the next occurrence
  tries again;
- one open item per class: a third occurrence while it is open returns
  `already_raised`. An item undecided after 14 days (`REOPEN_AFTER_MS`)
  counts as abandoned and is raised again;
- `decide` records `{ rung, reason, link?, decidedBy, decidedAt }`, clears
  the open item. The reason is required for every rung;
- a `prose` decision is not final: two more occurrences after it raise the
  class again, the brief quotes the earlier reason, and the decision moves to
  `previousDecisions`. `structural` / `check` / `hook` decisions end the
  ladder for the class (`decided`) — if the check does not catch it, that is
  a bug in the check, not a new ladder.

The rungs, highest first:

| Rung | Meaning |
|---|---|
| `structural` | the API, type or file layout changes so the mistake can no longer be expressed |
| `check` | a lint rule, test or CI step fails before merge |
| `hook` | a state-triggered hook or skill guard catches it when it happens |
| `prose` | memory/SOP text stays, with the reason nothing above is worth it |

### Entry points

- `POST /api/memory/record-learning` — `correctionClass?`, `relatedTask?`.
- `POST /api/memory/corrections` — `{ projectPath, correctionClass, agentId, text, source?, relatedTask? }`.
- `POST /api/memory/corrections/:class/decide` — `{ projectPath, rung, reason, link?, decidedBy }`; 404 for an unknown class, 400 for a bad rung or empty reason.
- `GET /api/memory/corrections?projectPath=…`.
- Skills: `agent/core/record-learning` (`--class`, `--task`), `team-leader/handle-failure` (`failureInfo.correctionClass`, `projectPath`), new `team-leader/decide-correction`.

### Closing the WorkItem

The brief says the item counts as done only once the choice is recorded.
Enforcement is by bookkeeping, not by blocking the pool: a WorkItem finished
without a decision leaves `workItemId` set, so the class stays "raised";
after 14 days the next occurrence raises it again. This keeps the pool free
of a new completion rule while making a silently closed item cost nothing
more than a repeat.

## Not in this slice

- Automatic class tagging (an LLM guessing the class from the text): the
  recorder names it. A dedupe over near-identical class names can come later
  from the knowledge evidence merge (#914).
- A dashboard page for the ladder: the API lists it; the team lead works it
  through the WorkItem.
- Cross-project classes: a class is per project, like the memory it
  replaces.

## Source

Lauren Tan's talk: treat human review comments as a signal of what is
missing from the codebase and the framework, in the 5-layer order. Pairs
with #763 (criteria grow from reviewed traces: the eval side).
