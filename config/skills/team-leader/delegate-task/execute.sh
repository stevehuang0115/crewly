#!/bin/bash
# Delegate a task to a worker within this Team Leader's subordinate scope.
# Validates hierarchy (worker.parentMemberId == TL.memberId) before delegation.
# Reuses the orchestrator delegate-task delivery and monitoring logic.
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
TEAM_ID=""
TL_MEMBER_ID=""
FROM_SESSION=""

# Detect legacy JSON argument
if [[ $# -gt 0 && ${1:0:1} == '{' ]]; then
  INPUT_JSON="$1"
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --to|-t)       TO="$2";            shift 2 ;;
    --task|-T)     TASK="$2";           shift 2 ;;
    --task-file)   TASK="$(cat "$2")";  shift 2 ;;
    --priority|-P) PRIORITY="$2";       shift 2 ;;
    --context|-c)  CONTEXT="$2";        shift 2 ;;
    --project|-p)  PROJECT_PATH="$2";   shift 2 ;;
    --team|-g)     TEAM_ID="$2";        shift 2 ;;
    --tl-member)   TL_MEMBER_ID="$2";   shift 2 ;;
    --from)        FROM_SESSION="$2";   shift 2 ;;
    --json|-j)     INPUT_JSON="$2";     shift 2 ;;
    --help|-h)
      echo "Usage: execute.sh --to worker-session --task 'implement feature' --priority high --project /path [--team teamId] [--tl-member memberId]"
      exit 0
      ;;
    --)            shift; break ;;
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
INPUT="{}"
if [ -n "$INPUT_JSON" ]; then
  INPUT=$(read_json_input "$INPUT_JSON")
  [ -z "$TO" ] && TO=$(printf '%s' "$INPUT" | jq -r '.to // empty')
  [ -z "$TASK" ] && TASK=$(printf '%s' "$INPUT" | jq -r '.task // empty')
  [ "$PRIORITY" = "normal" ] && { P=$(printf '%s' "$INPUT" | jq -r '.priority // empty'); [ -n "$P" ] && PRIORITY="$P"; }
  [ -z "$CONTEXT" ] && CONTEXT=$(printf '%s' "$INPUT" | jq -r '.context // empty')
  [ -z "$PROJECT_PATH" ] && PROJECT_PATH=$(printf '%s' "$INPUT" | jq -r '.projectPath // empty')
  [ -z "$TEAM_ID" ] && TEAM_ID=$(printf '%s' "$INPUT" | jq -r '.teamId // empty')
  [ -z "$TL_MEMBER_ID" ] && TL_MEMBER_ID=$(printf '%s' "$INPUT" | jq -r '.tlMemberId // empty')
  [ -z "$FROM_SESSION" ] && FROM_SESSION=$(printf '%s' "$INPUT" | jq -r '.fromSession // empty')
fi

require_param "to (--to)" "$TO"
require_param "task (--task)" "$TASK"

# Request Contract check (P0-3): non-fatal warning when the delegated brief
# is missing Goal / Expected Outcome / Eval Criteria markers. Workers are
# entitled to push back per the Brief Reception Protocol when these are
# absent. Spec: .crewly/specs/2026-05-03-agent-improvement-p0-execution.md
# §"Fix P0-3".
#
# Scans the WHOLE delegated brief, not just `--task`. The Request Contract
# can legitimately live in `--task`, in `--context`, or be split across the
# two, and delegators routinely put the long-form G/O/E in `--context` while
# `--task` carries the one-line ask. Scanning only `--task` warned
# "Request Contract incomplete" at briefs whose contract was fully present,
# just in the other field. That false positive is corrosive: this warning is
# the signal workers use to decide whether to push back under the Brief
# Reception Protocol, so crying wolf trains them to ignore a real one.
#
# The check is NOT weakened — a marker genuinely absent from BOTH fields
# still warns, and the missing-field list is still per-marker.
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
  # Goal: the standalone word "Goal" (with optional ** markdown). Also
  # accept "Objective" as a synonym some upstream callers use.
  if ! echo "$brief" | grep -qiE '(^|[^a-zA-Z])(\*\*)?(goal|objective)(:|s?\b)'; then
    missing+=("Goal")
  fi
  # Outcome: "Outcome" or "Expected Outcome".
  if ! echo "$brief" | grep -qiE '(^|[^a-zA-Z])(\*\*)?(expected )?outcome(:|s?\b)'; then
    missing+=("Outcome")
  fi
  # Eval: "Eval", "Eval Criteria", "Acceptance Criteria", "Evaluation Criteria".
  if ! echo "$brief" | grep -qiE '(^|[^a-zA-Z])(\*\*)?(eval|evaluation criteria|acceptance criteria)(:|s?\b)'; then
    missing+=("Eval")
  fi
  if [ ${#missing[@]} -gt 0 ]; then
    local list
    list=$(IFS=, ; echo "${missing[*]}")
    echo "{\"warning\":\"Request Contract incomplete: brief is missing markers for: ${list}. Neither the task nor the context field carries them. Per P0-3 spec, every delegated subtask MUST include Goal + Expected Outcome + Eval Criteria. Workers may push back via the Brief Reception Protocol. Source: .crewly/specs/2026-05-03-agent-improvement-p0-execution.md §Fix P0-3.\"}" >&2
  fi
}

warn_missing_request_contract "$TASK" "$CONTEXT"

# Resolve Crewly root from this script path:
# config/skills/team-leader/delegate-task/execute.sh -> project root
CREWLY_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

# Validate hierarchy: check that target worker belongs to this TL
if [ -n "$TEAM_ID" ] && [ -n "$TL_MEMBER_ID" ]; then
  # Fetch team data to validate hierarchy
  TEAM_DATA=$(api_call GET "/teams/${TEAM_ID}" 2>/dev/null || echo '{}')
  TEAM_SUCCESS=$(echo "$TEAM_DATA" | jq -r '.success // false' 2>/dev/null || echo "false")

  if [ "$TEAM_SUCCESS" = "true" ]; then
    # Find the target worker by session name and check parentMemberId
    WORKER_PARENT=$(echo "$TEAM_DATA" | jq -r --arg session "$TO" \
      '.data.members[] | select(.sessionName == $session) | .parentMemberId // empty' 2>/dev/null || true)

    if [ -n "$WORKER_PARENT" ] && [ "$WORKER_PARENT" != "$TL_MEMBER_ID" ]; then
      error_exit "Hierarchy violation: worker ${TO} (parentMemberId=${WORKER_PARENT}) is not a subordinate of TL ${TL_MEMBER_ID}"
    fi
  fi
fi

# Resolve skill paths to absolute paths
resolve_skill_paths() {
  local input="$1"
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

# Build a structured task message from Team Leader
TASK_MESSAGE="New task from Team Leader (priority: ${PRIORITY}):\n\n**[REQUIRED] When done, you MUST:** (1) Output a text summary of your work, findings, and any issues. (2) Call report-status, passing the workItemId from your [CREWLY-DISPATCH] notice (or from get-my-tasks) so the right WorkItem is closed:\nbash ${CREWLY_ROOT}/config/skills/agent/core/report-status/execute.sh '{\"sessionName\":\"${TO}\",\"workItemId\":\"<your WorkItem id>\",\"status\":\"done\",\"summary\":\"<brief summary>\",\"projectPath\":\"${PROJECT_PATH}\"}'\n\n---\n\n${TASK}"
[ -n "$CONTEXT" ] && TASK_MESSAGE="${TASK_MESSAGE}\n\nContext: ${CONTEXT}"

# V3-only producer (spec 2026-05-06-task-management-v1-deprecation.md):
# We no longer write a `.crewly/tasks/delegated/*.md` file via the legacy
# `/task-management/create` endpoint. Instead the long-form brief travels
# on the WorkItem itself (`briefMarkdown` field) and the WI is the sole
# durable record of this delegation.
#
# ORDERING (WI 65578471): the WorkItem is created BEFORE delivery is
# attempted, and that order is load-bearing. Previously the pool-add ran
# only after delivery succeeded, so a delivery failure exited the script
# with NO RECORD ANYWHERE — not in the pool, not targeted, nothing for a
# reconciler or a human to find. Every other orphan class in this system
# at least left a WorkItem behind; this one left the intent with no system
# of record at all.
#
# On a delivery failure the WI is deliberately left `queued` with its
# `target` set, plus an explicit `[UNDELIVERED]` note (see below). That
# state is chosen, not incidental:
#   - `queued` + `target` is recoverable — the wake gate admits a worker
#     for a queued WI targeting them, so the task can still be delivered.
#   - `queued` is NOT `running`, so it never masquerades as in-flight work.
#   - the note makes an undelivered item distinguishable from a normally
#     queued one, so a silent nothing is not traded for a silent something.
TASK_ID=""

case "$PRIORITY" in
  critical|urgent) WI_PRIORITY="critical" ;;
  high)            WI_PRIORITY="high" ;;
  low)             WI_PRIORITY="low" ;;
  *)               WI_PRIORITY="medium" ;;
esac

WI_TITLE="$(echo "$TASK" | head -c 200)"

POOL_BODY=$(jq -n \
  --arg type "delegate" \
  --arg owner "team_lead" \
  --arg target "$TO" \
  --arg title "$WI_TITLE" \
  --arg description "$TASK_MESSAGE" \
  --arg briefMarkdown "$TASK" \
  --arg priority "$WI_PRIORITY" \
  --arg projectPath "${PROJECT_PATH:-}" \
  '{type: $type, owner: $owner, target: $target, title: $title, description: $description, briefMarkdown: $briefMarkdown, metadata: ({priority: $priority} + (if $projectPath != "" then {projectPath: $projectPath} else {} end))}')

POOL_RESULT=$(api_call POST "/task-pool/add" "$POOL_BODY" 2>/dev/null || echo '{"success":false}')
POOL_OK=$(echo "$POOL_RESULT" | jq -r '.success // "false"' 2>/dev/null)
TASK_ID=$(echo "$POOL_RESULT" | jq -r '.data.id // .workItemId // empty' 2>/dev/null || true)

if [ "$POOL_OK" != "true" ]; then
  # Unchanged from before the reorder: warn and still attempt delivery.
  # Aborting here instead would be a behavioural change beyond this WI's
  # scope, so it is deliberately NOT made. The residual gap (record
  # creation fails, task delivered anyway) is reported, not silently
  # fixed — it is the mirror of the bug fixed here and wants its own call.
  echo "{\"warning\":\"Failed to create WorkItem in TaskPool — delivering anyway, so this task will have no durable record\",\"details\":$(echo "$POOL_RESULT" | jq -c . 2>/dev/null || echo '{}')}" >&2
fi

# Deliver the task message with fallback strategy:
# 1. Try normal delivery (waitForReady)
# 2. If fails, try force delivery
# 3. If still fails, auto-start the worker then retry
# waitTimeout 15000: the INITIAL attempt against a worker expected to be
# already running, so it fails fast and lets the fallback ladder below take
# over. The retry after auto-start uses 30000 — see the note there; the two
# values differ deliberately and must not be normalised to one number.
#
# ORIGIN NOT ESTABLISHED (WI dae79289): 15000 matches no delivery-related
# constant. Seven constants share the value, none of them about terminal
# delivery, so there is nothing here that this literal can honestly be said
# to mirror. Left exactly as-is rather than attached to a plausible-looking
# constant that does not actually govern it.
BODY=$(jq -n --arg message "$TASK_MESSAGE" '{message: $message, waitForReady: true, waitTimeout: 15000}')

DELIVER_OK=true
api_call POST "/terminal/${TO}/deliver" "$BODY" || DELIVER_OK=false

if [ "$DELIVER_OK" = "false" ]; then
  FORCE_BODY=$(jq -n --arg message "$TASK_MESSAGE" '{message: $message, force: true}')
  api_call POST "/terminal/${TO}/deliver" "$FORCE_BODY" || {
    # Worker likely offline — attempt auto-start if we have team context
    STARTED=false
    if [ -n "$TEAM_ID" ]; then
      # Find worker's memberId from team data
      WORKER_MEMBER_ID=""
      if [ -n "$TEAM_DATA" ] && [ "$(echo "$TEAM_DATA" | jq -r '.success // false')" = "true" ]; then
        WORKER_MEMBER_ID=$(echo "$TEAM_DATA" | jq -r --arg session "$TO" \
          '.data.members[] | select(.sessionName == $session) | .id // empty' 2>/dev/null || true)
      else
        # Fetch team data if not already loaded
        TEAM_DATA=$(api_call GET "/teams/${TEAM_ID}" 2>/dev/null || echo '{}')
        WORKER_MEMBER_ID=$(echo "$TEAM_DATA" | jq -r --arg session "$TO" \
          '.data.members[] | select(.sessionName == $session) | .id // empty' 2>/dev/null || true)
      fi

      if [ -n "$WORKER_MEMBER_ID" ]; then
        echo '{"info":"Worker '"$TO"' appears offline — auto-starting..."}' >&2
        START_RESULT=$(api_call POST "/teams/${TEAM_ID}/members/${WORKER_MEMBER_ID}/start" '{}' 2>/dev/null || true)
        START_OK=$(echo "$START_RESULT" | jq -r '.success // false' 2>/dev/null || echo "false")

        if [ "$START_OK" = "true" ]; then
          echo '{"info":"Worker '"$TO"' start triggered — retrying delivery in 10s..."}' >&2
          sleep 10
          # Retry delivery after agent boots
          # waitTimeout 30000, double the initial 15000 above. This retry
          # follows an auto-start, so the worker is booting from cold and
          # legitimately needs longer to reach a prompt than one that was
          # expected to be up already. The asymmetry is the point: it is not
          # drift between two copies of the same call.
          #
          # ORIGIN NOT ESTABLISHED (WI dae79289): the value coincides with
          # EVENT_DELIVERY_CONSTANTS.TOTAL_DELIVERY_TIMEOUT, but coincidence
          # of value is not evidence of relationship — eleven constants share
          # 30000. Not claimed as a mirror.
          RETRY_BODY=$(jq -n --arg message "$TASK_MESSAGE" '{message: $message, waitForReady: true, waitTimeout: 30000}')
          api_call POST "/terminal/${TO}/deliver" "$RETRY_BODY" && STARTED=true || {
            # Final fallback: force deliver
            api_call POST "/terminal/${TO}/deliver" "$FORCE_BODY" && STARTED=true || true
          }
        fi
      fi
    fi

    if [ "$STARTED" = "false" ]; then
      # WI 65578471 — delivery failed, but the WorkItem already exists
      # (created above, deliberately, before delivery was attempted). Mark
      # it explicitly so an undelivered item is never mistaken for a
      # normally queued one, then fail loudly. The WI stays `queued` with
      # its `target`, which is the recoverable state: the worker can still
      # be woken for it and re-delivery can be retried.
      #
      # Best-effort: a failure to annotate must not swallow the delivery
      # error, which is the more important signal.
      if [ -n "$TASK_ID" ]; then
        NOTE_AUTHOR="${CREWLY_SESSION_NAME:-${FROM_SESSION:-team-leader}}"
        NOTE_BODY=$(jq -n --arg author "$NOTE_AUTHOR" --arg note "[UNDELIVERED] Delivery to ${TO} failed — worker offline and could not be auto-started. WorkItem left queued and targeted for re-delivery." \
          '{author: $author, note: $note}')
        api_call POST "/task-pool/items/${TASK_ID}/notes" "$NOTE_BODY" >/dev/null 2>&1 || true
      fi
      echo '{"error":"Failed to deliver task to '"$TO"'. Worker is offline and could not be auto-started. Ensure the worker is a team member with a valid session.","to":"'"$TO"'","teamId":"'"$TEAM_ID"'","workItemId":"'"$TASK_ID"'","workItemState":"queued+targeted, marked [UNDELIVERED] — re-delivery can be retried"}'
      exit 1
    fi
  }
fi


# Set up idle event subscription for TL monitoring
MONITOR_IDLE=$(printf '%s' "$INPUT" | jq -r 'if .monitor.idleEvent == null then true else .monitor.idleEvent end')
MONITOR_FALLBACK_MINUTES=$(printf '%s' "$INPUT" | jq -r 'if .monitor.fallbackCheckMinutes == null then 5 else .monitor.fallbackCheckMinutes end')

COLLECTED_SCHEDULE_IDS="[]"
COLLECTED_SUBSCRIPTION_IDS="[]"

# Resolve the delegating TL's session name for event/schedule routing.
# Priority: (1) CREWLY_SESSION_NAME env var, (2) fromSession in input JSON.
# If neither is available, skip monitoring gracefully instead of crashing.
RESOLVED_SESSION="${CREWLY_SESSION_NAME:-${FROM_SESSION:-}}"

if [ -z "$RESOLVED_SESSION" ]; then
  echo '{"warning":"CREWLY_SESSION_NAME not set and no fromSession provided — skipping idle event and schedule monitoring. Delegation still proceeds."}' >&2
fi

if [ "$MONITOR_IDLE" = "true" ] && [ -n "$RESOLVED_SESSION" ]; then
  # ttlMinutes is deliberately OMITTED so the server default applies.
  #
  # This used to hardcode `ttlMinutes: 120`, silently capping every delegation
  # subscription at 2h against a system default of 8h
  # (EVENT_BUS_CONSTANTS.DEFAULT_SUBSCRIPTION_TTL_MINUTES = 480, applied by
  # event-bus.service.ts via `input.ttlMinutes ?? DEFAULT`). A subscription
  # that expires 6h early stops the TL ever being woken for a long-running
  # delegation — the same failure shape as a lease lapsing under an agent that
  # is simply heads-down.
  #
  # Omitting beats re-hardcoding 480: the constant stays the single source of
  # truth and the skill cannot drift from it again.
  SUB_BODY=$(jq -n \
    --arg eventType "agent:idle" \
    --arg sessionName "$TO" \
    --arg subscriber "$RESOLVED_SESSION" \
    '{eventType: $eventType, filter: {sessionName: $sessionName}, subscriberSession: $subscriber, oneShot: true}')
  SUB_RESULT=$(api_call POST "/events/subscribe" "$SUB_BODY" 2>/dev/null || true)
  SUB_ID=$(echo "$SUB_RESULT" | jq -r '.data.id // empty' 2>/dev/null || true)
  if [ -n "$SUB_ID" ]; then
    COLLECTED_SUBSCRIPTION_IDS=$(echo "$COLLECTED_SUBSCRIPTION_IDS" | jq --arg id "$SUB_ID" '. + [$id]')
  fi
fi

if [ "$MONITOR_FALLBACK_MINUTES" != "0" ] && [ -n "$MONITOR_FALLBACK_MINUTES" ] && [ -n "$RESOLVED_SESSION" ]; then
  SCHED_BODY=$(jq -n \
    --arg target "$RESOLVED_SESSION" \
    --arg minutes "$MONITOR_FALLBACK_MINUTES" \
    --arg message "TL progress check: review ${TO} status — task: ${TASK:0:100}" \
    --arg taskId "$TASK_ID" \
    '{targetSession: $target, minutes: ($minutes | tonumber), intervalMinutes: ($minutes | tonumber), message: $message, isRecurring: true} + (if $taskId != "" then {taskId: $taskId} else {} end)' 2>/dev/null) || true
  [ -n "$SCHED_BODY" ] && SCHED_RESULT=$(api_call POST "/schedule" "$SCHED_BODY" 2>/dev/null || true)
  SCHED_ID=$(echo "$SCHED_RESULT" | jq -r '.checkId // .data.checkId // empty' 2>/dev/null || true)
  if [ -n "$SCHED_ID" ]; then
    COLLECTED_SCHEDULE_IDS=$(echo "$COLLECTED_SCHEDULE_IDS" | jq --arg id "$SCHED_ID" '. + [$id]')
  fi
fi

# Monitoring-id bookkeeping (cron/subscription cleanup) used to flow through
# `/task-management/add-monitoring`, which is gone as of spec
# 2026-05-06-task-management-v1-deprecation.md. Cron and subscription
# lifecycles are owned by `/cron/*` and `/subscriptions/*` respectively;
# the WI itself carries no association beyond `target`. No-op here.
:
