---
id: dev-git-workflow
version: 2
createdAt: 2026-01-29T00:00:00Z
updatedAt: 2026-04-27T23:55:00Z
createdBy: system
updatedBy: sam-tl
role: developer
category: git
priority: 10
title: Git Workflow
description: Standard git workflow for developers — branch naming, commit messages, and worktree-based parallel work
triggers:
  - commit
  - push
  - branch
  - merge
  - git
  - worktree
tags:
  - git
  - workflow
  - version-control
  - worktree
---

# Git Workflow

## Branch Naming

- `feat/{ticket-id}-{description}` - New features
- `fix/{ticket-id}-{description}` - Bug fixes
- `refactor/{description}` - Code refactoring
- `test/{description}` - Adding tests

## Commit Messages

Use conventional commits:

```
{type}({scope}): {description}

{body - optional}

{footer - optional}
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`

## Commit Frequency

- Commit at least every 30 minutes
- Each commit should be atomic (one logical change)
- Don't commit broken code

## Worktree Pattern (REQUIRED for parallel branch work)

**When to use a worktree:** any time you start work on a branch other than the main repo's current branch, OR when another agent is also working on a parallel branch in the same repo.

**Why required:** working on a feature branch directly in the main repo (`/Users/.../crewly`) means stash / checkout operations across two parallel agents collide. Files modified by one agent appear in the other agent's `git diff`. This produces lost work, accidentally-mixed PRs, and recovery patches like `/tmp/sam-stash-recovery-with-max-inbound2.patch` (incident 2026-04-27 — Sam recovering Max's INBOUND-2 work that mixed into Sam's polish stash).

**Standard worktree flow** (Leo's pattern, model for the team):

```bash
# 1. Create a worktree for your branch from main (or another base)
git worktree add /tmp/crewly-{ticket-name}-{owner} main

# 2. cd into the worktree and create your feature branch
cd /tmp/crewly-{ticket-name}-{owner}
git checkout -b feat/{ticket-id}-{description}

# 3. Make edits, run tests, commit, push from the worktree
# (the main repo's working tree is untouched)

# 4. After PR merges, clean up the worktree
cd /Users/yellowsunhy/Desktop/projects/crewly-projects/crewly
git worktree remove /tmp/crewly-{ticket-name}-{owner}
```

**Notes:**
- `node_modules` is not installed in the worktree by default. For prompt/doc-only PRs that's fine. For backend code PRs that need `npm test` / `npm run build`, run those checks back in the main repo or `npm install` inside the worktree.
- `.crewly/` directory is gitignored — task spec markdown files written there in a worktree won't appear in the diff. Copy spec files to the main repo's `.crewly/tasks/...` if other agents need to read them.
- Do NOT use the main repo `crewly/` directory to develop a feature branch when another agent is also active in the team. The main repo is the orchestrator's coordination surface, not a per-agent dev sandbox.

**Solo work exception:** if you are the only developer active in the team and you're not parking work for parallel review, working directly in the main repo is acceptable. The worktree pattern is required only when there is a real risk of branch-state collision.

## Before Pushing

1. Run `npm run typecheck`
2. Run `npm test`
3. Run `npm run lint`
4. Review your changes: `git diff`
5. Confirm you're on the correct branch (`git branch --show-current`)
