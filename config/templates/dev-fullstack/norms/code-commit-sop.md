# Code Commit SOP

**Trigger**: before_commit
**Applies to**: developer, team-leader
**Version**: 1.0.0

## Overview

9-step code commit process with 3 review rounds ensuring code quality, consistency, and maintainability. Every commit that introduces or modifies functionality MUST follow this process.

## Steps

### Step 1: Create Feature Branch

```bash
git checkout -b feat/{descriptive-name}
```

- Branch from the current working branch
- Naming convention: `feat/`, `fix/`, `refactor/`, `chore/`
- One branch per feature or fix

### Step 2: Write Unit Tests

- Place test files next to source files (`*.test.ts` beside `*.ts`)
- Cover:
  - Core business logic
  - Non-trivial conditionals
  - Data transformations
  - Error paths
  - Edge cases
- Target coverage: 80%+ (100% for critical paths)
- Run: `npx jest --no-coverage` — all must pass

### Step 3: Create PR + Review Round 1 (Refactor & Consistency)

Open a PR from the feature branch to main. Round 1 focuses on:

| Dimension | Checkpoint |
|-----------|------------|
| **Reusability** | Can similar logic be extracted into shared utils/functions/components? |
| **Structure** | Is any file too large? Does it mix multiple responsibilities? |
| **Modularity** | Are module boundaries clear? Are dependencies reasonable? |
| **Consistency** | Are coding patterns consistent? (enums, naming, error handling) |
| **Standards** | Does the code follow CLAUDE.md coding conventions? |

Output: "Review Round 1 — Refactor & Consistency" document listing action items.

### Step 4: Execute Round 1 Changes

- Refactor per Round 1 suggestions
- No new features — pure refactoring only
- Run tests to confirm they pass
- Commit: `refactor: apply review round 1 feedback`

### Step 5: Review Round 2 (Efficiency & Reliability)

| Dimension | Checkpoint |
|-----------|------------|
| **Efficiency** | Any unnecessary computation? Repeated processing? N+1 queries? |
| **Null Safety** | Are null/undefined checks sufficient? |
| **Error Handling** | Are errors properly caught and logged? |
| **Resource Cleanup** | Are timers, listeners, and connections properly cleaned up? |
| **Logging** | Do critical operations have adequate logging? |

Output: "Review Round 2 — Efficiency & Reliability" document.

### Step 6: Execute Round 2 Changes

- Implement efficiency and reliability improvements
- Run tests to confirm they pass
- Commit: `chore: apply review round 2 feedback`

### Step 7: Review Round 3 (Overall Quality)

| Dimension | Checkpoint |
|-----------|------------|
| **Readability** | Are names clear? Are functions reasonably short (< 40 lines)? |
| **Dead Code** | Any unused code, commented-out code, or irrelevant TODOs? |
| **Formatting** | Are indentation, spacing, and line length consistent? |
| **Documentation** | Are JSDoc comments complete? Is complex logic commented? |
| **Types** | Are TypeScript types strict? Any `any` types? |

Output: "Review Round 3 — Overall Quality" document.

### Step 8: Execute Round 3 Changes

- Apply final polish
- Run tests to confirm they pass
- Commit: `chore: apply review round 3 feedback`

### Step 9: Finalize & Merge

```bash
# 1. Ensure build passes
npm run build

# 2. Ensure tests pass
npm test

# 3. Update PR description summarizing all 3 review rounds
gh pr edit --body "..."

# 4. Merge
gh pr merge --squash

# 5. (Optional) Delete feature branch
git branch -d feat/{name}
```

## Checklist

- [ ] Feature branch created with correct naming convention
- [ ] Unit tests written and placed next to source files
- [ ] Test coverage >= 80%
- [ ] PR created from feature branch to main
- [ ] Review Round 1 (Refactor & Consistency) completed
- [ ] Round 1 changes committed: `refactor: apply review round 1 feedback`
- [ ] Review Round 2 (Efficiency & Reliability) completed
- [ ] Round 2 changes committed: `chore: apply review round 2 feedback`
- [ ] Review Round 3 (Overall Quality) completed
- [ ] Round 3 changes committed: `chore: apply review round 3 feedback`
- [ ] Build passes (`npm run build`)
- [ ] All tests pass (`npm test`)
- [ ] PR description updated with review summary
- [ ] PR merged

## Exceptions

- **Hotfixes**: Critical production bugs may skip Review Rounds 2 and 3, but Round 1 is mandatory. Tag the commit with `hotfix:` prefix.
- **Documentation-only changes**: Pure documentation updates (README, comments, specs) may skip all review rounds but must still create a PR.
- **Config changes**: Environment variable or configuration-only changes may use a single review round.
