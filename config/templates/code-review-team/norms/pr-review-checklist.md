# PR Review Checklist

**Trigger**: before_merge
**Applies to**: architect, qa-engineer
**Version**: 1.0.0

## Overview

Standard checklist for reviewing pull requests before merge. Ensures code quality, architectural consistency, and adequate test coverage across all changes.

## Steps

1. **Read the PR description** — Understand the intent, linked issues, and scope of changes.
2. **Review file-by-file diff** — Walk through every changed file in logical order (types → services → controllers → tests).
3. **Check naming conventions** — Variables, functions, classes, and files follow project naming standards (camelCase for variables/functions, PascalCase for classes/types, kebab-case for files).
4. **Evaluate architecture** — Verify separation of concerns, single responsibility, and proper layering (controller → service → repository).
5. **Inspect error handling** — All async operations have try/catch, errors are logged with context, and user-facing errors are sanitized.
6. **Assess performance implications** — Look for N+1 queries, unnecessary re-renders, unindexed lookups, large payload sizes, and missing pagination.
7. **Validate API design** — RESTful conventions, consistent response shapes, proper HTTP status codes, and backward compatibility.
8. **Verify test coverage** — Every changed source file has a corresponding test file with meaningful assertions covering happy path, error cases, and edge cases.
9. **Check TypeScript strictness** — No `any` types, proper use of interfaces/enums, and strict null checks.
10. **Produce review verdict** — Approve, request changes, or block with clear, actionable feedback.

## Checklist

- [ ] PR description clearly states what and why
- [ ] No unrelated changes bundled in the PR
- [ ] Naming conventions are consistent with project standards
- [ ] No unused imports, dead code, or commented-out blocks
- [ ] Functions are under 40 lines; files are under 300 lines
- [ ] Error handling covers all async operations and external calls
- [ ] No hardcoded values (ports, URLs, timeouts, status strings)
- [ ] API endpoints follow RESTful conventions and return proper status codes
- [ ] No N+1 queries or unbounded loops over large datasets
- [ ] Every changed `.ts`/`.tsx` file has a corresponding `.test.ts`/`.test.tsx`
- [ ] Tests cover happy path, error path, and at least one edge case
- [ ] TypeScript compiles cleanly with no `any` types
- [ ] JSDoc comments on all public functions

## Exceptions

- **Hotfix PRs**: May skip architecture and performance review if tagged `hotfix/` and approved by team lead. Must still pass test coverage and TypeScript checks.
- **Documentation-only PRs**: Skip code quality and performance sections; verify formatting and accuracy only.
- **Dependency updates**: Focus on changelog review, breaking changes, and known vulnerability checks instead of code quality.
