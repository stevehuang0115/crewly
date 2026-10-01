#!/bin/bash
# Restarting Crewly is the owner's decision (specs/2026-10-01-upgrade-restart-controls.md):
# POST /api/system/restart refuses agent sessions with 403. This script no
# longer calls it; it tells the agent how to ask the owner instead.
set -euo pipefail
cat <<'JSON'
{"success":false,"code":"owner-only","error":"Only the owner can restart Crewly. Ask the owner to open the dashboard: Settings > System > Restart (choose 'When idle')."}
JSON
exit 1
