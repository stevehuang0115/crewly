#!/bin/bash
# Remotion Video Generator Skill
# Generates motion graphic videos using Remotion + React templates.
# Manages a persistent workspace at ~/.crewly/remotion-workspace/.
# Input: JSON with template, props, output, duration, width, height, fps.
# Output: JSON with success status and output file path.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

# --- Constants ---
WORKSPACE="${HOME}/.crewly/remotion-workspace"
TEMPLATES_DIR="${SCRIPT_DIR}/templates"
DEFAULT_OUTPUT="/tmp/remotion-output.mp4"
DEFAULT_WIDTH=1920
DEFAULT_HEIGHT=1080
DEFAULT_FPS=30

# --- Parse input ---
INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit 'Usage: execute.sh '\''{"template":"launch","props":{...},"output":"/tmp/video.mp4"}'\'''

TEMPLATE=$(printf '%s' "$INPUT" | jq -r '.template // empty')
PROPS=$(printf '%s' "$INPUT" | jq -c '.props // {}')
OUTPUT_PATH=$(printf '%s' "$INPUT" | jq -r '.output // empty')
DURATION_SEC=$(printf '%s' "$INPUT" | jq -r '.duration // empty')
WIDTH=$(printf '%s' "$INPUT" | jq -r '.width // empty')
HEIGHT=$(printf '%s' "$INPUT" | jq -r '.height // empty')
FPS=$(printf '%s' "$INPUT" | jq -r '.fps // empty')

# Validate template
if [ -z "$TEMPLATE" ]; then
  error_exit "Required parameter 'template' is missing. Available: launch, text-slides, announcement"
fi

# Set defaults
OUTPUT_PATH="${OUTPUT_PATH:-$DEFAULT_OUTPUT}"
WIDTH="${WIDTH:-$DEFAULT_WIDTH}"
HEIGHT="${HEIGHT:-$DEFAULT_HEIGHT}"
FPS="${FPS:-$DEFAULT_FPS}"

# Map template to component name and calculate duration
case "$TEMPLATE" in
  launch)
    COMPONENT_FILE="LaunchVideo.tsx"
    COMPONENT_NAME="LaunchVideo"
    COMPOSITION_ID="LaunchVideo"
    # Duration: 3s intro + 2s per feature + 3s outro
    if [ -z "$DURATION_SEC" ]; then
      FEATURE_COUNT=$(echo "$PROPS" | jq '.features | length // 0')
      DURATION_SEC=$(( 3 + FEATURE_COUNT * 2 + 3 ))
      [ "$DURATION_SEC" -lt 10 ] && DURATION_SEC=10
    fi
    ;;
  text-slides)
    COMPONENT_FILE="TextSlides.tsx"
    COMPONENT_NAME="TextSlides"
    COMPOSITION_ID="TextSlides"
    if [ -z "$DURATION_SEC" ]; then
      SLIDE_COUNT=$(echo "$PROPS" | jq '.slides | length // 0')
      DURATION_SEC=$(( SLIDE_COUNT * 4 ))
      [ "$DURATION_SEC" -lt 8 ] && DURATION_SEC=8
    fi
    ;;
  announcement)
    COMPONENT_FILE="Announcement.tsx"
    COMPONENT_NAME="Announcement"
    COMPOSITION_ID="Announcement"
    DURATION_SEC="${DURATION_SEC:-10}"
    ;;
  *)
    error_exit "Unknown template: $TEMPLATE. Available: launch, text-slides, announcement"
    ;;
esac

DURATION_FRAMES=$(( DURATION_SEC * FPS ))

# --- Status helper ---
status_msg() {
  echo "{\"status\":\"$1\",\"message\":\"$2\"}" >&2
}

# --- Setup workspace ---
setup_workspace() {
  if [ -d "$WORKSPACE/node_modules/remotion" ]; then
    return 0
  fi

  status_msg "setup" "Setting up Remotion workspace (first run, may take 2-5 minutes)..."
  mkdir -p "$WORKSPACE/src/compositions" "$WORKSPACE/public"

  # Create package.json
  cat > "$WORKSPACE/package.json" <<'PKGJSON'
{
  "name": "crewly-remotion-workspace",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "start": "npx remotion studio",
    "render": "npx remotion render"
  },
  "dependencies": {
    "@remotion/cli": "4.0.242",
    "@remotion/transitions": "4.0.242",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "remotion": "4.0.242"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "typescript": "^5.6.3"
  }
}
PKGJSON

  # Create tsconfig.json
  cat > "$WORKSPACE/tsconfig.json" <<'TSCONFIG'
{
  "compilerOptions": {
    "target": "ES2018",
    "module": "commonjs",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
TSCONFIG

  # Create entry point
  cat > "$WORKSPACE/src/index.ts" <<'ENTRY'
import { registerRoot } from "remotion";
import { Root } from "./Root";
registerRoot(Root);
ENTRY

  # Install dependencies
  cd "$WORKSPACE"
  npm install --loglevel=error 2>&1 | tail -5 >&2
  local npm_exit=${PIPESTATUS[0]}
  if [ "$npm_exit" -ne 0 ]; then
    error_exit "npm install failed (exit code: $npm_exit). Check Node.js version (need 18+)."
  fi

  status_msg "setup" "Workspace ready."
}

# --- Copy template to workspace ---
copy_template() {
  local src="${TEMPLATES_DIR}/${COMPONENT_FILE}"
  local dest="${WORKSPACE}/src/compositions/${COMPONENT_FILE}"

  if [ ! -f "$src" ]; then
    error_exit "Template file not found: $src"
  fi

  cp "$src" "$dest"
}

# --- Generate Root.tsx with the current composition ---
generate_root() {
  cat > "$WORKSPACE/src/Root.tsx" <<ROOTEOF
import React from "react";
import { Composition } from "remotion";
import { ${COMPONENT_NAME} } from "./compositions/${COMPONENT_NAME}";

const defaultProps = ${PROPS};

export const Root: React.FC = () => {
  return (
    <>
      <Composition
        id="${COMPOSITION_ID}"
        component={${COMPONENT_NAME}}
        durationInFrames={${DURATION_FRAMES}}
        fps={${FPS}}
        width={${WIDTH}}
        height={${HEIGHT}}
        defaultProps={defaultProps}
      />
    </>
  );
};
ROOTEOF
}

# --- Render the video ---
render_video() {
  local output_dir
  output_dir=$(dirname "$OUTPUT_PATH")
  mkdir -p "$output_dir"

  status_msg "rendering" "Rendering ${DURATION_SEC}s video (${WIDTH}x${HEIGHT} @ ${FPS}fps)..."

  cd "$WORKSPACE"
  local render_log="/tmp/remotion-render-$$.log"

  npx remotion render \
    src/index.ts \
    "$COMPOSITION_ID" \
    "$OUTPUT_PATH" \
    --codec h264 \
    --overwrite \
    2>"$render_log"
  local render_exit=$?

  if [ "$render_exit" -ne 0 ]; then
    local render_error
    render_error=$(tail -20 "$render_log" 2>/dev/null || echo "Unknown render error")
    rm -f "$render_log"
    error_exit "Remotion render failed (exit $render_exit): $render_error"
  fi

  rm -f "$render_log"

  if [ ! -f "$OUTPUT_PATH" ]; then
    error_exit "Render completed but output file not found at: $OUTPUT_PATH"
  fi
}

# --- Main ---
setup_workspace
copy_template
generate_root
render_video

# Get file size
FILE_SIZE=$(wc -c < "$OUTPUT_PATH" | tr -d ' ')
FILE_SIZE_MB=$(echo "scale=2; $FILE_SIZE / 1048576" | bc 2>/dev/null || echo "unknown")

# Output result
jq -n \
  --arg output "$OUTPUT_PATH" \
  --arg template "$TEMPLATE" \
  --arg duration "${DURATION_SEC}s" \
  --arg resolution "${WIDTH}x${HEIGHT}" \
  --arg fps "$FPS" \
  --arg fileSize "${FILE_SIZE_MB}MB" \
  '{
    success: true,
    output: $output,
    template: $template,
    duration: $duration,
    resolution: $resolution,
    fps: $fps,
    fileSize: $fileSize
  }'
