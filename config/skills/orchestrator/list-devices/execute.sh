#!/bin/bash
# List all Crewly devices connected to Cloud
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

api_call GET "/cloud/devices"
