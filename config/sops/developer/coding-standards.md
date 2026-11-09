---
id: dev-coding-standards
version: 1
createdAt: 2026-01-29T00:00:00Z
updatedAt: 2026-01-29T00:00:00Z
createdBy: system
role: developer
category: quality
priority: 10
title: Coding Standards
description: Standard coding practices for all developers
triggers:
  - code
  - implement
  - write
  - function
  - class
tags:
  - standards
  - quality
  - typescript
# Rule metadata (#877): what this rule prevents, where seen, when to re-test
prevents: "none recorded — part of the original default SOP library (2026-01-29); re-test before keeping"
seenOn: "unknown"
reviewBy: 2026-12-31
source: https://github.com/stevehuang0115/crewly/commit/77d504515
---

# Coding Standards

Follow these standards for all code changes.

## Code Style

1. **Use TypeScript** - All new code should be TypeScript
2. **Explicit types** - Define interfaces for all data structures
3. **No `any`** - Use `unknown` with type guards instead
4. **Meaningful names** - Variables and functions should be self-documenting

## File Organization

1. One component/service per file
2. Test files next to source files (`*.test.ts`)
3. Group related files in directories
4. Use barrel exports (`index.ts`)

## Functions

1. **Single responsibility** - One function, one purpose
2. **Small functions** - Aim for <30 lines
3. **Pure functions** - Minimize side effects
4. **Document complex logic** - Add comments for non-obvious code

## Error Handling

1. Always use try/catch for async operations
2. Log errors with context
3. Throw meaningful error messages
4. Don't swallow errors silently
