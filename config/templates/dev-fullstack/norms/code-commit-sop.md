# Code Commit SOP

**Trigger**: before_commit
**Applies to**: developer, team-leader
**Version**: 1.0.0

## Overview

Standard operating procedure for committing code changes. Ensures every commit passes quality gates and review before reaching the main branch.

## Steps

1. **Self-review diff** — Run `git diff --staged` and read every changed line. Verify no debug code, hardcoded secrets, or unintended changes are included.
2. **Run TypeScript check** — Execute `npm run build` or `npx tsc --noEmit` to confirm zero type errors in modified files.
3. **Run unit tests** — Execute `npm test` and confirm all tests pass. New code must have corresponding test files.
4. **Run lint** — Execute `npm run lint` to verify code style compliance.
5. **Check test coverage** — New features must have 80%+ coverage. Critical business logic requires 100%.
6. **Write commit message** — Use conventional commit format: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`. Message should explain *why*, not just *what*.
7. **Stage specific files** — Use `git add <file>` for each file. Never use `git add -A` or `git add .` to avoid accidentally staging secrets or large binaries.
8. **Create commit** — Commit with the prepared message. Include `Co-Authored-By` if pair programming.
9. **Post-commit verify** — Run `git log -1 --stat` to confirm the commit contains only intended files.

## Checklist

- [ ] No `console.log` or debug statements in production code
- [ ] No hardcoded secrets, API keys, or credentials
- [ ] No commented-out code blocks
- [ ] All new functions have JSDoc documentation
- [ ] Every new source file has a corresponding test file in the same directory
- [ ] TypeScript compiles with zero errors
- [ ] All tests pass (unit + integration)
- [ ] Lint passes with no warnings
- [ ] Commit message follows conventional commit format
- [ ] Only intended files are staged

## Exceptions

- **Hotfix commits** may skip steps 5 (coverage check) if the fix is urgent and a follow-up commit will add tests within 24 hours.
- **Documentation-only commits** (*.md files) may skip steps 2-5.
- **Dependency updates** (`package.json` / `package-lock.json` only) may skip step 5 but must still pass build and tests.
