# Worktree janitor

Status: implemented. Code: `backend/src/services/worktree/worktree-janitor.service.ts`.

## Problem

Agents create a git worktree per code task (Claude Code subagents under
`<repo>/.claude/worktrees/<name>`, the developer role under
`/tmp/crewly-worktrees/<session>-<slug>`) and never delete it. One Mac collected
30+ worktrees, tens of GB. Owner decision: once the PR is merged, the worktree is
removed automatically.

## Schedule

Started at boot. The first pass runs 10 minutes after start, then every 30 minutes.
Kill switch: `CREWLY_WORKTREE_JANITOR=0` (also `off`, `false`, `no`). It stops the
timer and the manual trigger. The dry-run listing still works.

## Repos

The janitor scans every registered project path that is inside a git repo, plus the
running Crewly package root when it is a dev checkout. Repos are de-duplicated by
their main worktree, and each is read with `git worktree list --porcelain`.

## Removal rules

A worktree is removed only when **all** of these hold:

| # | Rule | Kept reason |
|---|---|---|
| 1 | Not the main worktree, not bare, and its directory exists. A missing directory is left to `git worktree prune`. | `main-worktree`, `bare`, `prunable` |
| 2 | Not locked. Claude Code locks the worktree of a running subagent. | `locked` |
| 3 | Not under `<repo>/.crewly/worktrees/`, which the per-WorkItem worktree feature (#814) owns and cleans. | `managed-by-workitem-worktrees` |
| 4 | It is an agent worktree: the path is under `<main>/.claude/worktrees/` or `<tmp>/crewly-worktrees/`, **or** the branch starts with `worktree-agent-`. | `not-agent-worktree` |
| 5 | No Crewly agent session was started inside it, and no process of this user has its cwd inside it. If the probe fails, the worktree is kept. | `agent-session-inside`, `process-inside`, `cwd-probe-failed` |
| 6 | Last touched more than 2 hours ago. This is the newest mtime of the directory and of its git dir's `index`, `HEAD` and `logs/HEAD`. | `recent` |
| 7 | `git status --porcelain --untracked-files=all` is empty. Ignored files do not count. | `dirty`, `status-failed` |
| 8 | HEAD is an ancestor of `origin/<default>` after a quiet fetch, **or** `gh` (installed and authenticated) shows a MERGED PR for the branch whose head commit equals HEAD, which covers squash merges. | `not-merged` |

Rule 4 is deliberately narrow. Human worktrees such as `../crewly-wt-805` on
`fix/...` are never touched. A false "keep" costs disk space; a false "remove"
costs work.

## Removal

The janitor runs `git worktree remove` without `--force`. If git refuses while the
status is still clean (only ignored output is left) and there are no submodules, it
retries once with `--force`. It then deletes the local branch with `-D`, but only
when the branch still points at the verified HEAD and is not `main`, `master`,
`develop` or the default branch. `git worktree prune` runs once per repo.

Each pass logs one line:
`Worktree janitor: removed N, kept M (reason: count, ...)`. A pass never throws.

## API

These routes are under `/api`, with the same API-token middleware as every other route.

- `GET /api/worktree-janitor/worktrees`: dry run. It returns the verdict and reason
  for every worktree, plus `disabled` and `lastRun`. It removes nothing, but may run
  `git fetch`.
- `POST /api/worktree-janitor/run`: runs one pass now. Returns 409 when the kill
  switch is on.

## Known limits

- Ignored files inside a removed worktree are deleted with it, for example a copied
  `.env` or gitignored `.crewly/` notes.
- A symlinked `node_modules` counts as untracked unless an ignore rule matches the
  symlink. `node_modules/` with a trailing slash matches only directories;
  `node_modules` or `/node_modules` matches the symlink too. Such worktrees are kept
  as `dirty`.
