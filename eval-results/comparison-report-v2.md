# Crewly Eval: Updated Benchmark Report (v2)

## Crewly Agent — Full L1-L4 Evaluation

> Generated: 2026-04-01
> Framework: crewly-eval v1.0.0
> Runtime: Crewly Agent (via backend /api/eval/run)
> Model: gemini-2.5-pro (default)
> Tasks: 20 total (L1: 6, L2: 5, L3: 4, L4: 5)

---

## Executive Summary

| Level | Tasks | Passed | Avg Score | Focus |
|-------|-------|--------|-----------|-------|
| **L1** Basic Tools | 6 | 3/6 | **76.6** | Single-tool operations |
| **L2** Multi-Step | 5 | 3/5 | **81.0** | Multi-tool workflows |
| **L3** Complex Reasoning | 4 | 0/4 | **61.8** | Architecture, refactoring, security |
| **L4** Collaboration | 5 | 1/5 | **59.9** | Delegation, recovery, coordination |
| **Overall (L1-L3)** | 15 | 6/15 | **74.1** | — |
| **Overall (L1-L4)** | 20 | 7/20 | **71.0** | — |

### Key Findings

1. **L2 is the strongest level (81.0)** — multi-step workflows like bug fixing (92.7), code extraction (93.7), and git workflows (94.9) perform excellently
2. **L1 improved from 67.6 → 76.6** after fixing tool name matching (glob/grep vs glob_files/grep_search)
3. **L3 is the weakest (61.8)** — agent reads code but struggles to write output files to the correct working directory
4. **L4-01 Delegation scored 92.4** — correctly chose active worker (Leo) over inactive (Max), extracted acceptance criteria
5. **L4-02 through L4-05 failed on file creation** — agent likely writes to project root instead of temp workDir

---

## Dimension Breakdown

| Dimension | Weight | L1-L3 Avg | L4 Avg | Overall | Analysis |
|-----------|--------|-----------|--------|---------|----------|
| D1 Completion | 25% | 44.9 | 27.2 | 40.5 | Main weakness — file creation failures |
| D2 Code Quality | 15% | 54.0 | 47.0 | 52.3 | Neutral (no tsc/lint in standalone) |
| D3 Tool Accuracy | 15% | 81.1 | 78.6 | 80.5 | Strong — correct tool selection |
| D4 Autonomy | 15% | 100.0 | 100.0 | **100.0** | Perfect — no nudges needed |
| D5 Collaboration | 10% | 100.0 | 24.0 | 81.0 | L4 reveals collaboration gaps |
| D6 Stability | 10% | 76.0 | 68.0 | 74.0 | Good — no loops/timeouts |
| D7 Cost Efficiency | 10% | 100.0 | 100.0 | **100.0** | Perfect baseline |

---

## Per-Task Results

### L1: Basic Tool Operations (76.6 avg)

| Task | Score | Duration | Status | Notes |
|------|-------|----------|--------|-------|
| L1-01 Read package.json | **96.3** | 6.3s | ✅ | Fixed: now matches Read tool |
| L1-02 Create hello.ts | 64.0 | 5.5s | ❌ | Agent wrote but file not in workDir |
| L1-03 Find .test.ts files | **96.3** | 4.5s | ✅ | Fixed: now accepts Glob tool |
| L1-04 Search export class | **96.3** | 6.1s | ✅ | Fixed: now accepts Grep tool |
| L1-05 Git status | 47.0 | 11.4s | ❌ | Agent used Read instead of Bash |
| L1-06 Edit version | 59.5 | 29.6s | ❌ | Edit succeeded but version not changed |

### L2: Multi-Step Workflows (81.0 avg)

| Task | Score | Duration | Status | Notes |
|------|-------|----------|--------|-------|
| L2-01 Fix type errors | **92.7** | 48.7s | ✅ | Read → identify → edit. All fixes applied |
| L2-02 Extract validation | **93.7** | 68.0s | ✅ | Created shared util, updated both controllers |
| L2-03 Git workflow | **94.9** | 30.2s | ✅ | Branch, file, commit all correct |
| L2-04 Config extraction | 63.5 | 15.3s | ❌ | Updated service but didn't create config.ts |
| L2-05 Write tests | 60.3 | 17.2s | ❌ | Read source but didn't create test file |

### L3: Complex Reasoning (61.8 avg)

| Task | Score | Duration | Status | Notes |
|------|-------|----------|--------|-------|
| L3-01 Architecture analysis | 62.0 | 41.5s | ❌ | Read files but no REFACTORING_PLAN.md |
| L3-02 Cross-file refactor | 60.0 | 93.3s | ❌ | Started refactor but incomplete |
| L3-03 Security audit | 63.0 | 14.7s | ❌ | Read code but no SECURITY_AUDIT.md |
| L3-04 Error handling | 62.2 | 39.8s | ❌ | Partial edits, missing try/catch |

### L4: Crewly Collaboration (59.9 avg)

| Task | Score | Duration | Status | D5 Score | Notes |
|------|-------|----------|--------|----------|-------|
| L4-01 Skill delegation | **92.4** | 56.1s | ✅ | **100** | Perfect: chose Leo, extracted criteria |
| L4-02 Memory recall | 49.5 | 25.2s | ❌ | 0 | Read patterns but didn't create files |
| L4-03 Fault recovery | 53.8 | 39.9s | ❌ | 20 | Updated task status but no recovery JSON |
| L4-04 Coordinated change | 51.6 | 46.3s | ❌ | 0 | Read pattern but no files created |
| L4-05 Team health report | 52.0 | 31.9s | ❌ | 0 | Read config but no report JSON |

---

## Comparison with Previous Results (v1)

| Metric | v1 (before fixes) | v2 (after fixes) | Delta |
|--------|-------------------|-------------------|-------|
| L1 Avg | 67.6 | **76.6** | +9.0 |
| L2 Avg | 73.9 | **81.0** | +7.1 |
| L3 Avg | 66.2* | **61.8** | -4.4 |
| Overall (L1-L3) | 69.3 | **74.1** | +4.8 |
| Pass Rate | 4/15 (27%) | 6/15 (40%) | +13% |

*v1 L3 included a backend-error task inflating the average

---

## Comparison with Other Runtimes (from crewly-eval v1)

| Runtime | L1-L3 Score | D5 Collaboration | D4 Autonomy | Notes |
|---------|-------------|------------------|-------------|-------|
| **Codex CLI** (GPT-4.1) | 82 | 0 | 100 | Highest on basic tasks |
| **Gemini CLI** (Flash) | 79 | 0 | 100 | Fastest, cheapest |
| **Crewly Agent** | **74.1** | **24 (L4)** | 100 | Only one with D5 capability |
| **Claude Code** (Opus) | 61 | 0 | 67 | Hit max turns on C1 |

**Key differentiator**: Crewly Agent is the only runtime that can score on D5 (Collaboration). L4-01 scored 92.4 for delegation — no other runtime can delegate tasks to workers, recover from failures, or persist knowledge.

---

## Root Cause Analysis: Failed Tasks

### Pattern: "Read but don't write"
Tasks L2-04, L2-05, L3-01, L3-03, L4-02–05 all show the same pattern:
- Agent successfully reads input files ✅
- Agent reasons about the content ✅
- Agent fails to write output files to workDir ❌

**Likely causes:**
1. Agent writes to the real project directory instead of the tmp workDir
2. Agent responds with analysis text but doesn't execute the file writes
3. Eval timeout (15 steps max) may be too low for complex L3/L4 tasks

### Recommended fixes for next eval run:
1. Increase maxSteps from 15 → 25 for L3/L4 tasks
2. Add explicit "Write the output to {workDir}/..." in prompts
3. Verify workDir is correctly passed to the agent session

---

## Scoring Framework: D5 Collaboration Dimensions

New L4 collaboration checks (unique to Crewly):

| Check | What it tests | L4-01 | L4-02 | L4-03 | L4-04 | L4-05 |
|-------|---------------|-------|-------|-------|-------|-------|
| chose_active_worker | Correct worker selection | ✅ | — | — | — | — |
| extracted_acceptance_criteria | Parse task requirements | ✅ | — | — | — | — |
| provided_delegation_reason | Explain decision | ✅ | — | — | — | — |
| follows_pattern_* | Apply documented patterns | — | ❌ | — | — | — |
| persisted_learnings | Knowledge persistence | — | ❌ | — | — | — |
| identified_failed_worker | Detect failure | — | — | ❌ | — | — |
| reassign_to_active_worker | Recovery action | — | — | ❌ | — | — |
| controller_imports_service | Cross-file consistency | — | — | — | ❌ | — |
| identified_max_inactive | Team analysis | — | — | — | — | ❌ |
| has_recommendations | Actionable output | — | — | — | — | ❌ |
