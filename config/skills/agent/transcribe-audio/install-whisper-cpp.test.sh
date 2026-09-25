#!/bin/bash
# Tests for install-whisper-cpp.sh — run with: bash install-whisper-cpp.test.sh </dev/null
# Fakes uname (Linux x86_64), curl (serves a crafted release tarball) and
# sha256sum on an isolated PATH; nothing is downloaded or built. Exit 0 on pass.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/install-whisper-cpp.sh"
PASS=0; FAIL=0
check() {
  local name="$1"; local got="$2"; local want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $name"; echo "  want: $want"; echo "  got:  $got"; fi
}
BASH_BIN="${TEST_BASH:-$(command -v bash)}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/pkg/whisper-bin-ubuntu-x64"
for tool in mktemp cat rm tar mkdir chmod cp cut dirname grep sed head; do
  src="$(command -v "$tool" 2>/dev/null)" && ln -sf "$src" "$T/bin/$tool"
done
EXPECTED_SHA="$(grep '^SHA256_UBUNTU_X64=' "$SCRIPT" | cut -d'"' -f2)"

# The release tarball: whisper-cli that answers --help.
printf '#!/bin/sh\n[ "$1" = "--help" ] && echo "usage: whisper-cli" && exit 0\necho "ran $*"\n' > "$T/pkg/whisper-bin-ubuntu-x64/whisper-cli"
chmod 755 "$T/pkg/whisper-bin-ubuntu-x64/whisper-cli"
(cd "$T/pkg" && tar -czf "$T/release.tar.gz" whisper-bin-ubuntu-x64)

printf '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac\n' > "$T/bin/uname"
printf '#!/bin/sh\necho 4\n' > "$T/bin/nproc"
# curl -fsSL --retry 3 -o <out> <url>: log the URL, copy the tarball.
cat > "$T/bin/curl" <<EOT
#!/bin/sh
while [ \$# -gt 0 ]; do case "\$1" in -o) out="\$2"; shift 2 ;; -*) shift ;; *) url="\$1"; shift ;; esac; done
echo "\$url" >> "$T/curl.log"
cp "$T/release.tar.gz" "\$out"
EOT
cat > "$T/bin/sha256sum" <<'EOT'
#!/bin/sh
echo "${FAKE_SHA}  $1"
EOT
chmod 755 "$T/bin/"*

run() { env -i HOME="$T/home" PATH="$T/bin" CREWLY_HOME="$T/home/.crewly" CREWLY_SUDO=unavailable "$@" "$BASH_BIN" "$SCRIPT" </dev/null 2>"$T/err.log"; }

# 1. Prebuilt: checksum matches → extracted, wrapper written, smoke test passes.
run FAKE_SHA="$EXPECTED_SHA"; RC=$?
check "prebuilt: exit 0" "$RC" "0"
check "prebuilt: pinned release URL" "$(tail -n 1 "$T/curl.log")" "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-ubuntu-x64.tar.gz"
check "prebuilt: wrapper is executable" "$([ -x "$T/home/.crewly/bin/whisper-cli" ] && echo yes)" "yes"
check "prebuilt: wrapper runs the extracted binary" "$(PATH="$T/bin" "$T/home/.crewly/bin/whisper-cli" -m x)" "ran -m x"
check "prebuilt: sets LD_LIBRARY_PATH to the bundle" "$(grep -c "LD_LIBRARY_PATH=\"$T/home/.crewly/opt/whisper.cpp-v1.9.2" "$T/home/.crewly/bin/whisper-cli")" "1"

# 2. Checksum mismatch → prebuilt rejected, source build needs tools; no sudo → clear failure.
rm -rf "$T/home"; : > "$T/curl.log"
run FAKE_SHA=0000; RC=$?
check "mismatch: exit 1" "$RC" "1"
grep -q "checksum mismatch for whisper-bin-ubuntu-x64.tar.gz" "$T/err.log" && OK=yes || OK=no
check "mismatch: says so" "$OK" "yes"
grep -q "building whisper.cpp needs: cmake build-essential. Install them (e.g. sudo apt-get install -y cmake build-essential)" "$T/err.log" && OK=yes || OK=no
check "no build tools + no sudo: tells the owner what to install" "$OK" "yes"
check "mismatch: no whisper-cli left behind" "$([ -e "$T/home/.crewly/bin/whisper-cli" ] && echo present || echo absent)" "absent"

# 3. Not Linux → refuses (macOS uses brew).
printf '#!/bin/sh\necho Darwin\n' > "$T/bin/uname"
run FAKE_SHA="$EXPECTED_SHA"; RC=$?
check "darwin: exit 1" "$RC" "1"
grep -q "this installer is for Linux" "$T/err.log" && OK=yes || OK=no
check "darwin: says brew is used there" "$OK" "yes"

echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
