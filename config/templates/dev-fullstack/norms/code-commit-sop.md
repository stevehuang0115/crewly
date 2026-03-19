# Code Commit Standard Operating Procedure

**Trigger**: before_commit
**Applies to**: developer, team-leader
**Version**: 1.0.0

## Overview

Every code commit to a feature branch must follow this 9-step process with 3 review
rounds. This ensures code quality, consistency, and maintainability. The process is
mandatory for all developers and team leaders on the dev-fullstack team.

## Steps

### Phase A: Preparation

1. **Create Feature Branch**
   - Branch from `main` using naming convention: `feat/`, `fix/`, `refactor/`, `chore/`
   - One branch = one feature or fix
   - Example: `git checkout -b feat/user-auth-flow`

2. **Write Unit Tests**
   - Place test files next to source files: `service.ts` → `service.test.ts`
   - Cover: core business logic, conditionals, data transforms, error paths, edge cases
   - Target: 80%+ coverage (100% for critical paths)
   - Run: `npx jest --no-coverage` — all must pass

3. **Create PR + Review Round 1 (Refactor & Consistency)**
   - Open PR from feature branch → main
   - Self-review focusing on:

   | Dimension | Check |
   |-----------|-------|
   | Reusability | Can similar logic be extracted into shared utils? |
   | Structure | Is any file too large or mixing responsibilities? |
   | Modularity | Are module boundaries clean? Dependencies reasonable? |
   | Consistency | Coding patterns consistent? (enums, naming, error handling) |
   | Standards | Does code follow CLAUDE.md conventions? |

   - Document findings as "Review Round 1 — Refactor & Consistency"

### Phase B: Iterative Refinement

4. **Apply Round 1 Changes**
   - Refactor only — no new features
   - Run tests to confirm passing
   - Commit: `refactor: apply review round 1 feedback`

5. **Review Round 2 (Efficiency & Reliability)**

   | Dimension | Check |
   |-----------|-------|
   | Efficiency | Unnecessary computation? Duplicate processing? N+1 queries? |
   | Null Safety | Are null/undefined checks sufficient? |
   | Error Handling | Errors caught and logged properly? |
   | Resource Cleanup | Timers, listeners, connections cleaned up? |
   | Logging | Critical operations have adequate logs? |

   - Document as "Review Round 2 — Efficiency & Reliability"

6. **Apply Round 2 Changes**
   - Implement efficiency and reliability improvements
   - Run tests
   - Commit: `chore: apply review round 2 feedback`

7. **Review Round 3 (Overall Quality)**

   | Dimension | Check |
   |-----------|-------|
   | Readability | Clear naming? Functions < 40 lines? |
   | Dead Code | Unused code, commented blocks, stale TODOs? |
   | Formatting | Consistent indentation, spacing, line length? |
   | Documentation | JSDoc complete? Complex logic commented? |
   | Types | TypeScript strict? No `any` types? |

   - Document as "Review Round 3 — Overall Quality"

8. **Apply Round 3 Changes**
   - Final polish
   - Run tests
   - Commit: `chore: apply review round 3 feedback`

### Phase C: Finalize

9. **Build, Verify, Merge**
   - `npm run build` — must pass
   - `npm test` — must pass
   - Update PR description with 3-round review summary
   - Squash merge to main
   - Delete feature branch

## Checklist

- [ ] Feature branch created with correct naming convention
- [ ] Unit tests written next to source files (1:1 ratio)
- [ ] All tests passing before PR creation
- [ ] Review Round 1 completed (Refactor & Consistency)
- [ ] Round 1 changes applied and committed
- [ ] Review Round 2 completed (Efficiency & Reliability)
- [ ] Round 2 changes applied and committed
- [ ] Review Round 3 completed (Overall Quality)
- [ ] Round 3 changes applied and committed
- [ ] Build passes (`npm run build`)
- [ ] Full test suite passes (`npm test`)
- [ ] PR description updated with review summaries
- [ ] Squash merged to main

## Exceptions

- **Hotfixes**: Critical production fixes may skip Rounds 2-3 but must still have
  Round 1 review and tests. Use `hotfix/` branch prefix.
- **Documentation-only changes**: Pure .md file changes can skip all review rounds.
- **Config/dependency updates**: Can skip Rounds 2-3 if change is mechanical
  (e.g., version bump). Still needs Round 1 review.
