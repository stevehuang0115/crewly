#!/bin/bash
# =============================================================================
# Class guard: no dangling symlinks anywhere under config/skills/
#
# A dangling symlink is worse than a missing file. `ls` shows the entry, the
# path matches the naming pattern of its neighbours, and nothing fails until
# someone runs it — at which point the error ("No such file or directory")
# points at the LINK TARGET, not at the fact that the link itself is wrong.
#
# The instance that motivated this: config/skills/agent/core/delegate-task/
# execute.sh was a symlink to ../../../../team-leader/delegate-task/execute.sh
# — one `../` too many. Four levels up from that directory is `config/`, not
# `config/skills/`, so it targeted config/team-leader/... which does not exist.
# It sat broken long enough to produce a recorded onboarding gotcha (a TL agent
# taking that path and self-correcting) and, later, a wrong conclusion in a PR
# review (that fixing the team-leader file fixed both call paths — it did not,
# because this path was broken outright).
#
# It surfaced only because an unrelated scanner CRASHED on it while walking the
# tree. Nothing was watching for it. This test watches for it.
#
# Test runner:
#   bash config/skills/_common/no-dangling-symlinks.test.sh
#   echo $?    # 0 on pass, 1 on fail
# =============================================================================
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
SKILLS_DIR="${REPO_ROOT}/config/skills"

echo "=== no dangling symlinks under config/skills/ ==="

if [ ! -d "$SKILLS_DIR" ]; then
  echo "  ✗ skills directory not found: ${SKILLS_DIR}"
  exit 1
fi

# `-type l` finds symlinks; `! -exec test -e {} \;` keeps only those whose
# target does not resolve. Both BSD (macOS) and GNU find support this form.
DANGLING=$(find "$SKILLS_DIR" -type l ! -exec test -e {} \; -print 2>/dev/null || true)

if [ -n "$DANGLING" ]; then
  COUNT=$(printf '%s\n' "$DANGLING" | grep -c . || true)
  echo "  ✗ ${COUNT} dangling symlink(s) found:"
  while IFS= read -r link; do
    [ -z "$link" ] && continue
    REL="${link#${REPO_ROOT}/}"
    echo "      ${REL}"
    echo "        -> $(readlink "$link") (does not resolve)"
  done <<< "$DANGLING"
  echo ""
  echo "    A dangling symlink LOOKS like a real path and fails only on use."
  echo "    Either point it at a file that exists, or remove it so the path"
  echo "    fails honestly. Do not leave it in the middle state."
  exit 1
fi

TOTAL_LINKS=$(find "$SKILLS_DIR" -type l 2>/dev/null | grep -c . || true)
echo "  ✓ no dangling symlinks (${TOTAL_LINKS} symlink(s) checked)"
echo ""
echo "=== Results: 1 passed, 0 failed ==="
exit 0
