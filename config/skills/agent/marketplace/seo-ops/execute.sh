#!/bin/bash
# seo-ops: Search Console-driven SEO operations. Thin launcher for seo_ops.py.
# Usage: execute.sh '{"command":"gsc-report","config":"seo-ops.config.json","days":28}'
#    or: execute.sh --config seo-ops.config.json gsc-report --days 28
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v python3 >/dev/null 2>&1; then
  echo "seo-ops: python3 (>= 3.8) is required. Install it (macOS: xcode-select --install; Debian/Ubuntu: apt install python3)." >&2
  exit 2
fi
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'; then
  echo "seo-ops: python3 >= 3.8 is required (found $(python3 --version 2>&1))." >&2
  exit 2
fi
if [ "$#" -eq 0 ]; then
  exec python3 "$SCRIPT_DIR/seo_ops.py" --help
fi
exec python3 "$SCRIPT_DIR/seo_ops.py" "$@"
