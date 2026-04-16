# V3 Reconciler — Comprehensive Test Plan

**Author:** Quinn (Test Lead)
**Date:** 2026-04-08
**Status:** Final

---

## 1. Overview

The Reconciler is the "CPU" of Crewly V3 — it periodically recomputes system truth from durable state using a two-level loop (fast=10s, full=60s). This plan covers gaps identified after reviewing the existing ~3,300 lines of tests across three test files.

### Existing Coverage Summary

| File | Lines | Coverage |
|------|-------|----------|
| `reconcile-rules.test.ts` | ~1,620 | All 13 exported functions tested with basic, comprehensive, and gap coverage |
| `reconciler.service.test.ts` | ~1,250 | Lifecycle, runFull, runFast, reconcileRequest, getStatus, getHistory, updateConfig, corrections, concurrency, Hybrid Wake, performance |
| `reconciler-data-provider.test.ts` | ~481 | All LiveReconcilerDataProvider methods |

### Test Strategy

**Do not duplicate existing tests.** Focus on:
1. True edge cases not yet covered
2. Multi-cycle stateful integration tests
3. Cross-rule interaction tests
4. Boundary conditions in scoring algorithms

---

## 2. Identified Coverage Gaps

### 2.1 Unit Tests — detectStuckWorkItems (reconcile-rules)

| ID | Test Case | Gap Reason |
|----|-----------|------------|
| SW-1 | WorkItem with `maxRetries=0` — should immediately go to `failed` | Edge case: zero retry budget never tested |
| SW-2 | WorkItem with `retryCount > maxRetries` (data corruption) — should go to `failed` | Defensive coding edge case |
| SW-3 | Large batch (100+ items) performance — should complete in <50ms | Scale test missing |

### 2.2 Unit Tests — detectExpiredClaims (reconcile-rules)

| ID | Test Case | Gap Reason |
|----|-----------|------------|
| EC-1 | Claim with `leaseExpiresAt` as invalid date string | Defensive: malformed data |
| EC-2 | Very large batch of claims (50+) — all mixed states | Scale boundary |
| EC-3 | Claim in `expiring` state but lease is still in the future (race) | Possible race condition state |

### 2.3 Integration Tests — Multi-Cycle Reconciler Loop

| ID | Test Case | Gap Reason |
|----|-----------|------------|
| MC-1 | State evolution across 3 cycles: stuck → blocked → recovered | No existing test simulates state changing between passes |
| MC-2 | Full loop followed by targeted reconcileRequest — verify no double-correction | Cross-type interaction |
| MC-3 | Fast loop detects expiring claim, next fast loop detects revocation | Two-phase claim lifecycle |
| MC-4 | Timer-based interleaved fast+full loops with realistic data | Timer integration gap |

### 2.4 Edge Cases — Concurrent Claim Conflicts

| ID | Test Case | Gap Reason |
|----|-----------|------------|
| CC-1 | Two agents claim same WorkItem — both claims active, one should be flagged | Not tested at rules level |
| CC-2 | Claim revoked during full loop's `applyCorrections` — should handle gracefully | Partial test exists, needs deeper variant |
| CC-3 | WorkItem released back to pool immediately reclaimed before next reconcile | Fast reclaim scenario |

### 2.5 Recoverable WorkItems (reconcile-rules)

| ID | Test Case | Gap Reason |
|----|-----------|------------|
| RW-1 | WorkItem blocked with `retryCount = maxRetries - 1` — last retry attempt | Boundary of retry budget |
| RW-2 | Multiple blocked WorkItems targeting different agents (mixed health) | Cross-agent batch recovery |
| RW-3 | Blocked WorkItem with agent that went inactive → started → active between cycles | Status transition journey |

### 2.6 Pruning Pass

| ID | Test Case | Gap Reason |
|----|-----------|------------|
| PP-1 | Item simultaneously TTL-expired AND an orphan — verify no double-cancel | Overlap dedup |
| PP-2 | 3-level deep cascade: root cancelled → child → grandchild → great-grandchild | Deeper hierarchy than tested |
| PP-3 | Stale queued item that's also TTL-expired — counted in both categories | Counter accuracy |
| PP-4 | Custom TTL and stale thresholds passed simultaneously | Parameter interaction |

### 2.7 Hybrid Wake Scoring (H3)

| ID | Test Case | Gap Reason |
|----|-----------|------------|
| HW-1 | Multiple dormant agents scored for same WorkItem — verify best selected | Selection logic not tested in service layer |
| HW-2 | Agent with perfect target match vs agent with high urgency — target wins | Priority tie-break |
| HW-3 | detectUnclaimedTasks with custom threshold parameter | Custom threshold path |
| HW-4 | Zero wait time — urgency should be 0, agent may still be woken if skill match | Edge of urgency formula |
| HW-5 | Service integration: multiple wake actions in single fast pass | Only single-wake tested |

### 2.8 Orphan Linking

| ID | Test Case | Gap Reason |
|----|-----------|------------|
| OL-1 | Multiple Requests within window — should link to nearest (most recent) | Nearest-match competition |
| OL-2 | Orphan WorkItem with `done` status — should be linked | Done status in filter but not explicitly tested |
| OL-3 | Empty requests array with orphan WorkItems | Boundary |

### 2.9 Stale Request Detection

| ID | Test Case | Gap Reason |
|----|-----------|------------|
| SR-1 | Request exactly at threshold boundary | Boundary condition |
| SR-2 | Empty requests array | Boundary |

---

## 3. Delegation Plan

### Quinn (Test Lead) — Owns
- This test plan document
- Review of all implemented tests
- Multi-cycle integration tests (MC-1 through MC-4)

### BE-Tester-Max — Backend Unit Tests
- All rules-level gap tests: SW-1–3, EC-1–3, RW-1–3, PP-1–4, HW-1–5, OL-1–3, SR-1–2
- Concurrent conflict edge cases: CC-1–3

### FE-Tester-Aria — Integration/E2E Tests
- Service-level integration tests that exercise the full pipeline
- Timer-based loop validation
- Performance regression tests

---

## 4. Test File Structure

All new tests should be appended to the existing test files to maintain co-location:

```
reconcile-rules.test.ts          ← New gap coverage sections appended
reconciler.service.test.ts       ← New multi-cycle + integration sections appended
reconciler-data-provider.test.ts ← No new tests needed (fully covered)
```

---

## 5. Conventions (from existing code)

- Use `makeWorkItem()`, `makeRequest()`, `makeAgentMap()` helpers
- Use `createTaskClaim()` from types/v2
- Use `jest.useFakeTimers()` / `jest.useRealTimers()` for timer tests
- Use `createMockProvider()` for service-level tests
- Group tests in `describe` blocks with `// ---` separator comments
- Include descriptive test names that explain the WHY
- Each correction assertion should check `entityType`, `newState`, and `reason`

---

## 6. Success Criteria

- All 35 new test cases pass
- No existing tests break
- Total test coverage for reconciler module reaches >95% line coverage
- All tests complete in <10s total
