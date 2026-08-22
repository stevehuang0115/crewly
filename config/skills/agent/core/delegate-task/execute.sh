#!/bin/bash
# =============================================================================
# NOT A SKILL — a signpost.
#
# `delegate-task` does not live here. It is a TEAM LEADER skill:
#
#     config/skills/team-leader/delegate-task/execute.sh
#
# This path exists because agents reach for it. Every other core skill lives at
# config/skills/agent/core/<name>/execute.sh, so the pattern predicts a
# delegate-task here, and project memory records at least one TL agent taking
# that path and having to self-correct.
#
# It used to be a symlink — and a BROKEN one: it pointed at
# ../../../../team-leader/delegate-task/execute.sh, which is one `../` too many
# (four levels up from here is `config/`, not `config/skills/`). So it resolved
# to config/team-leader/delegate-task/execute.sh, which does not exist.
# `test -e` failed and running it printed "No such file or directory".
#
# That is the worst of the three states: `ls` showed a delegate-task directory
# containing an execute.sh, so the path LOOKED real to anyone browsing, and
# failed only on use.
#
# WHY A SIGNPOST RATHER THAN A REPAIRED SYMLINK
#
# Repairing the link would work, but it would create a SECOND working entry
# point to one skill. Two paths to one implementation is the drift shape this
# codebase keeps paying for — the hand-copied mock in the TL delegate-task
# test, the template copies of norms. Anyone editing or testing delegate-task
# would have to remember both. There are zero callers of this path, so there is
# nothing to preserve by making it work.
#
# So: one canonical implementation, and a path that fails loudly and tells you
# where to go. Same disposition as the `skipGates` rejection (#742) and the
# `block-task` status pre-check (#747): reject, and name the remedy.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_SKILL="$(cd "${SCRIPT_DIR}/../../.." && pwd)/team-leader/delegate-task/execute.sh"

cat >&2 <<EOF_MSG
{"error":"delegate-task is a TEAM LEADER skill and does not live under agent/core. Use: ${REAL_SKILL}","correctPath":"config/skills/team-leader/delegate-task/execute.sh","calledPath":"config/skills/agent/core/delegate-task/execute.sh"}
EOF_MSG

exit 1
