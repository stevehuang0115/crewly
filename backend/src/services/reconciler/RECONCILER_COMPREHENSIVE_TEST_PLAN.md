# V3 Reconciler — Comprehensive Test Plan (Final)

**Author:** Quinn (Test Lead)
**Date:** 2026-04-08
**Status:** Active — Implementing

---

## 1. Executive Summary

The Reconciler is the "CPU" of Crewly V3 — a two-level loop (fast=10s, full=60s) that periodically recomputes system truth from durable state. This document covers our complete test strategy, current coverage analysis, and new test gaps requiring implementation.

### Current Test State

| File | Tests | Lines | Status |
|------|-------|-------|--------|
| `reconcile-rules.test.ts` | ~135 | ~2,260 | ✅ All passing |
| `reconciler.service.test.ts` | ~95 | ~2,289 | ✅ All passing |
| `reconciler-data-provider.test.ts` | ~20 | ~481 | ✅ All passing |
| `reconciler.controller.test.ts` | Varies | - | ✅ All passing |
| `reconcile.types.test.ts` | Varies | - | ✅ All passing |
| **Total** | **316** | | **All 316 passing** |

### Prior Gap Tests (RECONCILER_TEST_PLAN.md)

All 35 gap tests from the original test plan are **already implemented**:
- SW-1–3: ✅ Stuck WorkItems (zero retry, corruption, large batch)
- EC-1–3: ✅ Expired Claims (invalid date, large batch, race condition)
- MC-1–4: ✅ Multi-Cycle Integration (state evolution, no double-correction, two-phase claim, timer-interleaved)
- CC-1–3: ✅ Concurrent Claim Conflicts (duplicate claims, revoke during apply, fast reclaim)
- RW-1–3: ✅ Recoverable WorkItems (last retry, mixed health, agent transition journey)
- PP-1–4: ✅ Pruning Pass (dual-hit dedup, 4-level cascade, dual-category counting, custom thresholds)
- HW-1–5: ✅ Hybrid Wake (multi-agent scoring, target vs generic, custom threshold, zero urgency, multi-wake)
- OL-1–3: ✅ Orphan Linking (nearest match, done status, empty requests)
- SR-1–2: ✅ Stale Request Detection (boundary, empty array)

---

## 2. New Test Gaps Identified

After thorough review, the following additional edge cases and integration scenarios are NOT yet covered:

### 2.1 Unit Tests — Reconcile Rules (for BE-Tester-Max)

| ID | Test Case | Gap Reason | File |
|----|-----------|------------|------|
| NG-1 | `detectStuckWorkItems`: WorkItem with `target` pointing to agent with `started` status — should NOT be stuck | Agent lifecycle edge: started ≠ dead but also not yet active. Currently tested in gap coverage but only verifying `started` is not dead. Need to verify the correction details (should have 0 corrections, not just 0 stuckIds) | reconcile-rules.test.ts |
| NG-2 | `computeAgentScore`: WorkItem with empty title string — keyword extraction edge case | Empty string split could produce empty array, affecting tag matching | reconcile-rules.test.ts |
| NG-3 | `computeAgentScore`: Agent with teamId matching WorkItem.owner='agent' — context familiarity score of 5 | teamId context path never explicitly tested with assertion on exact score | reconcile-rules.test.ts |
| NG-4 | `detectUnclaimedTasks`: All agents have score ≤ 0 due to high load — no wake actions should fire | Wake action suppression path when all candidates are overloaded | reconcile-rules.test.ts |
| NG-5 | `reconcileRequestStatus`: Request with mix of done + cancelled + queued WorkItems — should be running (hasQueued=true wins) | Three-way status mix not explicitly tested | reconcile-rules.test.ts |
| NG-6 | `cascadeCancelChildren`: Circular parent references — should not infinite loop | Defensive: malformed data could cause infinite loop without protection | reconcile-rules.test.ts |
| NG-7 | `detectStaleQueuedWorkItems`: Custom threshold with exact boundary — should not flag | Boundary condition for stale queue detection | reconcile-rules.test.ts |
| NG-8 | `linkOrphanWorkItems`: WorkItem created at exact same millisecond as Request — diff=0, should still link | Exact boundary of time window | reconcile-rules.test.ts |

### 2.2 Integration Tests — Service Layer (for FE-Tester-Aria)

| ID | Test Case | Gap Reason | File |
|----|-----------|------------|------|
| NG-9 | `runFull` followed by `runFast` in quick succession — verify fast gets fresh data, not stale | Data staleness between pass types | reconciler.service.test.ts |
| NG-10 | `runFull` with all 8 pipeline stages producing corrections simultaneously — verify total counts accurate | End-to-end pipeline with maximum complexity scenario | reconciler.service.test.ts |
| NG-11 | `updateConfig` changing `workItemTimeoutMs` mid-session — next pass should use new timeout | Runtime config change affecting rule behavior | reconciler.service.test.ts |
| NG-12 | `getHistory` with limit=0 — should return empty array | Boundary: zero-limit edge case | reconciler.service.test.ts |
| NG-13 | `reconcileRequest` when data provider throws on `getWorkItemsForRequest` — error captured | Error isolation for targeted reconciliation | reconciler.service.test.ts |
| NG-14 | `runFast` Hybrid Wake with `executeWakeAction` throwing Error — verify wake errors don't block claim/stuck detection | Error isolation between wake and detection stages | reconciler.service.test.ts |

---

## 3. Delegation Plan

### BE-Tester-Max — Unit Tests (NG-1 through NG-8)
- All rules-level tests appended to `reconcile-rules.test.ts`
- Follow existing helper patterns: `makeWorkItem()`, `makeRequest()`, `makeAgentMap()`
- Each test should verify correction `entityType`, `newState`, and `reason`

### FE-Tester-Aria — Integration Tests (NG-9 through NG-14)
- All service-level tests appended to `reconciler.service.test.ts`
- Follow existing helper patterns: `createMockProvider()`, `makeWorkItem()`, `makeRequest()`
- Use `jest.useFakeTimers()` / `jest.useRealTimers()` for timer tests

---

## 4. Success Criteria

- All 14 new test cases pass
- No existing 316 tests break
- Total test runtime remains < 10s
- Each test is self-contained and non-flaky
