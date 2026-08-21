#!/bin/bash
# Delegate a task to an agent with a structured task template.
# Optionally sets up auto-monitoring (idle event subscription + fallback schedule)
# that will be cleaned up automatically when the task completes.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

# --- Input parsing: CLI flags (preferred) or legacy JSON ---
INPUT_JSON=""
TO=""
TASK=""
PRIORITY="normal"
CONTEXT=""
PROJECT_PATH=""
TASK_TYPE="general"
TEAM_ID=""
FORCE_CROSS_TEAM="false"
REQUEST_ID=""
# Self-heal fix #3 (2026-05-20): default fallback timer at 30min. Per
# the orchestrator prompt §3.0 the orc is supposed to set 2× ETA
# manually for every dispatch, but the convention was unenforced —
# observable in the 2026-05-20 ESTestNode incident where the orc set
# only the idle subscription and not the fallback timer, leaving the
# orc clueless when Sora never started. Auto-creating a 30min fallback
# at dispatch time guarantees the dual-signal contract is honored.
# Caller can override via --fallback-minutes N, or disable with
# --fallback-minutes 0.
FALLBACK_MINUTES="30"

# Detect legacy JSON argument
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --to|-t)         TO="$2";              shift 2 ;;
    --task|-T)       TASK="$2";             shift 2 ;;
    --task-file)     TASK="$(cat "$2")";    shift 2 ;;
    --priority|-P)   PRIORITY="$2";         shift 2 ;;
    --context|-c)    CONTEXT="$2";          shift 2 ;;
    --project|-p)    PROJECT_PATH="$2";     shift 2 ;;
    --task-type)     TASK_TYPE="$2";        shift 2 ;;
    --team|-g)       TEAM_ID="$2";          shift 2 ;;
    --request-id|-R) REQUEST_ID="$2";       shift 2 ;;
    --force-cross-team) FORCE_CROSS_TEAM="true"; shift ;;
    --fallback-minutes) FALLBACK_MINUTES="$2"; shift 2 ;;
    --json|-j)       INPUT_JSON="$2";       shift 2 ;;
    --help|-h)
      echo "Usage: execute.sh --to agent-session --task 'implement feature' --priority high --project /path [--team teamId] [--context 'extra info']"
      exit 0
      ;;
    --)              shift; break ;;
    *)
      if [[ -z "$INPUT_JSON" && ${1:0:1} == '{' ]]; then
        INPUT_JSON="$1"; shift
      else
        error_exit "Unknown argument: $1"
      fi
      ;;
  esac
done

# Read task from stdin if not yet provided
if [ -z "$INPUT_JSON" ] && [ -z "$TASK" ] && [ ! -t 0 ]; then
  STDIN_DATA="$(cat)"
  if [[ ${STDIN_DATA:0:1} == '{' ]]; then
    INPUT_JSON="$STDIN_DATA"
  else
    TASK="$STDIN_DATA"
  fi
fi

# Parse JSON if provided (backward compatible)
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$TO" ] && TO=$(printf '%s' "$INPUT" | jq -r '.to // empty')
  [ -z "$TASK" ] && TASK=$(printf '%s' "$INPUT" | jq -r '.task // empty')
  [ "$PRIORITY" = "normal" ] && { P=$(printf '%s' "$INPUT" | jq -r '.priority // empty'); [ -n "$P" ] && PRIORITY="$P"; }
  [ -z "$CONTEXT" ] && CONTEXT=$(printf '%s' "$INPUT" | jq -r '.context // empty')
  [ -z "$PROJECT_PATH" ] && PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
  [ "$TASK_TYPE" = "general" ] && { TT=$(printf '%s' "$INPUT" | jq -r '.taskType // empty'); [ -n "$TT" ] && TASK_TYPE="$TT"; }
  [ -z "$TEAM_ID" ] && TEAM_ID=$(printf '%s' "$INPUT" | jq -r '.teamId // empty')
  [ "$FORCE_CROSS_TEAM" = "false" ] && FORCE_CROSS_TEAM=$(printf '%s' "$INPUT" | jq -r '.forceCrossTeam // "false"')
  [ -z "$REQUEST_ID" ] && REQUEST_ID=$(printf '%s' "$INPUT" | jq -r '.requestId // empty')
fi

require_param "to (--to)" "$TO"
require_param "task (--task)" "$TASK"

# Request Contract check (P0-3): non-fatal warning when the delegated brief
# is missing Goal / Expected Outcome / Eval Criteria markers. TLs and workers
# downstream are entitled to push back per the Brief Reception Protocol when
# these are absent. Spec:
# .crewly/specs/2026-05-03-agent-improvement-p0-execution.md §"Fix P0-3".
#
# Scans the WHOLE delegated brief, not just `--task`. The Request Contract can
# legitimately live in `--task`, in `--context`, or be split across the two,
# and delegators routinely put the long-form G/O/E in `--context` while
# `--task` carries the one-line ask. `--context` is delivered to the target
# (see the TASK_MESSAGE assembly below), so a contract written there does
# reach the recipient — it was simply not being looked at here. Scanning only
# `--task` therefore warned "Request Contract incomplete" at briefs whose
# contract was fully present, just in the other field.
#
# That false positive is corrosive rather than cosmetic: this warning is the
# signal TLs and workers use to decide whether to push back under the Brief
# Reception Protocol, so crying wolf trains them to ignore a real one.
#
# The check is NOT weakened — a marker genuinely absent from BOTH fields
# still warns, and the missing-field list is still per-marker.
#
# Mirrors the same fix in config/skills/team-leader/delegate-task/execute.sh.
#
# $1 = task, $2 = context (either may be empty).
warn_missing_request_contract() {
  # Join with a newline rather than concatenating: the patterns below anchor
  # on `^`, which grep evaluates per line, and a seam newline also prevents a
  # task ending in "go" plus a context starting "al:" from fabricating a
  # spurious "goal:" match across the boundary.
  local brief
  brief="$(printf '%s\n%s' "${1:-}" "${2:-}")"
  local missing=()
  if ! echo "$brief" | grep -qiE '(^|[^a-zA-Z])(\*\*)?(goal|objective)(:|s?\b)'; then
    missing+=("Goal")
  fi
  if ! echo "$brief" | grep -qiE '(^|[^a-zA-Z])(\*\*)?(expected )?outcome(:|s?\b)'; then
    missing+=("Outcome")
  fi
  if ! echo "$brief" | grep -qiE '(^|[^a-zA-Z])(\*\*)?(eval|evaluation criteria|acceptance criteria)(:|s?\b)'; then
    missing+=("Eval")
  fi
  if [ ${#missing[@]} -gt 0 ]; then
    local list
    list=$(IFS=, ; echo "${missing[*]}")
    echo "{\"warning\":\"Request Contract incomplete: brief is missing markers for: ${list}. Neither the task nor the context field carries them. Per P0-3 spec, every delegated subtask MUST include Goal + Expected Outcome + Eval Criteria. TLs and workers may push back via the Brief Reception Protocol. Source: .crewly/specs/2026-05-03-agent-improvement-p0-execution.md §Fix P0-3.\"}" >&2
  fi
}

warn_missing_request_contract "$TASK" "$CONTEXT"

# #180: Validate target agent belongs to the specified team
if [ -n "$TEAM_ID" ] && [ "$FORCE_CROSS_TEAM" != "true" ]; then
  TEAM_DATA=$(api_call GET "/teams/${TEAM_ID}" 2>/dev/null || echo '{}')
  MEMBER_SESSION=$(echo "$TEAM_DATA" | jq -r --arg to "$TO" '.data.members[]? | select(.sessionName == $to) | .sessionName // empty' 2>/dev/null || true)
  if [ -z "$MEMBER_SESSION" ]; then
    echo "{\"success\":false,\"error\":\"Cross-team delegation blocked: ${TO} is not a member of team ${TEAM_ID}. Use forceCrossTeam:true to override.\"}"
    exit 1
  fi
fi

# #182: Technical task routing — if taskType=technical and target is PM with a TL,
# auto-redirect to the TL to skip PM middleman latency
if [ "$TASK_TYPE" = "technical" ] && [ -n "$TEAM_ID" ]; then
  TARGET_ROLE=$(echo "$TEAM_DATA" | jq -r --arg to "$TO" '.data.members[]? | select(.sessionName == $to) | .role // empty' 2>/dev/null || true)
  if [ "$TARGET_ROLE" = "product-manager" ]; then
    # Find TL in the same team
    TL_SESSION=$(echo "$TEAM_DATA" | jq -r '.data.members[]? | select(.role == "team-leader" or .canDelegate == true) | .sessionName // empty' 2>/dev/null | head -1 || true)
    if [ -n "$TL_SESSION" ]; then
      echo "{\"info\":\"Technical task redirected from PM (${TO}) to TL (${TL_SESSION})\"}" >&2
      TO="$TL_SESSION"
    fi
  fi
fi

# Structured message parameters (for hierarchical teams)
# Default INPUT to empty JSON if not set (when using --flag mode)
INPUT="${INPUT:-{}}"
TITLE=$(printf '%s' "$INPUT" | jq -r '.title // empty')
PARENT_TASK_ID=$(printf '%s' "$INPUT" | jq -r '.parentTaskId // empty')
EXPECTED_ARTIFACTS=$(printf '%s' "$INPUT" | jq -c '.expectedArtifacts // empty')
CONTEXT_FILES=$(printf '%s' "$INPUT" | jq -c '.contextFiles // empty')
DEADLINE_HINT=$(printf '%s' "$INPUT" | jq -r '.deadlineHint // empty')
USE_STRUCTURED=$(printf '%s' "$INPUT" | jq -r '.structured // "false"')

# Resolve Crewly root from this script path:
# config/skills/orchestrator/delegate-task/execute.sh -> project root
CREWLY_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

resolve_skill_paths() {
  local input="$1"
  # Convert "bash config/skills/..." and "/config/skills/..." to absolute paths.
  # This keeps delegated instructions runnable when agents use different CWDs.
  perl -pe '
    my $root = $ENV{"CREWLY_ROOT"};
    s{\bbash\s+config/skills/}{bash $root/config/skills/}g;
    s{(?<![A-Za-z0-9_./-])config/skills/}{$root/config/skills/}g;
  ' <<< "$input"
}

TASK="$(CREWLY_ROOT="$CREWLY_ROOT" resolve_skill_paths "$TASK")"
if [ -n "$CONTEXT" ]; then
  CONTEXT="$(CREWLY_ROOT="$CREWLY_ROOT" resolve_skill_paths "$CONTEXT")"
fi

# Build the task message
# If structured=true and title is provided, use the [TASK ASSIGNMENT] format
# Otherwise, use the legacy free-text format for backwards compatibility
DELEGATOR="${CREWLY_SESSION_NAME:-crewly-orc}"

if [ "$USE_STRUCTURED" = "true" ] && [ -n "$TITLE" ]; then
  # Structured TaskAssignment format for hierarchical teams
  TASK_MESSAGE="---\n[TASK ASSIGNMENT]\nTask ID: ${TASK_ID:-pending}\nTitle: ${TITLE}\nPriority: ${PRIORITY}\nDelegated by: ${DELEGATOR}\nParent Task: ${PARENT_TASK_ID:-none}\n---\n\n## Instructions\n${TASK}"

  # Add expected artifacts if provided
  if [ -n "$EXPECTED_ARTIFACTS" ] && [ "$EXPECTED_ARTIFACTS" != "" ]; then
    ARTIFACT_LIST=$(echo "$EXPECTED_ARTIFACTS" | jq -r '.[]? // empty' 2>/dev/null | while read -r a; do echo "- ${a}"; done)
    if [ -n "$ARTIFACT_LIST" ]; then
      TASK_MESSAGE="${TASK_MESSAGE}\n\n## Expected Deliverables\n${ARTIFACT_LIST}"
    fi
  fi

  # Add context files if provided
  if [ -n "$CONTEXT_FILES" ] && [ "$CONTEXT_FILES" != "" ]; then
    FILE_LIST=$(echo "$CONTEXT_FILES" | jq -r '.[]? // empty' 2>/dev/null | while read -r f; do echo "- ${f}"; done)
    if [ -n "$FILE_LIST" ]; then
      TASK_MESSAGE="${TASK_MESSAGE}\n\n## Context\nRead these files first:\n${FILE_LIST}"
    fi
  fi

  [ -n "$CONTEXT" ] && TASK_MESSAGE="${TASK_MESSAGE}\n\nAdditional context: ${CONTEXT}"
  [ -n "$DEADLINE_HINT" ] && TASK_MESSAGE="${TASK_MESSAGE}\n\n**Deadline hint**: ${DEADLINE_HINT}"
  TASK_MESSAGE="${TASK_MESSAGE}\n\n---\nWhen done, report back using: bash ${CREWLY_ROOT}/config/skills/agent/core/report-status/execute.sh '{\"sessionName\":\"${TO}\",\"status\":\"done\",\"summary\":\"<brief summary>\",\"projectPath\":\"${PROJECT_PATH}\"}'"
  TASK_MESSAGE="${TASK_MESSAGE}\n\nBefore reporting done, persist key findings using: bash ${CREWLY_ROOT}/config/skills/agent/core/remember/execute.sh '{\"agentId\":\"${TO}\",\"content\":\"<key findings>\",\"category\":\"pattern\",\"scope\":\"project\",\"projectPath\":\"${PROJECT_PATH}\"}'"
else
  # Legacy free-text format (backwards compatible)
  TASK_MESSAGE="New task from orchestrator (priority: ${PRIORITY}):\n\n${TASK}"
  [ -n "$CONTEXT" ] && TASK_MESSAGE="${TASK_MESSAGE}\n\nContext: ${CONTEXT}"
  TASK_MESSAGE="${TASK_MESSAGE}\n\nWhen done, report back using: bash ${CREWLY_ROOT}/config/skills/agent/core/report-status/execute.sh '{\"sessionName\":\"${TO}\",\"status\":\"done\",\"summary\":\"<brief summary>\",\"projectPath\":\"${PROJECT_PATH}\"}'"
  TASK_MESSAGE="${TASK_MESSAGE}\n\nBefore reporting done, persist key findings using: bash ${CREWLY_ROOT}/config/skills/agent/core/remember/execute.sh '{\"agentId\":\"${TO}\",\"content\":\"<key findings>\",\"category\":\"pattern\",\"scope\":\"project\",\"projectPath\":\"${PROJECT_PATH}\"}'"
fi

# --- Create WorkItem in TaskPool ---
# The Reconciler will detect the queued WorkItem, wake the target agent,
# and the auto-claim service will deliver the task. No direct PTY delivery
# or auto-monitoring needed — the Reconciler handles lifecycle and retries.

# Map priority to WorkItem format
WI_PRIORITY="medium"
case "$PRIORITY" in
  critical|urgent) WI_PRIORITY="critical" ;;
  high)            WI_PRIORITY="high" ;;
  low)             WI_PRIORITY="low" ;;
  *)               WI_PRIORITY="medium" ;;
esac

WI_TITLE="${TITLE:-$(echo "$TASK" | head -c 200)}"

# Per spec 2026-05-06-task-management-v1-deprecation.md, the long-form task
# body now travels with the WorkItem (`briefMarkdown` field) instead of being
# written to a `.crewly/tasks/delegated/*.md` file. `description` keeps the
# legacy short-summary semantics (callers truncate to 500 chars); the full
# brief lives in `briefMarkdown`.
POOL_BODY=$(jq -n \
  --arg type "delegate" \
  --arg owner "orchestrator" \
  --arg target "$TO" \
  --arg title "$WI_TITLE" \
  --arg description "$TASK_MESSAGE" \
  --arg briefMarkdown "$TASK" \
  --arg priority "$WI_PRIORITY" \
  --arg projectPath "${PROJECT_PATH:-}" \
  --arg requestId "${REQUEST_ID:-}" \
  '{type: $type, owner: $owner, target: $target, title: $title, description: $description, briefMarkdown: $briefMarkdown, priority: $priority} + (if $projectPath != "" then {projectPath: $projectPath} else {} end) + (if $requestId != "" then {requestId: $requestId} else {} end)')

# Pipeline-#4 fix (spec 2026-05-05-request-decompose-pipeline-gap.md, Patch B):
# Route is /api/task-pool/add (not /api/pool/add — that endpoint does not exist
# and previously returned 404, silently swallowed by the || fallback below).
POOL_RESULT=$(api_call POST "/task-pool/add" "$POOL_BODY" 2>/dev/null || echo '{"success":false}')
POOL_OK=$(echo "$POOL_RESULT" | jq -r '.success // "false"' 2>/dev/null)
WI_ID=$(echo "$POOL_RESULT" | jq -r '.data.id // .workItemId // empty' 2>/dev/null || true)

if [ "$POOL_OK" != "true" ]; then
  echo "{\"error\":\"Failed to create WorkItem in TaskPool\",\"details\":$(echo "$POOL_RESULT" | jq -c . 2>/dev/null || echo '{}')}"
  exit 1
fi

# --- Immediate claim transition (self-heal fix #1) ---
# Force `queued → running` at dispatch time so the WI doesn't rot in
# queued waiting for a pull that may never come. The 2026-05-20 ESTestNode
# incident (WI d705bfe0) revealed the gap: addToPool succeeded, the
# message was delivered to Sora's PTY, but the WI stayed `queued` for
# >1h because no caller transitioned the status. The Reconciler logged
# it as stale but its eviction path only handles `suspended/inactive`
# agents (not `active-but-idle`), so the work never made progress.
#
# Mirrors what `index.ts:queueProcessorService.setTaskPoolRouter` does
# for [TASK]-prefixed message dispatch — claimFromPool runs immediately
# after addToPool. The skill path now matches that contract.
#
# Failure is non-fatal: if claim fails (race, target locked, etc.) the
# WI stays queued and the Reconciler + AutoClaim will retry the legacy
# way. We log the failure so it's grep-able but don't block dispatch.
if [ -n "$WI_ID" ] && [ -n "$TO" ]; then
  CLAIM_BODY=$(jq -n --arg agentId "$TO" --arg workItemId "$WI_ID" \
    '{agentId: $agentId, workItemId: $workItemId}')
  CLAIM_RESULT=$(api_call POST "/task-pool/claim" "$CLAIM_BODY" 2>/dev/null || echo '{"success":false}')
  CLAIM_OK=$(echo "$CLAIM_RESULT" | jq -r '.success // "false"' 2>/dev/null)
  if [ "$CLAIM_OK" != "true" ]; then
    echo "warn: WorkItem $WI_ID created but immediate claim for $TO failed — falling back to async claim path" >&2
  fi
fi

# --- Fallback trigger (self-heal fix #3) ---
# Per orchestrator prompt §3.0 every dispatch must close the loop with
# BOTH signals: (a) idle-event subscription, AND (b) fallback timer at
# 2× ETA. The agent:idle subscription is set elsewhere (tool-registry
# delegate_task auto-attach); this block enforces the timer half.
#
# Encoded as a /triggers POST that creates a self-targeted delegate WI
# at fire time, which surfaces "WI <id> dispatched to <target> N min
# ago — verify status" back into orc's pool. orc's normal dispatch loop
# then handles it like any other inbound task.
#
# Caller can override via --fallback-minutes N or disable with
# --fallback-minutes 0.
FALLBACK_TRIGGER_ID=""
if [ -n "$WI_ID" ] && [ "${FALLBACK_MINUTES:-0}" -gt 0 ] 2>/dev/null; then
  # Compute the fireAt timestamp = now + FALLBACK_MINUTES.
  # `date -v+Xm` on macOS, `date -d "+X minutes"` on GNU. Try both;
  # silently skip the fallback if neither shape works rather than
  # blocking the dispatch on a date-format quirk.
  FIRE_AT=""
  FIRE_AT=$(date -u -v+"${FALLBACK_MINUTES}"M +'%Y-%m-%dT%H:%M:%S.000Z' 2>/dev/null || \
             date -u -d "+${FALLBACK_MINUTES} minutes" +'%Y-%m-%dT%H:%M:%S.000Z' 2>/dev/null || \
             echo "")

  if [ -n "$FIRE_AT" ]; then
    FALLBACK_SESSION="${CREWLY_SESSION_NAME:-crewly-orc}"
    TRIGGER_BODY=$(jq -n \
      --arg type "time" \
      --arg fireAt "$FIRE_AT" \
      --arg target "$FALLBACK_SESSION" \
      --arg createdBy "delegate-task" \
      --arg name "fallback-${TO}-${WI_ID:0:8}" \
      --arg title "Fallback check on ${TO} for task ${WI_ID:0:8}" \
      --arg description "Per §3.0: ${FALLBACK_MINUTES}min fallback after dispatch to ${TO}. Check whether ${WI_ID} is making progress — if running but no output, re-prompt; if still queued, re-target or fail-fast." \
      '{
        type: $type,
        config: {type: "time", fireAt: $fireAt},
        action: {createWorkItem: {type: "delegate", owner: "system", target: $target, title: $title, description: $description}},
        createdBy: $createdBy,
        name: $name,
        maxFires: 1
      }')
    TRIGGER_RESULT=$(api_call POST "/triggers" "$TRIGGER_BODY" 2>/dev/null || echo '{"success":false}')
    TRIGGER_OK=$(echo "$TRIGGER_RESULT" | jq -r '.success // "false"' 2>/dev/null)
    if [ "$TRIGGER_OK" = "true" ]; then
      FALLBACK_TRIGGER_ID=$(echo "$TRIGGER_RESULT" | jq -r '.data.id // .triggerId // empty' 2>/dev/null || echo "")
    else
      echo "warn: WorkItem $WI_ID dispatched but fallback timer creation failed — orc's idle subscription is the only safety net" >&2
    fi
  fi
fi

# Output result
CLAIM_STATE=$([ "${CLAIM_OK:-false}" = "true" ] && echo "running" || echo "queued")
if [ "$CLAIM_STATE" = "running" ]; then
  RESULT_MESSAGE="WorkItem created in TaskPool and immediately claimed by target."
else
  RESULT_MESSAGE="WorkItem created in TaskPool (immediate claim failed — Reconciler will retry)."
fi
jq -n \
  --arg workItemId "${WI_ID:-}" \
  --arg target "$TO" \
  --arg priority "$WI_PRIORITY" \
  --arg title "$WI_TITLE" \
  --arg state "$CLAIM_STATE" \
  --arg message "$RESULT_MESSAGE" \
  --arg fallbackTriggerId "${FALLBACK_TRIGGER_ID:-}" \
  --arg fallbackMinutes "${FALLBACK_MINUTES:-0}" \
  '{success: true, workItemId: $workItemId, target: $target, priority: $priority, title: $title, state: $state, message: $message}
   + (if $fallbackTriggerId != "" then {fallbackTriggerId: $fallbackTriggerId, fallbackMinutes: ($fallbackMinutes|tonumber)} else {} end)'
