# Per-WorkItem git worktrees (#814)

Status: implemented, **opt-in per project in v1**. The default flips to on in a follow-up,
once creation cost has been measured with serialization in place.

## Problem

Agents edited repos directly in the shared checkout. Parallel WorkItems on the same repo
could collide, half-finished changes leaked into other agents' context, and there was no
clean unit of work to review or throw away.

## Behaviour

When a WorkItem for an opted-in project is queued with a target, or claimed, its worktree
is created:

```
git worktree add <repo>/.crewly/worktrees/<workItemId> -b wi/<workItemId> <base>
```

- **Base.** `origin/HEAD` (for example `origin/main`) when known, else the repo's `HEAD`.
  The base name and commit are recorded.
- **Copied files.** Files listed in the repo-root `.worktreeinclude` are copied in. These
  are gitignored-but-needed files such as `.env`. Only literal repo-relative paths are
  allowed: globs, absolute paths and `..`/`.git` segments are refused, and at most 50
  entries are honoured.
- **Shared directories.** Heavy directories are **symlinked**, not copied (default
  `node_modules`; override per project with `Project.worktreeSharedDirs`). This happens
  only when the directory exists in the repo, git tracks nothing under it, and it is not
  already in the worktree. A repo that commits `node_modules` (for example
  crewly-services) gets the real checkout.
- **Never committable.** Every symlink and copy, plus `.crewly/worktrees` itself, is added
  to the repo's shared `.git/info/exclude` as a rooted pattern (`/node_modules`, with no
  trailing slash, so a symlink matches too). None of them can be committed from a
  worktree or show up in the main checkout, even in a repo whose `.gitignore` does not
  cover them.
- **Records.** A manifest is written to `.crewly/worktrees/.meta/<id>.json`, and the same
  record goes on `WorkItem.metadata.worktree`: path, workdir, branch, base, symlinks,
  copies and state.
- **Telling the agent.** The agent receives a `[CREWLY-WORKTREE]` message with the
  **workdir**: the worktree root, or the project subdirectory inside it. The agent's
  terminal session is **not** restarted in v1, so the agent keeps its context and is told
  where to work.

**Serialization.** At most one worktree create or remove runs per repo at a time, and the
rest queue. On the crewly repo (5,566 files) a checkout took 10 s at load 13 and 135 s
under heavier load. Five WorkItems queued together run five checkouts one after another,
never in parallel.

## Lifecycle hooks: observe only

`WorkItemWorktreeSubscriber` listens to events published by `TaskPoolService` on any path
that makes a transition (reconciler, HTTP, auto-claim). It **writes no status**, adds no
transition edge and makes no actor-gated call, so it is independent of the
transition-permission table (#813) and of the coordinator.

| Signal | Action |
|---|---|
| `workitem:queued` with a target | pre-create the worktree (in the background) |
| `TaskPoolService.onClaimed` (new) | create it if missing (untargeted pool items) |
| `task:done_by_worker`, `task:done` | "worked outside its worktree" detector (report only) |
| `task:done`, `task:verified`, `task:cancelled` | cleanup |
| every 30 min | orphan sweep |
| `task:rejected` | nothing: the work comes back for rework |

The PR adds two small things to `TaskPoolService`:
- `onClaimed(listener)`, fired fire-and-forget after both claim paths. There was no claim
  event.
- `patchMetadata(id, key, value)`, which changes metadata only and never the status.

## Cleanup rules (destructive-operation guards)

A worktree is removed **only** when all of these hold:

1. **Dirty check = `clean`.**
   - The path must be the worktree *root*. Checked with `rev-parse --show-toplevel`, so
     git never answers for a parent repo.
   - At least one tracked file must be examined: 0 is `unknown`.
   - `git status --porcelain -z --untracked-files=all` must succeed and, after excluding
     **exactly** the symlinks and copies recorded at creation, must be empty. No patterns
     are used.
   - A recorded symlink that has been replaced by real content counts as dirty.
   - Paths hidden by the **shared** `info/exclude`, which another worktree may have
     registered (for example `/node_modules` or `/.env`), are listed too, with
     `--ignored=matching`. One that this worktree did not record counts as dirty. Plain
     `git status` would never show it. There is no name-based exclusion anywhere (#829
     review).
   - It reports `N path(s) examined, M excluded as our symlinks/copies, K dirty`.
   - `unknown` → keep.
2. **Landed = `landed`**, required for done, verified and missing WorkItems. It holds when
   the worktree HEAD is an ancestor of its upstream or of the recorded base
   (`merge-base --is-ancestor`), **or** HEAD is the tip of some ref on `origin`
   (`ls-remote`, with a 15 s timeout and no credential prompt). Offline and not merged
   locally gives `unknown` → keep. Cancelled and failed WorkItems need only clean,
   because the branch `wi/<id>` is **never deleted**, so committed work survives.
3. `git worktree remove` **without `--force`**. Git's own refusal on a dirty tree is a
   second line of defence. Our symlinks and copies are unlinked first, never followed.

The verdict is written to the record (`state: removed | kept`, `lastCheck`). A later claim
of the same WorkItem, for example after a requeue, re-adds the worktree on the kept
branch.

## Detector: worked outside its worktree

At `task:done_by_worker` / `task:done`, the detector checks two things: whether the branch
has 0 commits beyond its base, and whether the shared checkout has files changed since the
worktree was created (by mtime, excluding `.crewly/`). When both are true, it adds a
warning note to the WorkItem. It is report-only and never blocks.

## Orphan sweep

The sweep runs every 30 minutes over every registered project's repo that has a
`.crewly/worktrees` directory:

- Listed entries are matched against `git worktree list --porcelain`. **If entries are
  listed but none match, the repo is refused** (the parse failed), and nothing is acted
  on over an empty examination.
- **No manifest** → keep (ownership unknown).
- **WorkItem active** → keep.
- **WorkItem done / verified / cancelled / failed, or missing** → the cleanup rules above.
  Pre-created worktrees whose WorkItem was never claimed are covered here.
- **Dirty leftovers** are kept and reported once, as a note on the WorkItem.
- It then runs `git worktree prune`.
- Each repo logs `listed / examined / removed / keptDirty / keptNotLanded / keptUnknown /
  active / unregistered`.

## Opt-in and opt-out

| Knob | Effect |
|---|---|
| `Project.worktrees: 'on'` (projects.json) | opts the project in; absent or `'off'` means no worktrees (**v1 default**) |
| `Team.worktrees: 'off'` | the team's WorkItems never get worktrees, even on an opted-in project |
| `CREWLY_WORKTREES=off` | kill switch, everywhere |

A project that is not in a git repo is skipped. A WorkItem's project is taken from
`metadata.projectPath` when that path names a registered project, else from the first
project of the target member's team.

**Effect on the main checkout.** `.git/info/exclude` is shared by the clone, so the rooted
patterns this feature writes also apply in the user's main checkout. For example, an
untracked `/node_modules` or `/.env` there becomes ignored. Tracked files are never
affected. This happens only on opted-in projects. The patterns sit under a marker line
and are **not removed** when the last worktree goes: they are harmless for gitignored
paths, and removing them while another worktree still relies on them would expose its
symlinks to `git add -A`. Delete the marker block by hand to undo it.

## Out of scope in v1

- Restarting the agent's terminal session inside the worktree.
- Auto-PR or auto-merge on `verified`. Agents open PRs themselves.
- Default on.
