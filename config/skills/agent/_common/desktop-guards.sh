#!/usr/bin/env bash
# Agent Skills desktop guards - delegates to shared library
SHARED_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/_common"
source "${SHARED_LIB_DIR}/desktop-guards.sh"
