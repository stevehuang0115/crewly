#!/bin/bash
# =============================================================================
# poll_types_for_role — default WorkItem types a role may claim in poll-tasks.
#
# Sourced by execute.sh and by execute.test.sh (the test used to keep its own
# copy of this table, so it could never fail when the real one was wrong).
# Role strings are the directory names under config/roles plus the legacy
# spellings still found in team configs.
# =============================================================================
poll_types_for_role() {
  case "${1:-}" in
    developer|backend-developer|frontend-developer|fullstack-dev|qa|qa-engineer|architect|auditor)
      echo "delegate,project_task,review" ;;
    researcher|analyst)
      echo "delegate,check,review" ;;
    team_lead|team-lead|team-leader|tpm|product-manager)
      # Leads receive verify/review items and check items for their workers.
      echo "delegate,project_task,review,check" ;;
    *)
      echo "delegate,project_task" ;;
  esac
}
