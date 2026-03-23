---
id: dev-git-workflow
version: 2
createdAt: 2026-01-29T00:00:00Z
updatedAt: 2026-03-23T00:00:00Z
createdBy: system
role: developer
category: git
priority: 10
title: Git Workflow
description: Standard git workflow for developers — includes branch lifecycle and merge requirements
triggers:
  - commit
  - push
  - branch
  - merge
  - git
tags:
  - git
  - workflow
  - version-control
---

# Git Workflow

## Branch Naming

- `feat/{ticket-id}-{description}` - New features
- `fix/{ticket-id}-{description}` - Bug fixes
- `refactor/{description}` - Code refactoring
- `test/{description}` - Adding tests

## Branch Lifecycle (MANDATORY)

### Creating Branches
1. Always branch from `main`
2. Keep branches short-lived (max 1-2 days)
3. One feature/fix per branch

### Merging Branches
1. **3-Round Review SOP** before merge:
   - Round 1: Self-review — `git diff main..branch`, check code quality, test coverage
   - Round 2: Fix issues found in Round 1, run tests
   - Round 3: Final verification — confirm all tests pass, no regressions
2. Merge to main: `git checkout main && git merge --no-ff branch`
3. Push main: `git push origin main`

### Branch Cleanup (CRITICAL — DO NOT SKIP)
1. **After merge**: Delete the branch immediately
   - Local: `git branch -d feat/my-feature`
   - Remote: `git push origin --delete feat/my-feature`
2. **After task completion**: Even if work was committed directly to main, delete any feature branches created
3. **Weekly audit**: Team lead checks for stale branches (> 7 days without activity)
   - Branches with 0 commits ahead of main: DELETE immediately (already merged)
   - Branches with unmerged commits: Review and either merge or discard with documented reason

### Branch Hygiene Rules
- Never leave branches unmerged for more than 3 days without a documented reason
- Never deploy from a feature branch — always merge to main first, then deploy from main
- If a branch has conflicts with main, rebase before requesting review
- After npm publish, verify no feature branches were accidentally left behind

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

## Before Pushing

1. Run `npm run typecheck`
2. Run `npm test`
3. Run `npm run lint`
4. Review your changes: `git diff`

## Before npm Publish

1. Verify all feature branches are merged or deleted
2. Run `git branch` — only `main` should remain (plus any active WIP branches with documented reason)
3. Run full test suite
4. Bump version: `npm version patch`
5. Publish: `npm publish`

## Deployment Checklist

1. After deploying Docker images, verify critical pages are accessible (e.g., cli-token, dashboard)
2. If using Cloudflare, purge cache after deployment
3. Check container health endpoint returns 200
4. Verify no regressions in OAuth flows or authentication
