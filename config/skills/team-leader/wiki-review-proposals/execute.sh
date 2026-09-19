#!/bin/bash
# wiki-review-proposals — list / accept / reject pages that proposed_only roles wrote into
# llm-curated/_proposed/. Canonical roles (team-leader / orchestrator / owner) only.
#
# Usage:
#   bash execute.sh --vault <vault>                                   # list
#   bash execute.sh --vault <vault> --accept llm-curated/_proposed/decisions/x.md
#   bash execute.sh --vault <vault> --reject llm-curated/_proposed/decisions/x.md --reason "duplicate of decisions/y.md"
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

VAULT_PATH=""; ACCEPT=""; REJECT=""; REASON=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --vault|-v) VAULT_PATH="$2"; shift 2 ;;
    --accept) ACCEPT="$2"; shift 2 ;;
    --reject) REJECT="$2"; shift 2 ;;
    --reason|-r) REASON="$2"; shift 2 ;;
    --help|-h)
      cat <<HELP
Usage: execute.sh --vault <vault> [--accept <proposed page> | --reject <proposed page> --reason "<why>"]
Without --accept/--reject: lists pending proposals.
HELP
      exit 0 ;;
    *) error_exit "Unknown argument: $1" ;;
  esac
done
require_param "vaultPath (--vault)" "$VAULT_PATH"
export _WP_V="$VAULT_PATH"
if [ -n "$ACCEPT" ]; then
  export _WP_P="$ACCEPT"
  api_call POST "/wiki/proposals/accept" "$(jq -n '{vaultPath: env._WP_V, proposedPath: env._WP_P}')"
elif [ -n "$REJECT" ]; then
  export _WP_P="$REJECT" _WP_R="$REASON"
  api_call POST "/wiki/proposals/reject" "$(jq -n '{vaultPath: env._WP_V, proposedPath: env._WP_P, reason: env._WP_R}')"
else
  api_call GET "/wiki/proposals?vaultPath=$(printf '%s' "$VAULT_PATH" | jq -sRr @uri)"
fi
unset _WP_V _WP_P _WP_R
