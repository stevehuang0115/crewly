# Agent eval runner under version control (#888, slices 1–2)

**Status:** runner versioned at `eval/` with the 2026-04-01 baseline (slice 1);
`run --diff` / `diff` / `record` commands (slice 2, 2026-10-26). Re-run on
current models, business tasks and "not yet" tasks are later slices.

## Problem

The agent eval runner (A1 bug fix, B1 feature, C1 refactor; four runtime
executors; 7-dimension scorer) lived in an untracked local folder next to the
repo. It had not been run since 2026-04-01, the models it measured are gone,
and the folder could be lost with the machine. Issue #888 asks first to version
it and set a baseline, then to make re-running it on every model change one
command.

## Decision: a folder in this repo, not its own repository

`eval/` in the Crewly OSS repo, as a standalone npm package (own `package.json`
and lockfile, not a workspace). Reasons:

- The tasks exercise the same runtimes Crewly ships adapters for, and the
  "not yet" set is meant to gate model changes in this repo. Keeping it here
  lets a PR that changes a model default also update the baseline.
- No secrets, no customer data: the fixtures are synthetic TypeScript projects
  and the results are scores, durations and tool-call counts.
- A separate repository would need the owner to create it and wire billing-free
  CI; private-repo Actions are currently blocked by billing.

Not a workspace, so root `npm ci`, `npm run build`, jest and `eslint .` are
unchanged. Root eslint ignores `eval/`; the package lints with its own
toolchain. The root `tsconfig.json` and both jest configs already list their
roots explicitly, so they never saw the new folder.

## What is committed

- `eval/src/**` — the runner exactly as it was, plus `scorer.test.ts`.
- `eval/fixtures/**` — the three fixture projects without `node_modules`/`dist`.
- `eval/baselines/2026-04-01/` — the last full pass: per-task JSON and report
  for claude-code, codex-cli, gemini-cli and crewly-agent, plus the 4-way
  comparison report. Absolute log paths were rewritten to `eval/...`.
- `eval/README.md` — how to run, how to record a baseline, what is left.
- CI job `eval`: `npm ci`, `tsc --noEmit`, `vitest run` inside `eval/`.

`runs/` and `results/` stay gitignored. A run becomes a baseline only by being
copied into `baselines/<date>/` on purpose.

## Baseline semantics

A baseline is a dated directory. The comparison report in it names the models
and CLI versions, because the runner does not record them.

## Slice 2: one command to re-run and diff (2026-10-26)

`eval/src/diff/baseline-diff.ts`:

- `findLatestBaselineDir(baselines/)` — newest `YYYY-MM-DD` folder.
- `loadResults(dir, runtime?)` — every `<task>-<runtime>-<ts>.json` in the
  directory or its runtime subfolders, newest per task × runtime; stray or
  malformed JSON is skipped, never fatal.
- `diffResults(baseline, current)` — one row per task × runtime. Verdict rules,
  in order: fewer checks passed → `regressed`; `agent_done` lost → `regressed`;
  more checks passed or completion regained → `improved`; `overallScore` moved
  by more than `SCORE_TOLERANCE` (5) → `regressed`/`improved`; else
  `unchanged`. A task on one side only is `missing` (not re-run) or `new` and
  is not counted in `tasksCompared`. Verification checks outrank the score
  because the score mixes in step and cost efficiency, which a model change
  legitimately moves.
- `renderDiffMarkdown` — first line `# Eval diff: N task(s) compared`, then a
  table (checks, score, completion, time, cost, base → now, why).
- `hasRegression` — gate: `diff` and `run --diff` set exit code 1 on it.
- `recordBaseline(results/, baselines/, date, evalRoot, runtime?)` — the manual
  "copy and relativise" steps of the README, as a command; refuses a date that
  is not `YYYY-MM-DD` and an empty results directory.

CLI: `run --all --diff [--baseline <dir>]`, `diff [--runtime r] [--results d]
[--baseline <dir>] [--out file]`, `record --date YYYY-MM-DD [--runtime r]`.
npm scripts `eval:diff` and `diff`.

Tests (`baseline-diff.test.ts`): verdict rules, missing/new accounting, two
runtimes kept apart, markdown header, temp-dir load/record round trip, and the
checked-in baseline self-diffed (12 results, all unchanged) so the test fails
if the baseline files stop parsing.

Not in this slice: running the models (costs the owner's tokens, so it is done
attended), the business tasks, the "not yet" set.

## Slice 3: business tasks (2026-10-26)

Four tasks of category `business`, ids D1–D4, in `task-registry.ts`:

| Id | Fixture | Agent writes | Checker recomputes |
|---|---|---|---|
| D1 | `transactions.csv`, `category-rules.md` | `reports/2026-09-summary.json`, `reports/needs-review.csv` | income/expenses/net/byCategory from the CSV and the keyword rules; the uncategorized rows (2) must be listed and excluded |
| D2 | `brand.md`, `products.json` | `posts/week-41.json` (3 posts) | one post per platform, distinct exact product names, no banned words, length limits, ≥3 Instagram hashtags, text ends with the order link |
| D3 | `inbox/001–006.txt`, `availability.json` | `intake/triage.json`, `intake/replies/<id>.md` | type per message against ground truth; booking slot in the accepted set, no slot used twice; reply exists for every non-spam message, names the sender and (bookings) the slot's `YYYY-MM-DD` and `HH:MM` |
| D4 | `invoices.csv`, `today.txt`, `reminder-template.md` | `reminders/<inv>.md`, `reminders/index.csv` | overdue = unpaid and due < today; reminder per overdue invoice and no other; exact amount / due date / `<n> days overdue` / link; index header and order |

Shape:

- `TaskCategory` gains `'business'`; `EvalTask.provenance?: 'inferred' |
  'interviewed'` records where the bar came from. All four are `inferred`.
- `setupCommands: []` (no npm install); `verification` is one check,
  `node ../../checks/<fixture>/check.mjs`, `expected: 'all_pass'`. The runner
  executes it in `runs/<runId>/`, so `../../checks/` is `eval/checks/`. The
  checker is outside the fixture so the agent's working copy never contains
  the answer key.
- `solutions/<fixture>/` holds a reference output. `task-registry.test.ts`
  copies each fixture to a temp dir and asserts the checker exits non-zero on
  the bare fixture and zero with the solution overlaid, so a checker that
  passes nothing or rejects its own solution fails CI.
- Scorer unchanged: the D2 dimension's tsc/lint/tests bonuses never fire for
  business tasks, which keep the baseline 50.

Not in this slice: running them (attended, owner tokens); owner interviews;
the "not yet" set.

## Acceptance for this slice

- `cd eval && npm ci && npm run build && npm test` pass from a clean clone.
- Root `npm run build`, `npm run lint`, root typecheck and CI unchanged.
- The 2026-04-01 results are readable from the repo without the old folder.
