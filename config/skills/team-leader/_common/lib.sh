#!/usr/bin/env bash
# Team Leader Skills Common Library - delegates to shared library
SHARED_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/_common"
source "${SHARED_LIB_DIR}/lib.sh"

# tl_require_member_scope <team-json> <member-id> <tl-member-id>
#
# Exits with an error unless the team lead may start or stop the member.
# Allowed when:
#   1. the member reports to this lead (parentMemberId == tlMemberId), or
#   2. the member has no parent at all, and this lead is a leader of the same
#      team (listed in leaderIds/leaderId, or canDelegate on its member record).
# Refused: members of another team (not in <team-json>), members whose parent
# is someone else, and any lead that does not lead this team.
#
# Rule 2 exists because many teams were created without a hierarchy: every
# Marketing member had parentMemberId=null, so the lead could not start a
# single one of its own members and the orchestrator had to (#930).
tl_require_member_scope() {
  local team_json="$1" member_id="$2" tl_member_id="$3"
  local verdict
  verdict=$(printf '%s' "$team_json" | jq -r --arg mid "$member_id" --arg tl "$tl_member_id" '
    (.data // .) as $team
    | ($team.members // []) as $members
    | ($members | map(select(.id == $mid)) | first) as $member
    | ($members | map(select(.id == $tl)) | first) as $lead
    | (($team.leaderIds // []) + (if $team.leaderId then [$team.leaderId] else [] end)) as $leaders
    | if $member == null then "not_found"
      elif ($member.parentMemberId // "") == $tl then "ok"
      elif ($member.parentMemberId // "") != "" then "other_parent:" + $member.parentMemberId
      elif $lead == null then "not_in_team"
      elif (($leaders | index($tl)) != null) or ($lead.canDelegate == true) then "ok"
      else "not_leader"
      end' 2>/dev/null || echo "unreadable")

  case "$verdict" in
    ok) return 0 ;;
    not_found)
      error_exit "Member ${member_id} is not in this team. A team lead can only start or stop members of its own team." ;;
    other_parent:*)
      error_exit "Hierarchy violation: member ${member_id} (parentMemberId=${verdict#other_parent:}) reports to someone else, not to TL ${tl_member_id}" ;;
    not_in_team)
      error_exit "TL ${tl_member_id} is not a member of this team, so it cannot manage member ${member_id}" ;;
    not_leader)
      error_exit "Member ${member_id} has no parent, and TL ${tl_member_id} does not lead this team (not in leaderIds, canDelegate not set)" ;;
    *)
      error_exit "Could not read the team data to check whether TL ${tl_member_id} may manage member ${member_id}" ;;
  esac
}
