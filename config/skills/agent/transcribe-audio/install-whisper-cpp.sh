#!/bin/bash
# =============================================================================
# install-whisper-cpp.sh — put a working `whisper-cli` in $CREWLY_BIN_DIR on Linux.
#
# Run by the Crewly skill-setup runner (the `whisper-cli` step of this skill's
# setup block) when whisper-cli is not already installed. Never prompts.
#
# 1. Prebuilt: the official whisper.cpp release ships Ubuntu binaries
#    (whisper-bin-ubuntu-{x64,arm64}.tar.gz). The pinned tarball is downloaded,
#    its sha256 checked, extracted to $CREWLY_HOME/opt/whisper.cpp-<tag>/, and a
#    wrapper $CREWLY_BIN_DIR/whisper-cli is written that sets LD_LIBRARY_PATH to
#    the bundled shared libraries. A smoke test (`whisper-cli --help`) decides
#    whether the binary runs here (it needs a recent enough glibc).
# 2. Source: when there is no prebuilt for this CPU, or it does not run, the
#    same tag is built with cmake into $CREWLY_HOME/opt/ and whisper-cli copied
#    to $CREWLY_BIN_DIR. Needs cmake, a C++ compiler, curl and tar; when they
#    are missing and root/passwordless sudo is available ($CREWLY_SUDO), they
#    are installed with apt-get, otherwise the script says what to install.
#
# Environment (set by the runner):
#   CREWLY_HOME      Crewly home (default ~/.crewly)
#   CREWLY_BIN_DIR   where whisper-cli goes (default $CREWLY_HOME/bin)
#   CREWLY_SUDO      '' = root, 'sudo -n' = passwordless sudo, 'unavailable'
#   WHISPER_CPP_SKIP_PREBUILT=1   force the source build (testing)
#   WHISPER_CPP_DOWNLOAD_BASE     override the download host (testing)
# =============================================================================
set -euo pipefail

# ── Pinned release (sha256 from the GitHub release asset digests) ─────────────
WHISPER_TAG="v1.9.2"
SHA256_UBUNTU_X64="46811a3ecf584307480a220b9ef5ff81b7b22dc41577cbc274ce3afc61f753b1"
SHA256_UBUNTU_ARM64="7e26fa6a36d9174d5c0bf033ccbc026c3b5e569e2ee787058241346ef5392719"
DOWNLOAD_BASE="${WHISPER_CPP_DOWNLOAD_BASE:-https://github.com/ggml-org/whisper.cpp}"
BUILD_JOBS="$(nproc 2>/dev/null || echo 2)"

CREWLY_HOME="${CREWLY_HOME:-${HOME}/.crewly}"
BIN_DIR="${CREWLY_BIN_DIR:-${CREWLY_HOME}/bin}"
OPT_DIR="${CREWLY_HOME}/opt"
SUDO_MODE="${CREWLY_SUDO-unavailable}"

log() { printf '[install-whisper-cpp] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "this installer is for Linux (on macOS the setup uses: brew install whisper-cpp)"
mkdir -p "$BIN_DIR" "$OPT_DIR"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/whisper-cpp-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Write the wrapper that makes the bundled .so files findable.
write_wrapper() {
  local real="$1" libdir="$2"
  cat > "${BIN_DIR}/whisper-cli" <<EOF
#!/bin/sh
# Crewly wrapper for whisper.cpp ${WHISPER_TAG} (written by install-whisper-cpp.sh)
LD_LIBRARY_PATH="${libdir}\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}" exec "${real}" "\$@"
EOF
  chmod 755 "${BIN_DIR}/whisper-cli"
}

smoke_test() { "${BIN_DIR}/whisper-cli" --help >/dev/null 2>&1; }

try_prebuilt() {
  local arch asset sha
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) asset="whisper-bin-ubuntu-x64.tar.gz"; sha="$SHA256_UBUNTU_X64" ;;
    aarch64|arm64) asset="whisper-bin-ubuntu-arm64.tar.gz"; sha="$SHA256_UBUNTU_ARM64" ;;
    *) log "no prebuilt binary for ${arch}"; return 1 ;;
  esac
  local url="${DOWNLOAD_BASE}/releases/download/${WHISPER_TAG}/${asset}"
  log "downloading ${url}"
  curl -fsSL --retry 3 -o "${WORK}/${asset}" "$url" || { log "download failed"; return 1; }
  local got; got="$(sha256_of "${WORK}/${asset}")"
  [ "$got" = "$sha" ] || { log "checksum mismatch for ${asset}: expected ${sha}, got ${got}"; return 1; }
  local dest="${OPT_DIR}/whisper.cpp-${WHISPER_TAG}"
  rm -rf "$dest"; mkdir -p "$dest"
  tar -xzf "${WORK}/${asset}" -C "$dest" --strip-components=1
  [ -x "${dest}/whisper-cli" ] || { log "whisper-cli not found in ${asset}"; return 1; }
  write_wrapper "${dest}/whisper-cli" "$dest"
  smoke_test || { log "the prebuilt whisper-cli does not run on this system (glibc too old?)"; return 1; }
  log "installed prebuilt whisper.cpp ${WHISPER_TAG} → ${BIN_DIR}/whisper-cli"
}

ensure_build_tools() {
  local missing=()
  command -v cmake >/dev/null 2>&1 || missing+=(cmake)
  { command -v c++ >/dev/null 2>&1 || command -v g++ >/dev/null 2>&1; } || missing+=(build-essential)
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  [ ${#missing[@]} -eq 0 ] && return 0
  if [ "$SUDO_MODE" = "unavailable" ] || ! command -v apt-get >/dev/null 2>&1; then
    die "building whisper.cpp needs: ${missing[*]}. Install them (e.g. sudo apt-get install -y ${missing[*]}) and run the setup again."
  fi
  log "installing build tools: ${missing[*]}"
  # shellcheck disable=SC2086 # SUDO_MODE is '' or 'sudo -n'
  $SUDO_MODE env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}" </dev/null \
    || { $SUDO_MODE apt-get update </dev/null && $SUDO_MODE env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}" </dev/null; } \
    || die "apt-get could not install ${missing[*]}"
}

build_from_source() {
  ensure_build_tools
  local url="${DOWNLOAD_BASE}/archive/refs/tags/${WHISPER_TAG}.tar.gz"
  log "building whisper.cpp ${WHISPER_TAG} from source (${url})"
  curl -fsSL --retry 3 -o "${WORK}/src.tar.gz" "$url" || die "could not download ${url}"
  mkdir -p "${WORK}/src"
  tar -xzf "${WORK}/src.tar.gz" -C "${WORK}/src" --strip-components=1
  cmake -S "${WORK}/src" -B "${WORK}/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF >&2
  cmake --build "${WORK}/build" --config Release --target whisper-cli -j "$BUILD_JOBS" >&2
  local dest="${OPT_DIR}/whisper.cpp-${WHISPER_TAG}-src"
  rm -rf "$dest"; mkdir -p "$dest"
  cp "${WORK}/build/bin/whisper-cli" "${dest}/whisper-cli"
  write_wrapper "${dest}/whisper-cli" "$dest"
  smoke_test || die "the whisper-cli built from source does not run"
  log "built whisper.cpp ${WHISPER_TAG} → ${BIN_DIR}/whisper-cli"
}

if [ "${WHISPER_CPP_SKIP_PREBUILT:-0}" != "1" ] && try_prebuilt; then
  exit 0
fi
build_from_source
