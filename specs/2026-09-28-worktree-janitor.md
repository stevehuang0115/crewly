# Worktree janitor (disk janitor)

Status: implemented. Code: `backend/src/services/worktree/worktree-janitor.service.ts`,
`scratch-janitor.ts` (stale scratch sweep), `low-disk-guard.ts` (free-space checks
and the owner notice).

## Problem

Agents create a git worktree per code task (Claude Code subagents under
`<repo>/.claude/worktrees/<name>`, the developer role under
`/tmp/crewly-worktrees/<session>-<slug>`) and never delete it. One Mac collected
30+ worktrees, tens of GB. Owner decision: once the PR is merged, the worktree is
removed automatically.

2026-09-29: the owner's Mac hit ENOSPC anyway. The janitor kept 13 finished
worktrees as `not-agent-worktree` because agents also create worktrees at arbitrary
paths (`/private/tmp/claude-501/visa-cm-wt` in ce-core, `../crewly-wt-805`), each
with its own node_modules (~2 GB). It also never saw full clones and test homes in
Claude Code's per-session temp dirs (`/private/tmp/claude-<uid>/<slug>/<uuid>/`),
0.5–1.8 GB each, dozens of GB in total. The location rule was dropped, a scratch
sweep and a low-disk guard were added.

## Schedule

Started at boot. The first pass runs 10 minutes after start, then every 30 minutes.
Kill switch: `CREWLY_WORKTREE_JANITOR=0` (also `off`, `false`, `no`). It stops the
timer and the manual trigger. The dry-run listing still works.

## Repos

The janitor scans every registered project path that is inside a git repo, plus the
running Crewly package root when it is a dev checkout, plus every repo that owns a
linked worktree found under the temp roots (`/tmp`, `os.tmpdir()`, and the Claude
scratch roots below; searched 4 levels deep, `node_modules` skipped, at most 20,000
directories per root). A worktree's `.git` file (`gitdir: <main>/.git/worktrees/<name>`)
names its repo, so a repo that is not a registered project, such as ce-core, is
still found. Repos are de-duplicated by their main worktree, and each is read with
`git worktree list --porcelain`.

## Removal rules

A worktree is removed only when **all** of these hold:

| # | Rule | Kept reason |
|---|---|---|
| 1 | A linked worktree of a known repo — any path, any branch. Not the main worktree, not bare, and its directory exists. A missing directory is left to `git worktree prune`. | `main-worktree`, `bare`, `prunable` |
| 2 | Not locked. Claude Code locks the worktree of a running subagent. | `locked` |
| 3 | Not under `<repo>/.crewly/worktrees/`, which the per-WorkItem worktree feature (#814) owns and cleans. | `managed-by-workitem-worktrees` |
| 4 | No Crewly agent session was started inside it, and no process of this user has its cwd inside it. If the probe fails, the worktree is kept. | `agent-session-inside`, `process-inside`, `cwd-probe-failed` |
| 5 | Idle: last touched more than **2 hours** ago in a known agent location (`<main>/.claude/worktrees/`, `<tmp>/crewly-worktrees/`, or a `worktree-agent-*` branch), more than **24 hours** ago anywhere else. "Touched" is the newest mtime of the directory and of its git dir's `index`, `HEAD` and `logs/HEAD`. | `recent` |
| 6 | `git status --porcelain --untracked-files=all` is empty. Ignored files do not count. | `dirty`, `status-failed` |
| 7 | HEAD is an ancestor of `origin/<default>` after a quiet fetch, **or** `gh` (installed and authenticated) shows a MERGED PR for the branch whose head commit equals HEAD, which covers squash merges. A repo with no origin (e.g. not on GitHub) has neither, so its worktrees stay. | `not-merged` |

Until 2026-09-29 a fourth rule required an agent location or branch
(`not-agent-worktree`); it is retired. Location now only picks the idle threshold.
Safety comes from rules 2–7: a worktree whose work is not committed, not landed,
or in use is never removed. A false "keep" costs disk space; a false "remove"
costs work.

All janitor git calls run with `GIT_OPTIONAL_LOCKS=0`, so a status never rewrites
the index (which would reset the idle clock and contend with agents' git).

## Removal

The janitor runs `git worktree remove` without `--force`. If git refuses while the
status is still clean (only ignored output is left) and there are no submodules, it
retries once with `--force`. It then deletes the local branch with `-D`, but only
when the branch still points at the verified HEAD and is not `main`, `master`,
`develop` or the default branch. `git worktree prune` runs once per repo.

Each pass logs one line:
`Worktree janitor: removed N, kept M (reason: count, ...)`. A pass never throws.

## Scratch sweep

After the worktrees, the janitor sweeps Claude Code's per-session temp dirs.

Roots: `<os.tmpdir()>/claude-<uid>`, `/private/tmp/claude-<uid>` and
`/tmp/claude-<uid>`, de-duplicated by real path. The unit is a session dir
`<root>/<project-slug>/<uuid>/`. Nothing else under the root is touched (loose files,
worktrees like `<root>/visa-cm-wt`, non-UUID dirs). Symlinked slug or session dirs
are skipped; symlinks are never followed.

A session dir is deleted (`rm -rf`) only when **all** of these hold:

| # | Rule | Kept reason |
|---|---|---|
| 1 | Idle for more than **3 days**: the newest mtime of the dir and everything in its top two levels, and of every git repo's `HEAD`, `index`, `logs/` inside it. | `recent` |
| 2 | No process of this user and no Crewly session has its cwd inside. If the probe fails, everything is kept. | `process-inside`, `agent-session-inside`, `cwd-probe-failed` |
| 3 | It holds no linked worktree of a repo outside it. Those belong to the worktree rules (`git worktree remove`), which run first; once removed there, the session dir can go on a later pass. | `contains-worktree` |
| 4 | Every git repo inside (a dir with a `.git` dir or file, searched 3 levels deep, `node_modules` skipped, not descending into repos) is clean: `git status --porcelain --untracked-files=all` is empty. Untracked files count; ignored ones do not. | `dirty` |
| 5 | Every repo has a remote. A repo with no remote may be the only copy of its history. | `no-remote` |
| 6 | No commit is missing from the remotes: `git rev-list HEAD --branches --not --remotes` is empty (detached HEAD included), and there is no stash. | `unpushed`, `stash` |
| 7 | No repo inside has a linked worktree outside the session dir (deleting the clone would orphan it). | `has-external-worktrees` |

Any git error keeps the dir (`git-failed`). A session dir with no repo at all (test
homes, notes) is removed on rules 1–2 alone. Size is measured with `du -sk` before
deleting. Each pass logs one line:
`Scratch janitor: removed N session dir(s), freed X GB, kept M (reason: count, ...)`.

Remote-tracking refs are not fetched first. A stale ref can only make a commit
look unpushed (kept), never the reverse — except when a remote branch was deleted
upstream after the clone fetched it, which is accepted.

## Low-disk guard

Every 10 minutes the janitor reads the free space (`fs.statfs`, blocks available to
the user) of the volume holding `CREWLY_HOME`.

- **Below 15 GB**: a pass runs at once (unless one ran in the last 30 minutes).
  Every pass that starts while free space is below 15 GB uses halved idle thresholds,
  never below 2 hours: worktrees 2 h / 12 h, scratch 36 h.
- **Still below 15 GB after the pass**: the owner gets a Slack notice through the
  usual owner-notification path (`SlackService.sendNotification`, the owner DM), at
  most once per 24 hours. It says how much is free, what was freed, and the 5 biggest
  items the janitor left, with path, size and the reason in plain words ("has
  commits that were never pushed").
- **Below 5 GB**: the notice is marked urgent (critical urgency, "URGENT" title) and
  may repeat every 6 hours.

A notice that could not be delivered (Slack not connected) is not recorded, so the
next check retries. When the owner was last told is kept in
`<CREWLY_HOME>/disk-janitor-state.json` (and in memory, when a full disk refuses the
write). The kill switch `CREWLY_WORKTREE_JANITOR=0` also stops the guard.

All thresholds are in `WORKTREE_JANITOR_CONSTANTS` (`backend/src/constants.ts`).

## API

These routes are under `/api`, with the same API-token middleware as every other route.

- `GET /api/worktree-janitor/worktrees`: dry run. It returns the verdict and reason
  for every worktree, the scratch sweep plan (`scratch`: per session dir verdict),
  `lowDisk` / `freeBytes` as seen by the pass, the current free space
  (`disk: { path, freeBytes, level }`), plus `disabled` and `lastRun`. It removes
  nothing, but may run `git fetch`.
- `POST /api/worktree-janitor/run`: runs one pass now. Returns 409 when the kill
  switch is on.

## Known limits

- Ignored files inside a removed worktree or session dir are deleted with it, for
  example a copied `.env` or gitignored `.crewly/` notes.
- A Claude Code session that is still open but has not touched its scratch dir
  for 3 days (36 h in low-disk mode) can lose its scratch clone if that clone is
  clean and fully pushed. Claude Code's own process runs in the project dir, not
  the scratch dir, so the cwd probe does not protect it.
- A symlinked `node_modules` counts as untracked unless an ignore rule matches the
  symlink. `node_modules/` with a trailing slash matches only directories;
  `node_modules` or `/node_modules` matches the symlink too. Such worktrees are kept
  as `dirty`.
