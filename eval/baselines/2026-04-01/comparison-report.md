# Crewly Eval: 4-Way Comparison Report (v4)

## Claude Code vs Crewly Agent vs Gemini CLI vs Codex CLI

> Generated: 2026-04-01
> Tasks: A1 (bug_fix), B1 (feature), C1 (refactor)
> Runtimes:
> - Claude Code (Opus 4.6, `claude -p --output-format json`)
> - Crewly Agent (CLI fallback, default model)
> - Gemini CLI v0.35.3 (Gemini 3 Flash Preview, `gemini -p --yolo -o json`)
> - Codex CLI v0.118.0 (GPT-4.1, `codex exec --full-auto --json`)

---

## Executive Summary

| Runtime | Avg Score | A1 | B1 | C1 | Total Time | Completions | Total Cost |
|---------|-----------|----|----|----|-----------:|-------------|------------|
| **Claude Code** (Opus) | 61 | 65 | 72 | 46 | 13m13s | 2/3 | ~$0.000* |
| **Crewly Agent** (CLI fallback) | 73 | 64 | 76 | 80 | 5m46s | 3/3 | ~$0.000* |
| **Gemini CLI** (Flash Preview) | 79 | 68 | 87 | 82 | 4m40s | 3/3 | $0.030 |
| **Codex CLI** (GPT-4.1) | **82** | **80** | 82 | **85** | 6m56s | **3/3** | $0.445 |

*Claude Code and Crewly Agent cost parsing returned $0 (JSON output format limitation).

### Key Findings

1. **Codex CLI wins overall** at 82 avg — beating Gemini CLI (79) by +3, Crewly Agent (73) by +9, and Claude Code (61) by +21
2. **All 4 runtimes achieved 100% pass on B1** — the health endpoint task was universally solvable
3. **Codex CLI and Gemini CLI both passed ALL checks on ALL tasks** — 100% D1 Correctness, including A1 typescript and C1 constants_exist that Claude Code/Crewly Agent failed
4. **Gemini CLI is the cheapest** ($0.030 total) — 15x cheaper than Codex CLI ($0.445)
5. **Gemini CLI is the fastest** (4m40s) — Codex CLI took 6m56s, Crewly Agent 5m46s
6. **Codex CLI has the most efficient tool usage** — lowest total tool calls (35) with highest correctness

---

## Dimension Breakdown (averages across 3 tasks)

| Dimension | Weight | Claude Code | Crewly Agent | Gemini CLI | Codex CLI | Best |
|-----------|--------|-------------|--------------|------------|-----------|------|
| D1 Correctness | 25% | 75 | 75 | **100** | **100** | Tie (Gemini/Codex) |
| D2 Code Quality | 15% | 78 | 78 | **85** | **85** | Tie (Gemini/Codex) |
| D3 Reasoning | 20% | 24 | 44 | 44 | **48** | Codex |
| D4 Autonomy | 15% | 67 | **100** | **100** | **100** | Tie (3-way) |
| D5 Context Mgmt | 10% | 57 | 90 | 76 | **97** | Codex |
| D6 Collaboration | 5% | 0 | 0 | 0 | 0 | N/A |
| D7 Cost Efficiency | 10% | 100 | 100 | **100** | **100** | Tie |

### Analysis

- **D1 Correctness**: Codex CLI and Gemini CLI are the only runtimes to pass ALL verification checks (100 across all 3 tasks). Claude Code and Crewly Agent both scored 75.
- **D3 Reasoning**: Codex CLI edges out with 48 avg — fewer steps per task than the others. Gemini's A1 performance (23 tool calls) dragged its D3 down.
- **D5 Context Mgmt**: Codex CLI dominates with 97 avg — only 8/17/10 tool calls for A1/B1/C1. Very focused execution.
- **D4 Autonomy**: Only Claude Code loses here (C1 errored out at max turns).

---

## Per-Task Results

### A1: TypeScript Bug Fix (easy, 5min limit)

| Metric | Claude Code | Crewly Agent | Gemini CLI | Codex CLI |
|--------|-------------|--------------|------------|-----------|
| Score | 65 | 64 | 68 | **80** |
| Time | 39.5s | **30.5s** | 119.2s | 66.9s |
| Tool calls | 7 | 8 | 23 | 8 |
| Completion | agent_done | agent_done | agent_done | agent_done |
| TS check | :x: | :x: | :white_check_mark: | :white_check_mark: |
| Tests | :white_check_mark: | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| Cost | $0.000 | $0.000 | $0.015 | $0.086 |

**Codex CLI wins A1** with 80 pts — passing both checks in only 8 tool calls. Gemini CLI also passed tsc but used 23 tool calls, costing it on D3. Claude Code and Crewly Agent both failed the typescript check.

### B1: Health Endpoint Feature (medium, 10min limit)

| Metric | Claude Code | Crewly Agent | Gemini CLI | Codex CLI |
|--------|-------------|--------------|------------|-----------|
| Score | 72 | 76 | **87** | 82 |
| Time | 545.8s (9m6s) | 231.1s (3m51s) | **79.7s (1m20s)** | 253.3s (4m13s) |
| Tool calls | 44 | 31 | **11** | 17 |
| Completion | agent_done | agent_done | agent_done | agent_done |
| TS check | :white_check_mark: | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| Tests | :white_check_mark: | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| health_exists | :white_check_mark: | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| Cost | $0.000 | $0.000 | $0.008 | $0.246 |

**Gemini CLI wins B1** at 87 pts — fastest (1m20s), fewest tool calls (11), cheapest ($0.008). All 4 runtimes passed all checks. Codex CLI is second at 82, but 30x more expensive than Gemini.

### C1: Extract Constants Refactor (medium, 10min limit)

| Metric | Claude Code | Crewly Agent | Gemini CLI | Codex CLI |
|--------|-------------|--------------|------------|-----------|
| Score | 46 | 80 | 82 | **85** |
| Time | 208.0s (3m28s) | **84.8s (1m25s)** | 80.6s (1m21s) | 95.6s (1m36s) |
| Tool calls | 50 (hit max) | 9 | 13 | **10** |
| Completion | **error** | agent_done | agent_done | agent_done |
| TS check | :white_check_mark: | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| Tests | :white_check_mark: | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| No hardcoded ports | :white_check_mark: | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| Constants file exists | :x: | :x: | :white_check_mark: | :white_check_mark: |
| Cost | $0.000 | $0.000 | $0.007 | $0.114 |

**Codex CLI wins C1** at 85 pts — all 4 checks passed with 10 tool calls. Gemini CLI also passed all 4 checks (82). Claude Code errored at 50 max turns. Crewly Agent completed but missed constants_exist.

---

## Tool Call Comparison

| Task | Claude Code | Crewly Agent | Gemini CLI | Codex CLI |
|------|-------------|--------------|------------|-----------|
| A1 | 7 | 8 | 23 | 8 |
| B1 | 44 | 31 | 11 | 17 |
| C1 | 50 (max) | 9 | 13 | 10 |
| **Total** | 101 | 48 | 47 | **35** |

Codex CLI used the fewest total tool calls (35), followed by Gemini (47) and Crewly Agent (48). Claude Code used 101 — nearly 3x more than Codex.

---

## Cost Comparison

| Runtime | A1 | B1 | C1 | Total | $/Task Avg |
|---------|----|----|----|----- |------------|
| Claude Code | $0.000* | $0.000* | $0.000* | $0.000* | N/A |
| Crewly Agent | $0.000* | $0.000* | $0.000* | $0.000* | N/A |
| Gemini CLI | $0.015 | $0.008 | $0.007 | **$0.030** | $0.010 |
| Codex CLI | $0.086 | $0.246 | $0.114 | $0.445 | $0.148 |

*Token usage parsing returned 0 for Claude/Crewly (JSON output limitation).

**Cost efficiency**: Gemini CLI is 15x cheaper than Codex CLI ($0.010/task vs $0.148/task), while scoring only 3 pts lower on avg. The cost gap is driven by model pricing: Gemini Flash ($0.15/M input) vs GPT-4.1 ($2.00/M input).

---

## Speed Comparison

| Runtime | A1 | B1 | C1 | Total | Avg/Task |
|---------|----|----|----|----- |----------|
| Claude Code | 39.5s | 545.8s | 208.0s | **793.3s** | 264.4s |
| Crewly Agent | 30.5s | 231.1s | 84.8s | 346.4s | 115.5s |
| Gemini CLI | 119.2s | 79.7s | 80.6s | **279.5s** | 93.2s |
| Codex CLI | 66.9s | 253.3s | 95.6s | 415.8s | 138.6s |

Gemini CLI is fastest overall (4m40s), but varies by task — slow on A1 (2m), fast on B1/C1 (~80s each). Codex CLI is consistently moderate (1-4min per task).

---

## Runtime Comparison Matrix

| Capability | Claude Code | Crewly Agent | Gemini CLI | Codex CLI |
|-----------|-------------|--------------|------------|-----------|
| Model | Claude Opus 4.6 | Claude (default) | Gemini 3 Flash Preview | GPT-4.1 |
| Provider | Anthropic | Anthropic | Google | OpenAI |
| Invocation | `claude -p` | API / CLI fallback | `gemini -p --yolo` | `codex exec --full-auto` |
| Output format | JSON (limited) | JSON (limited) | JSON (full stats) | **JSONL (streaming events)** |
| Token tracking | :x: | :x: | :white_check_mark: (per-model) | :white_check_mark: (per-turn) |
| Tool call tracking | Via `num_turns` | Via `num_turns` | `stats.tools.totalCalls` | **Event-level** (per item) |
| Requires git repo | No | No | No | **Yes** |
| Sandbox | None | None | None | workspace-write |
| Multi-model | No | No | Yes (router + main) | No |
| Cost/task (actual) | ~$0.10-0.25 est | ~$0.01-0.05 est | **$0.010** | $0.148 |

---

## Rankings

### By Overall Score (higher is better)
1. **Codex CLI** — 82/100
2. **Gemini CLI** — 79/100
3. **Crewly Agent** — 73/100
4. **Claude Code** — 61/100

### By Cost Efficiency (lower is better)
1. **Gemini CLI** — $0.030 total ($0.010/task)
2. **Codex CLI** — $0.445 total ($0.148/task)
3. Claude Code / Crewly Agent — unknown (parsing issue)

### By Speed (lower is better)
1. **Gemini CLI** — 4m40s total
2. **Crewly Agent** — 5m46s total
3. **Codex CLI** — 6m56s total
4. **Claude Code** — 13m13s total

### By Correctness (higher is better)
1. **Codex CLI** / **Gemini CLI** — 100% checks passed (tie)
3. **Crewly Agent** — 75% avg D1
4. **Claude Code** — 75% avg D1

---

## Caveats

1. **CLI fallback mode**: Crewly backend was offline. Not a true Crewly Agent (with delegation/multi-agent).
2. **Single run**: Each task run once. Results may vary — 3-5 iterations needed for statistical confidence.
3. **D6 Collaboration = 0**: No runtime used multi-agent coordination. True Crewly Agent would score here.
4. **Claude/Crewly cost unknown**: Token parsing returns 0 in `-p` mode.
5. **Model tier differences**: Opus ($15/M) vs GPT-4.1 ($2/M) vs Flash ($0.15/M) — different capability tiers.
6. **Codex sandbox**: `--full-auto` uses `workspace-write` sandbox — may limit some operations.
7. **Gemini --yolo**: Auto-approves all tools without sandbox. Most permissive execution mode.

---

## Recommendations

1. **Fix Claude Code token tracking** — parse `--verbose` output for real cost data
2. **Run Crewly backend** — test true multi-agent delegation vs single-agent CLIs
3. **Add more tasks** — 3 tasks insufficient, target 10+ for reliable rankings
4. **Multi-run** — run each task 3-5 times to measure variance
5. **Test Codex with o3/o4-mini** — compare GPT-4.1 vs reasoning models
6. **Test Gemini with 2.5 Pro** — compare Flash vs Pro quality
7. **Normalize by cost** — score/dollar metric would give Gemini CLI a massive advantage

---

## Raw Data

- Claude Code results: `results/claude-code/`
- Crewly Agent results: `results/crewly-agent/`
- Gemini CLI results: `results/gemini-cli/`
- Codex CLI results: `results/codex-cli/`
- Run work directories: `runs/`
- Previous v3 report: (archived, replaced by this v4)
