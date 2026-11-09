---
name: Record Local Gate
description: Run a private repo's gate on a PR's exact head in a fresh clone and record the result, so a content-only PR can merge when GitHub Actions cannot run.
version: 1.0.0
category: development
skillType: claude-skill
assignableRoles:
  - developer
  - fullstack-dev
  - backend-developer
  - frontend-developer
  - generalist
triggers:
  - record local gate
  - local green build
  - ci cannot run
  - merge content pr without ci
tags:
  - merge
  - ci
  - guard
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 1800000
---

# Record Local Gate

Some private repos cannot run GitHub Actions (billing is off). `destructive-git-guard` blocks `gh pr merge` unless CI is green, so their PRs could never merge. For a repo listed in `config/hooks/destructive-git-guard/local-gates.json`, the guard accepts a recorded local run instead, for **content-only** PRs.

## Use

```bash
bash config/skills/agent/core/record-local-gate/execute.sh --repo stevehuang0115/crewly-web --pr 285
```

It reads the PR head SHA with `gh`, checks that exact SHA out in a fresh temporary clone (never your working tree), runs the repo's gate commands with a scrubbed environment, and writes `$CREWLY_HOME/local-gates/<owner>__<repo>/pr-<N>-<sha>.json` (sha, baseRef, baseSha, command, exitCode, start and finish times, last 40 log lines, recordedBy). It prints what it ran and the exit code, and exits non-zero when the gate fails (the failing record is still written). There is no `--exit-code` flag: a record is never handed in.

Then `gh pr merge` goes through the guard. The guard accepts only when ALL hold: the repo has an entry; every changed file (and renamed-from path) matches the entry's `contentPaths`; a record exists for exactly the PR head with exit 0; the record's base head is still the base head (or the PR is not behind); no check actually ran and failed. Push a new commit and the record no longer matches: run this again.

## Limits

The record is a file on disk. It is a speed bump, like the guard itself, not a boundary: someone who can write files can forge it. It does not replace review, and code PRs get no such path.
