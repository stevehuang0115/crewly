---
id: dev-testing-requirements
version: 1
createdAt: 2026-01-29T00:00:00Z
updatedAt: 2026-01-29T00:00:00Z
createdBy: system
role: developer
category: testing
priority: 9
title: Testing Requirements
description: Testing standards and requirements for all code
triggers:
  - test
  - testing
  - jest
  - unit
  - coverage
tags:
  - testing
  - quality
  - coverage
# Rule metadata (#877): what this rule prevents, where seen, when to re-test
prevents: "none recorded — part of the original default SOP library (2026-01-29); re-test before keeping"
seenOn: "unknown"
reviewBy: 2026-12-31
source: https://github.com/stevehuang0115/crewly/commit/77d504515
---

# Testing Requirements

## What to Test

1. **All public functions** - Every exported function needs tests
2. **Edge cases** - Empty inputs, null values, boundaries
3. **Error paths** - Verify errors are thrown correctly
4. **Integration points** - Test service interactions

## Test Structure

```typescript
describe('ComponentName', () => {
  describe('methodName', () => {
    it('should do X when given Y', () => {
      // Arrange
      const input = ...;

      // Act
      const result = methodName(input);

      // Assert
      expect(result).toBe(expected);
    });
  });
});
```

## Test Quality

- Descriptive test names
- One assertion per test (usually)
- No test interdependencies
- Clean up after tests

When a test fails and the cause is unclear, follow the `debugging` SOP (red-capable loop first).

## Anti-patterns

Coverage percentage rewards all three. Avoid them.

- **Tautological**: the assertion recomputes the expected value the way the code does (`expect(add(a, b)).toBe(a + b)`). Tell: it can never disagree with the code. Take expected values from a literal, a worked example or the spec. Prove a test is not tautological with the mutation check: break the code on purpose and see the test fail.
- **Implementation-coupled**: the test checks how (private calls, call order), not what. Tell: it breaks on a refactor that changes no behavior.
- **Horizontal slicing**: all tests first, then all code. Tell: many tests, none ever seen red. Work one test, one implementation, repeat. **Red before green**: see the new test fail before the fix.

## Seams

Test at agreed seams (public function, API route, CLI entry), not at every internal. For each seam write one line: what it catches and what it misses.

## Coverage Goals

- Minimum 80% for new code
- 100% for critical paths
