#!/usr/bin/env bash
# F-CYCLE7-1 native-binding audit.
#
# Lists every `.node` addon under node_modules/, reports the binary's
# CPU/arch, and classifies each entry as:
#
#   PASS — loadable on this host's `process.arch`
#   FAIL — built for the wrong arch and would dlopen-fail at runtime
#   SKIP — cross-arch sibling package (npm installs e.g.
#          `@img/sharp-darwin-x64` alongside `@img/sharp-darwin-arm64`;
#          the wrong-arch sibling is never loaded by the runtime selector
#          on this host so its arch is irrelevant)
#
# Exit code = number of FAIL hits. CI / pre-deploy can gate on this.
#
# Usage:
#   ./scripts/audit-native-bindings.sh                    # uses ./node_modules
#   ./scripts/audit-native-bindings.sh path/to/node_modules
#
# Why this exists: 2026-05-07 audit §2.1 — `better-sqlite3` was built
# for x86_64 on an arm64 host. ChatGateway swallowed the dlopen failure
# in a try/catch and silently downgraded chat persistence to a
# JSON-file fallback, so `chat.db` went stale for 4 days unnoticed.
# This script gives operators (and CI) a one-command answer to
# "is any native binding wrong-arch right now?"

set -u

NODE_MODULES="${1:-node_modules}"
HOST_ARCH="$(node -p 'process.arch')"
echo "[audit] host arch: $HOST_ARCH | node: $(node -v)"
echo

expected_arch_token=""
case "$HOST_ARCH" in
  arm64) expected_arch_token="arm64";;
  x64)   expected_arch_token="x64";;
esac

mismatches=0
total=0
skipped=0

printf '%-55s | %-7s | %s\n' "PACKAGE / PATH" "STATUS" "ARCH"
printf '%-55s-+-%-7s-+-%s\n' "$(printf '%.0s-' {1..55})" "-------" "$(printf '%.0s-' {1..40})"

while IFS= read -r f; do
  total=$((total + 1))
  rel="${f#*node_modules/}"
  archline="$(file -b "$f" | head -1)"
  ok="PASS"

  case "$rel" in
    *darwin-x64*|*linux-x64*|*win32-x64*|*-x64/*)
      if [ "$expected_arch_token" != "x64" ]; then
        ok="SKIP"
        skipped=$((skipped + 1))
      fi
      ;;
    *darwin-arm64*|*linux-arm64*|*win32-arm64*|*-arm64/*)
      if [ "$expected_arch_token" != "arm64" ]; then
        ok="SKIP"
        skipped=$((skipped + 1))
      fi
      ;;
  esac

  if [ "$ok" = "PASS" ]; then
    case "$HOST_ARCH" in
      arm64)
        if echo "$archline" | grep -q "x86_64" && ! echo "$archline" | grep -q "arm64"; then
          ok="FAIL"
          mismatches=$((mismatches + 1))
        fi
        ;;
      x64)
        if echo "$archline" | grep -q "arm64" && ! echo "$archline" | grep -q "x86_64"; then
          ok="FAIL"
          mismatches=$((mismatches + 1))
        fi
        ;;
    esac
  fi

  printf '%-55s | %-7s | %s\n' "$rel" "$ok" "$archline"
done < <(find "$NODE_MODULES" -name "*.node" -not -path "*/build/obj/*" -not -path "*/build/obj.target/*" 2>/dev/null | sort)

echo
echo "[audit] total: $total | host-arch loadable: $((total - mismatches - skipped)) | cross-arch siblings (skip): $skipped | FAIL: $mismatches"
exit $mismatches
