# Crewly agent eval runner

Real-execution benchmarks for the coding-agent runtimes Crewly can drive. Each
task is a small TypeScript fixture project with a planted problem; the runner
copies it into `runs/`, hands the task to one runtime, then runs the task's
verification commands (tsc, tests, grep checks) and scores the run on seven
dimensions. Nothing here is an LLM opinion: every pass condition is a command
with an exit code.

Part of the Crewly repo since 2026-10-25 (issue #888). Before that it lived in
an untracked folder and was last run on 2026-04-01; that run is kept as
[`baselines/2026-04-01/`](baselines/2026-04-01/comparison-report.md).

## Layout

| Path | What |
|---|---|
| `src/cli.ts` | `crewly-eval run / list` |
| `src/tasks/task-registry.ts` | The task set: A1 (bug fix), B1 (feature), C1 (refactor), D1–D4 (business) |
| `src/executors/` | One adapter per runtime: `claude-code`, `codex-cli`, `gemini-cli`, `crewly-agent` |
| `src/runner/eval-runner.ts` | Copies the fixture, runs setup, runs the agent, runs verification |
| `src/scorer/scorer.ts` | 7-dimension score (D1 correctness 25%, D2 quality 15%, D3 reasoning 20%, D4 autonomy 15%, D5 context 10%, D6 collaboration 5%, D7 cost 10%) |
| `src/results/report-generator.ts` | Per-runtime markdown report + JSON per task |
| `src/diff/baseline-diff.ts` | `diff` / `record`: newest results vs the latest `baselines/<date>/`, per task |
| `fixtures/<task>/` | The fixture projects (tiny, no node_modules committed); for D tasks, the owner's input files |
| `checks/<task>/check.mjs` | D tasks only: the checker, kept outside the fixture so the agent never sees the answer key |
| `solutions/<task>/` | D tasks only: a reference output the unit test runs through the checker |
| `baselines/<date>/` | Recorded runs: per-runtime JSON + report, plus the comparison report |
| `runs/`, `results/` | Generated, gitignored |

The package is standalone: it has its own `package.json` and lockfile and is
not an npm workspace of the repo, so the main build, jest and lint never touch
it. CI typechecks it and runs its unit tests in the `eval` job.

## Run it

```bash
cd eval
npm ci
npm run build
node dist/cli.js list
node dist/cli.js run --all --runtime claude-code     # needs `claude` on PATH
node dist/cli.js run --task B1 --runtime codex-cli   # needs `codex`
node dist/cli.js run --all --runtime gemini-cli      # needs `gemini`
node dist/cli.js run --all --runtime crewly-agent --crewly-url http://localhost:3000
```

Each run writes `results/<task>-<runtime>-<ts>.json`, a log under
`results/logs/`, and `results/eval-report-<ts>.md`. Runs use the owner's own
CLI logins, so a full 3-task pass costs real tokens (the 2026-04-01 pass was
roughly $0.03 on Gemini Flash and $0.45 on Codex; Claude Code cost was not
parsed).

## Business tasks (D1–D4)

Crewly's users mostly run small businesses, not codebases, so the set also has
four tasks that are files in, files out, with no build step:

| Task | Input | Output | Checker |
|---|---|---|---|
| D1 bookkeeping | bank export + category rules | month summary JSON + needs-review CSV | recomputes totals from the CSV and rules; 2 uncategorized rows must be listed, not summed |
| D2 social posts | brand sheet + product list | 3 posts, one per platform | platform set, exact product names, banned words, length, ≥3 Instagram hashtags, closing link |
| D3 customer intake | 6 inbox messages + open slots | triage JSON + reply per non-spam message | type per message, a fitting slot per booking (no double booking), first name and slot date/time in the reply |
| D4 payment reminders | invoices + today's date + rules | one reminder per overdue unpaid invoice + index | only overdue unpaid invoices, exact amount / due date / "n days overdue" / link, index sorted most overdue first |

The checker runs in the run directory (`node ../../checks/<task>/check.mjs`)
and prints `<task> PASS` or `<task> FAIL` with one line per thing wrong. The
checkers are mechanical: D2 does not judge whether a post is good, only
whether it keeps the rules. Every business task is labelled
`provenance: 'inferred'` — the pass conditions were written from what the
owner's teams are seen doing, not confirmed with a real bookkeeper, marketer
or receptionist. A task becomes `interviewed` once an owner of that kind of
business has agreed the bar is the one they would apply.

Scoring note: D2 code quality (tsc/lint) does not apply to business tasks;
they get the dimension's baseline, so their overall score is driven by the
checker (D1), steps, autonomy and cost.

`npm test` copies each fixture to a temp directory and runs the checker twice:
it must fail on the bare fixture and pass with `solutions/<task>/` copied in.

## Re-run after a model change and diff

One command re-runs the set and compares it with the last recorded baseline:

```bash
cd eval && npm run build
node dist/cli.js run --all --runtime claude-code --diff     # or: npm run eval:diff
node dist/cli.js diff --runtime claude-code                 # diff saved results only
node dist/cli.js diff --out results/diff.md                 # every runtime present, saved
```

The diff pairs the newest result per task × runtime in `results/` with the
newest `baselines/<date>/` (or `--baseline <dir>`). Its first line states how
many tasks were compared; a task present on one side only is listed as
"not re-run" or "new" and never counted as compared. Per task it shows checks
passed, score, completion, time and cost, base → now, with a verdict:

- **regressed**: fewer verification checks pass, a completed task now times
  out or errors, or the score drops by more than 5 points;
- **improved**: the opposite;
- **unchanged**: everything else (a score move within ±5 is noise).

`diff` and `run --diff` exit 1 when any compared task regressed, so a model
change can be gated on it. The same report is the one #874 (recalibrate review
after a model change) reads.

## Recording a baseline

A baseline is a run worth comparing future models against. To record one:

1. Run the full set for each runtime you care about.
2. `node dist/cli.js record --date YYYY-MM-DD` copies the newest result per
   task into `baselines/<YYYY-MM-DD>/<runtime>/` (plus the latest report) and
   rewrites absolute `logPath`s relative to `eval/`.
3. Write or update `baselines/<YYYY-MM-DD>/comparison-report.md` with the model
   names and CLI versions used (the runner does not know them).

The report must say how many tasks ran. "All pass" with no count is not a result.

## Unit tests

```bash
cd eval && npm test
```

Covers the scorer, the baseline diff (including a self-diff of the
checked-in 2026-04-01 baseline: 12 results, all unchanged) and the task
registry (fixtures exist; each business checker rejects the bare fixture and
accepts its reference solution). Executors are only exercised by a real run.

## Still to do (#888)

- Re-run the 3 tasks on today's models and record a 2026-10 baseline
  (`run --all --diff`, then `record --date`).
- Confirm the business tasks' pass conditions with owners (move them from
  `inferred` to `interviewed`); add the `crewly-agent` runtime's file-only
  mode if a run shows the agent insists on a git repo.
- A standing "not yet" set: tasks current models fail, re-run on every model change.
