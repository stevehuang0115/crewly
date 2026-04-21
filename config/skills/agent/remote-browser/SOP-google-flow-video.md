# SOP: Google Lab Flow (Veo) Video Generation via Browser Automation

## Overview
This SOP documents how to generate videos using Google Lab Flow (Veo) through browser automation tools (remote-browser skill and MCP chrome tools).

**Last Updated**: 2026-04-14
**Author**: video-production-nova-8f5c1e37

---

## Prerequisites
- Chrome Extension connected (Crewly in Chrome)
- Google account logged into labs.google (with ULTRA subscription for Veo access)
- Source images available on local filesystem

## Key URLs
- Flow Homepage: `https://labs.google/fx/tools/flow`
- Flow Project: `https://labs.google/fx/tools/flow/project/{project-id}`

---

## Known Issues & Gotchas

### 1. execute.sh `set-file-input` bug (FIXED 2026-04-14)
**Problem**: The `set-file-input` action in `execute.sh` strips `.selector` from the JSON body via the generic EXTRA_PARAMS parser (`del(.action, .url, .selector, .value, .text, .code)`). The backend API requires `selector` in the body.

**Fix**: Re-inject selector into body in the `set-file-input` case:
```bash
set-file-input)
    require_param "selector (--selector)" "$SELECTOR"
    ENDPOINT="/browser/set-file-input"
    if [ -n "$EXTRA_PARAMS" ]; then
      BODY=$(printf '%s' "$EXTRA_PARAMS" | jq -c --arg s "$SELECTOR" '. + {selector: $s}')
    else
      BODY=$(jq -n --arg s "$SELECTOR" '{selector: $s}')
    fi
    ;;
```

### 2. Chinese characters in file paths
**Problem**: File paths with Chinese characters (e.g., `/Users/.../科学奶酪/3 R/images/`) may cause issues.
**Workaround**: Create symlinks with ASCII paths in `/tmp/`:
```bash
ln -sf "/path/with/中文/image.png" "/tmp/image.png"
```

### 3. MCP tab group vs remote-browser
**Problem**: MCP tab group and remote-browser operate on different tabs. MCP can't access the user's Flow project created outside the MCP session ("Something went wrong" error).
**Solution**: 
- Use remote-browser for operations on the user's existing tabs
- Use MCP for operations requiring JS execution (MCP supports `javascript_tool`)
- Or create a new Flow project within the MCP tab group

### 4. `execute-js` not supported by Chrome Extension
**Problem**: Chrome Extension does not implement the `executeJs` tool.
**Workaround**: Use MCP `javascript_tool` instead (requires tab to be in MCP tab group).

### 5. CDP `set-file-input` — missing change event (FIXED 2026-04-14)
**Problem**: `cdpSetFileInput()` called `DOM.setFileInputFiles` but did NOT dispatch `change`/`input` events. React-based apps like Google Flow only detect file selection via the `change` event, so files were set on the DOM element but the app never processed them.
**Fix**: Added `Runtime.evaluate` after `DOM.setFileInputFiles` in `chrome-extension/src/cdp-input.ts` to dispatch `change` and `input` events. Extension must be rebuilt and reloaded after this fix.

### 6. CDP `set-file-input` uploads to media library only
**Problem**: Using `DOM.setFileInputFiles` via CDP uploads images to the Flow project's media library but does NOT automatically assign them as Start/End frames.
**Status**: Investigating alternative approaches for frame assignment.

---

## Flow UI Element Map

### Top Bar
| Element | Position (page coords) | Selector | Description |
|---------|----------------------|----------|-------------|
| Back | (35, 30) | `button:nth-of-type(1)` | Go back to projects |
| Project Name | (76, 26) | `[aria-label="Editable text"]` | Editable project title |
| Search | (375, 19) | `[data-testid="search-input"]` | Search media |
| Add Media | - | `#radix-\:r7\:` | Upload media button |
| Scenebuilder | - | `button:nth-of-type(5)` | Scene builder |
| ULTRA | (1041, 14) | `button.sc-e441891c-0` | Account/subscription |

### Bottom Prompt Bar
| Element | Position (page coords) | Description |
|---------|----------------------|-------------|
| Start frame | ~(310, 750) | Start frame selection (NOT a standard interactive element) |
| Swap | (365, 736) | Swap Start/End frames |
| End frame | ~(420, 750) | End frame selection |
| Prompt input | center | "What do you want to create?" |
| Model selector | varies | Shows current model (e.g., "Video x1") |
| Create | varies | Submit/generate button |

### Model Selector Dropdown (opened by clicking model button)
| Element | Selector | Description |
|---------|----------|-------------|
| Image tab | `#radix-\:ru\:-trigger-IMAGE` | Switch to image mode |
| Video tab | `#radix-\:ru\:-trigger-VIDEO` | Switch to video mode |
| Frames | `#radix-\:r1e\:-trigger-VIDEO_FRAMES` | Frames input mode |
| Ingredients | `#radix-\:r1e\:-trigger-VIDEO_REFERENCES` | Reference input mode |
| 9:16 | `#radix-\:r11\:-trigger-PORTRAIT` | Portrait aspect ratio |
| 16:9 | `#radix-\:r11\:-trigger-LANDSCAPE` | Landscape aspect ratio |
| x1-x4 | `#radix-\:r17\:-trigger-{1,2,3,4}` | Number of outputs |
| Model | dropdown | e.g., "Veo 3.1 - Fast" |

**Important**: Radix UI selectors include dynamic IDs (`:rn:`, `:r1e:`, etc.) that may change between sessions. Use coordinate-based clicking or `find` tool as fallback.

---

## Operation Procedures

### Procedure 1: Open Flow and Create Project

```bash
# Step 1: Navigate to Flow
bash .../remote-browser/execute.sh '{"action":"navigate","url":"https://labs.google/fx/tools/flow"}'

# Step 2: Wait for page load, then screenshot
# Step 3: Close any changelog popup (click "Get started")
# Step 4: Click "+ New project"
```

### Procedure 2: Switch to Video/Frames Mode

```bash
# Step 1: Click model selector button (find it with get-interactive-elements)
# Look for button containing "Nano Banana" or "Video" text
# Step 2: Click "Video" tab in the dropdown
# Step 3: Verify "Frames" is selected (should be default for Video)
# Step 4: Select aspect ratio and count (x1 recommended for sequential work)
# Step 5: Click empty area to close dropdown
```

### Procedure 3: Upload Images to Media Library

```bash
# Direct API call (bypasses execute.sh):
curl -s -X POST http://localhost:8787/api/browser/set-file-input \
  -H "Content-Type: application/json" \
  -d '{"selector":"input[type=file]","filePaths":["/tmp/image.png"]}'

# Or via fixed execute.sh:
bash .../remote-browser/execute.sh '{"action":"set-file-input","selector":"input[type=file]","filePaths":["/tmp/image.png"]}'
```

### Procedure 4: Assign Start/End Frames
**STATUS: Partially Documented (2026-04-14)**

**UI Flow (confirmed):**
1. Click the **Start** button in the bottom prompt bar
2. A **media picker panel** pops up showing:
   - Project media library (thumbnails of uploaded images)
   - "Search for Assets" search box
   - "Recent" sort dropdown
   - **"Upload image"** button at the bottom (triggers native OS file dialog)
   - Right-side preview area
3. Select an existing image from the media library → assigned as Start frame
4. Repeat for **End** button to assign End frame

**Automation Status:**
- ❌ CDP `set-file-input`: Returns success but images do NOT appear in media library. React app cannot read CDP-injected virtual file references via FileReader.
- ❌ MCP `upload_image`: "Unable to access message history" error — tool limitation.
- ❌ JS `fetch` + `DataTransfer`: Cross-origin restrictions cause timeouts (labs.google → localhost).
- **Conclusion**: Currently NO automated method works for uploading images to Flow media library. Manual upload via "Upload image" button (native file dialog) is the only working approach.

**Recommended Workaround:**
- User manually uploads images via the "Upload image" button in the media picker
- Or: pre-upload all images to media library via top-bar "Add Media" button before starting frame assignment

### Procedure 5: Enter Prompt and Generate

```bash
# Step 1: Click prompt input area
# Step 2: Type the video description prompt
bash .../remote-browser/execute.sh '{"action":"fill","selector":"[placeholder]","value":"prompt text here"}'
# Step 3: Click Create button
# Step 4: Wait for generation to complete
# Step 5: Download the result
```

---

## Video Generation Workflow (7 Videos for 3R Project)

| Video | Start Frame | End Frame | Prompt |
|-------|------------|-----------|--------|
| 1 | shot-01-opening.png | shot-02-reduce.png | Camera slowly zooms into the poster... |
| 2 | shot-02-reduce.png | shot-03-reuse.png | The mini worker holds up the prohibition sign... |
| 3 | shot-03-reuse.png | shot-04-recycle-overview.png | Mini workers exchange toys and books... |
| 4 | shot-04-recycle-overview.png | shot-05-recycle-bottles.png | Factory conveyor belts running... |
| 5 | shot-05-recycle-bottles.png | shot-06-not-recyclable.png | Workers demonstrate bottle cleaning... |
| 6 | shot-06-not-recyclable.png | shot-07-finale.png | Inspector worker shakes head... |
| 7 | shot-07-finale.png | (none - single frame) | All mini workers cheer and wave... |

---

## Appendix: Direct API Endpoints

| Endpoint | Method | Body | Description |
|----------|--------|------|-------------|
| `/api/browser/navigate` | POST | `{url}` | Navigate tab |
| `/api/browser/screenshot` | POST | `{}` | Capture screenshot |
| `/api/browser/click` | POST | `{selector}` or `{x, y}` | Click element |
| `/api/browser/set-file-input` | POST | `{selector, filePaths}` | Set files on input |
| `/api/browser/read-text` | POST | `{selector?}` | Read page text |
| `/api/browser/get-interactive-elements` | POST | `{}` | List clickable elements |
