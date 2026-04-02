#!/bin/bash
# Multi-runtime benchmark runner
# Runs L1-L4 eval tasks against all 4 runtimes with the same task set
# Usage: bash eval-results/run-all-benchmarks.sh [--levels L1,L2]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

LEVELS="${1:-}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H-%M-%S")
OUTPUT_DIR="eval-results"

echo "═══════════════════════════════════════════════════════════════════════"
echo "  CREWLY MULTI-RUNTIME BENCHMARK"
echo "  Timestamp: $TIMESTAMP"
echo "  Levels: ${LEVELS:-ALL (L1-L4)}"
echo "═══════════════════════════════════════════════════════════════════════"

# Check backend
echo ""
echo "▸ Checking backend..."
if curl -sf http://localhost:8787/health > /dev/null 2>&1; then
  echo "  ✓ Backend healthy"
else
  echo "  ✗ Backend not available. Start it first."
  exit 1
fi

LEVEL_ARG=""
if [ -n "$LEVELS" ]; then
  LEVEL_ARG="--level=$LEVELS"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  RUNTIME 1/4: Crewly Agent (via backend API)"
echo "═══════════════════════════════════════════════════════════════════════"

npx tsx backend/src/services/agent/crewly-agent/eval/run-eval-standalone.ts \
  --runtime=crewly-agent $LEVEL_ARG 2>&1 | tee "$OUTPUT_DIR/log-crewly-agent-$TIMESTAMP.txt"

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  RUNTIME 2/4: Claude Code"
echo "═══════════════════════════════════════════════════════════════════════"

npx tsx backend/src/services/agent/crewly-agent/eval/run-eval-standalone.ts \
  --runtime=claude-code $LEVEL_ARG 2>&1 | tee "$OUTPUT_DIR/log-claude-code-$TIMESTAMP.txt"

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  RUNTIME 3/4: Gemini CLI"
echo "═══════════════════════════════════════════════════════════════════════"

npx tsx backend/src/services/agent/crewly-agent/eval/run-eval-standalone.ts \
  --runtime=gemini-cli $LEVEL_ARG 2>&1 | tee "$OUTPUT_DIR/log-gemini-cli-$TIMESTAMP.txt"

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  RUNTIME 4/4: Codex CLI"
echo "═══════════════════════════════════════════════════════════════════════"

npx tsx backend/src/services/agent/crewly-agent/eval/run-eval-standalone.ts \
  --runtime=codex-cli $LEVEL_ARG 2>&1 | tee "$OUTPUT_DIR/log-codex-cli-$TIMESTAMP.txt"

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  ALL BENCHMARKS COMPLETE"
echo "  Results in: $OUTPUT_DIR/eval-*-$TIMESTAMP*.json"
echo "═══════════════════════════════════════════════════════════════════════"
