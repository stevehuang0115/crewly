# Agent eval runner under version control (#888, slice 1)

**Status:** runner versioned at `eval/` with the 2026-04-01 baseline (this PR).
Re-run on current models, diff command, business tasks and "not yet" tasks are
later slices.

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
and CLI versions, because the runner does not record them. A future diff
command (slice 2) compares the newest `results/` JSON against the newest
`baselines/<date>/<runtime>/` JSON per task and prints pass/fail deltas, with
the task count in the header.

## Acceptance for this slice

- `cd eval && npm ci && npm run build && npm test` pass from a clean clone.
- Root `npm run build`, `npm run lint`, root typecheck and CI unchanged.
- The 2026-04-01 results are readable from the repo without the old folder.
