#!/usr/bin/env bash
# Crewly control-plane guard — Claude Code PreToolUse hook for the Bash tool.
#
# Spec: specs/2026-09-24-control-plane-isolation.md, Part 3 item 3.
#
# Usage (wired by the backend through `claude --settings <file>`):
#   bash pretooluse-bash.sh <protected-paths-file>   # PreToolUse JSON on stdin
#
# The paths file holds one absolute path per line (a file, or a directory
# whose whole subtree is protected). Lines starting with '#' are ignored.
#
# Blocks a Bash command that WRITES a protected path. It looks for:
#   - redirection onto the path            (>, >>, >|)
#   - a mutating verb whose arguments name it
#         rm rmdir unlink chmod chown chgrp truncate touch tee mv shred
#   - in-place editors                     (sed -i, perl -i, gsed -i)
#   - copy/link onto it as the destination (cp ln install rsync: last argument)
#   - dd of=<path>
#   - git checkout/restore/rm/mv/apply naming it
# Reads (cat, grep, jq, head, ls, cp FROM the path, ...) stay allowed.
#
# Exit codes follow the Claude Code hook contract:
#   0  allowed (stdout: what was checked)
#   2  blocked (stderr: the rule and path that matched, fed back to the agent)
#   1  guard could not check anything (no paths loaded). This is a non-blocking
#      error, never a silent pass (team norm: a guard reports what it examined).
#
# Coverage limits, stated so a clean result is not over-read:
#   - an interpreter one-liner (python -c, node -e) that writes the path is NOT seen
#   - a path built at runtime (variables other than $HOME, cd + relative path
#     from a different directory, globs, base64) is NOT seen
#   - calls to the loopback API are NOT seen

set -u

PATHS_FILE="${1:-}"
PREFIX="control-plane-guard:"

INPUT="$(cat)"

if ! command -v jq >/dev/null 2>&1; then
  echo "$PREFIX jq not found — 0 protected path(s) checked, guard inactive for this call" >&2
  exit 1
fi

TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)"
COMMAND="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)"
CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)"

if [ "$TOOL_NAME" != "Bash" ]; then
  echo "$PREFIX not a Bash call (${TOOL_NAME:-unknown}) — nothing to check"
  exit 0
fi

# ---- load protected paths -------------------------------------------------
PROTECTED=()
if [ -n "$PATHS_FILE" ] && [ -f "$PATHS_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    PROTECTED+=("${line%/}")
  done < "$PATHS_FILE"
fi

if [ "${#PROTECTED[@]}" -eq 0 ]; then
  echo "$PREFIX NO PATHS CHECKED — protected-paths file missing or empty (${PATHS_FILE:-<none>}); refusing to report this command as safe" >&2
  exit 1
fi

# ---- normalise the command ------------------------------------------------
# Expand the home forms an agent would type, and drop quotes so a quoted
# path compares equal to a bare one.
NORM="$COMMAND"
HOME_DIR="${HOME:-}"
if [ -n "$HOME_DIR" ]; then
  NORM="${NORM//\$\{HOME\}/$HOME_DIR}"
  NORM="${NORM//\$HOME/$HOME_DIR}"
  NORM="${NORM//\~\//$HOME_DIR/}"
fi
NORM="${NORM//\"/}"
NORM="${NORM//\'/}"

# Split into simple-command segments on ; & | and newlines. A segment keeps
# its own redirections, so `cat f > /tmp/x` and `echo x > f` are judged apart.
# Pure bash (BSD sed has no \n in replacements). The redirection operators
# that contain & or | (>&, &>, >|) are shielded first so they are not split.
NL=$'\n'
SPLIT="$NORM"
SPLIT="${SPLIT//>|/__CPG_GT_PIPE__}"
SPLIT="${SPLIT//>&/__CPG_GT_AMP__}"
SPLIT="${SPLIT//&>/__CPG_AMP_GT__}"
SPLIT="${SPLIT//;/$NL}"
SPLIT="${SPLIT//|/$NL}"
SPLIT="${SPLIT//&/$NL}"
SPLIT="${SPLIT//__CPG_GT_PIPE__/>|}"
SPLIT="${SPLIT//__CPG_GT_AMP__/>&}"
SPLIT="${SPLIT//__CPG_AMP_GT__/&>}"
SEGMENTS=()
while IFS= read -r seg; do
  [ -n "${seg//[[:space:]]/}" ] && SEGMENTS+=("$seg")
done <<< "$SPLIT"

# Forms of a protected path that a command might contain: the absolute path,
# and when it sits under the call's cwd, the cwd-relative path (with and
# without a leading ./).
path_forms() {
  local p="$1"
  printf '%s\n' "$p"
  if [ -n "$CWD" ] && [ "${p#"${CWD%/}"/}" != "$p" ]; then
    local rel="${p#"${CWD%/}"/}"
    printf '%s\n' "$rel"
    printf '%s\n' "./$rel"
  fi
}

# word_hits WORD FORM — true when WORD names FORM itself or something under it.
word_hits() {
  local w="$1" f="$2"
  [ "$w" = "$f" ] && return 0
  case "$w" in "$f"/*) return 0 ;; esac
  return 1
}

# segment_writes SEGMENT FORM — prints the matched rule and returns 0 when the
# segment writes FORM.
segment_writes() {
  local seg="$1" f="$2"

  # 1. redirection targets
  local rest="$seg" t word
  while [ "${rest#*>}" != "$rest" ]; do
    rest="${rest#*>}"
    t="${rest#[>|]}"
    t="${t#"${t%%[![:space:]]*}"}"
    word="${t%%[[:space:]]*}"
    if [ -n "$word" ] && word_hits "$word" "$f"; then
      echo "redirection '>' onto it"; return 0
    fi
  done

  # 2. verbs — strip the redirections, then word-split
  local plain
  plain="$(printf '%s' "$seg" | sed -E 's/[0-9]*>[>|]?[[:space:]]*[^[:space:]]+//g')"
  local -a words
  read -r -a words <<< "$plain"
  [ "${#words[@]}" -eq 0 ] && return 1

  local i=0
  while [ "$i" -lt "${#words[@]}" ]; do
    case "${words[$i]}" in
      *=*|sudo|command|env|nohup|time|xargs|exec) i=$((i+1)) ;;
      *) break ;;
    esac
  done
  [ "$i" -ge "${#words[@]}" ] && return 1
  local verb="${words[$i]##*/}"
  local -a args=("${words[@]:$((i+1))}")
  [ "${#args[@]}" -eq 0 ] && return 1

  local a any=1
  for a in "${args[@]}"; do
    if word_hits "$a" "$f"; then any=0; break; fi
  done

  case "$verb" in
    rm|rmdir|unlink|chmod|chown|chgrp|truncate|touch|tee|mv|shred)
      [ "$any" -eq 0 ] && { echo "'$verb' on it"; return 0; } ;;
    sed|gsed|perl)
      if [ "$any" -eq 0 ]; then
        for a in "${args[@]}"; do
          case "$a" in -i*|--in-place*|-pi*|-*i) echo "'$verb -i' (in-place edit) on it"; return 0 ;; esac
        done
      fi ;;
    cp|ln|install|rsync|scp)
      local last="${args[$((${#args[@]}-1))]}"
      word_hits "$last" "$f" && { echo "'$verb' with it as the destination"; return 0; } ;;
    dd)
      for a in "${args[@]}"; do
        case "$a" in of=*) word_hits "${a#of=}" "$f" && { echo "'dd of=' onto it"; return 0; } ;; esac
      done ;;
    git)
      if [ "$any" -eq 0 ]; then
        for a in "${args[@]}"; do
          case "$a" in checkout|restore|rm|mv|apply) echo "'git $a' on it"; return 0 ;; esac
        done
      fi ;;
  esac
  return 1
}

# ---- check every protected path -------------------------------------------
CHECKED=0
for p in "${PROTECTED[@]}"; do
  CHECKED=$((CHECKED+1))
  while IFS= read -r form; do
    case "$NORM" in *"$form"*) ;; *) continue ;; esac
    for seg in "${SEGMENTS[@]}"; do
      case "$seg" in *"$form"*) ;; *) continue ;; esac
      if rule="$(segment_writes "$seg" "$form")"; then
        {
          echo "$PREFIX BLOCKED — matched $rule: $p"
          echo "$PREFIX checked ${#PROTECTED[@]} protected path(s); command segment: ${seg}"
          echo "Stopping, restarting and reconfiguring agents is routine operations, and the files that do it are changed by the Crewly backend, not by agent sessions. Reading them is fine. If the owner asked for this change in the current task, tell them and ask them to make it."
        } >&2
        exit 2
      fi
    done
  done < <(path_forms "$p")
done

echo "$PREFIX allowed — no write to a protected path matched; ${CHECKED} protected path(s) checked"
exit 0
