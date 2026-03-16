---
name: RedNote (小红书) Reader
description: "Read content from \u5c0f\u7ea2\u4e66 (RedNote) iPad app on macOS via Accessibility API + screencapture. Actions: feed (read posts), scroll-feed, nav, screenshot (capture window), search (type keyword), tap (click coordinates), read-detail (screenshot + text), goto-profile (navigate to user profile by username). Zero network requests \u2014 cannot trigger account bans."
version: 3.0.0
category: automation
skillType: claude-skill
assignableRoles:
  - generalist
  - product-manager
triggers:
  - rednote
  - 小红书
  - xiaohongshu
  - red note
  - discover app
  - read rednote
tags:
  - automation
  - rednote
  - xiaohongshu
  - accessibility
  - content-reading
  - macos
  - screenshot
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# RedNote (小红书) Reader — iPad App Mode

Pure iPad App mode using macOS Accessibility API, screencapture, and simulated input.
**Zero network requests** — no curl, no HTTP calls, impossible to trigger account bans.

## Prerequisites

- The 小红书 app (bundle ID: `com.xingin.discover`, process name: `discover`) must be installed on macOS (Apple Silicon iPad app). It will be automatically started if not running.
- Accessibility permission granted to terminal (System Settings > Privacy & Security > Accessibility).
- App must be on the **current Space/Desktop** for screenshot and tap actions (Accessibility API text reading works across Spaces).
- **Auto-Recovery:** If the app is running but has no visible window (a known macOS iPad app bug), the skill will automatically attempt to recover it by activating it, using the top menu `Window -> rednote`, or gracefully restarting it.

## Actions

### feed — Read the current feed

Extracts structured post data (title, author, likes) from the visible feed via Accessibility API.

> ⚠️ **CRITICAL NOTE ON URLs & PROFILE LINKS**: 
> The macOS Accessibility API **DOES NOT** expose underlying web URLs, deep links (`xiaohongshu://`), or hidden Profile IDs. 
> Therefore, it is **impossible** to directly extract a user's "Homepage Direct Link" (e.g., `https://www.xiaohongshu.com/user/profile/...`) from the UI elements using this skill. 
> **Workaround:** Always generate a "Search Direct Link" instead: `https://www.xiaohongshu.com/search_result/?keyword={username}`. This provides a 100% reliable entry point for users.

```bash
bash execute.sh '{"action":"feed"}'
bash execute.sh '{"action":"feed","limit":150}'
```

**Tip:** Use `limit` >= 100 to get past navigation elements and reach actual feed posts.

### scroll-feed — Scroll and read more

Scrolls the feed down, then reads the newly visible content.

```bash
bash execute.sh '{"action":"scroll-feed","amount":5}'
```

### nav — Read navigation structure

Returns bottom tabs, top tabs, categories, and search hint.

```bash
bash execute.sh '{"action":"nav"}'
```

### raw — Raw text dump

Dumps all accessible text from the UI (deduplicated). Useful for debugging.

```bash
bash execute.sh '{"action":"raw","limit":100}'
```

### screenshot — Capture the app window

Takes a PNG screenshot of the app window using `screencapture`. Returns the file path.

```bash
bash execute.sh '{"action":"screenshot"}'
bash execute.sh '{"action":"screenshot","outputPath":"/tmp/my-screenshot.png"}'
```

**Note:** The app must be on the current Space. The screenshot includes only the app window, not other windows.

### tap — Click at coordinates

Simulates a mouse click at the given absolute screen coordinates. Use this to tap on feed items, buttons, or other UI elements.

```bash
bash execute.sh '{"action":"tap","x":500,"y":600}'
```

**Tip:** Use `feed` action first to get element positions (each item includes `pos: {x, y}`), then `tap` to click on a specific post.

### search — Search for content

Searches for a keyword in 小红书 and returns structured results. Handles three starting states automatically:
1. **Home feed** — clicks the search icon (top-right), transitions to search page, then types and searches
2. **Search landing page** — clears the text field, types and searches
3. **Search results page** — clears and re-searches with the new keyword

Uses Accessibility API to detect the text field position dynamically. CJK keywords are pasted via clipboard for reliability.

```bash
bash execute.sh '{"action":"search","keyword":"张咋啦"}'
bash execute.sh '{"action":"search","keyword":"AI agent"}'
```

**Workflow:** search returns the same structured post data as `feed` (nav + posts). After searching, use `tap` on a specific result to open it, then `read-detail` to extract its content.

**Known Failure Modes & Recovery:**
- **Failure 1 (Deep Page Stuck):** "Failed to navigate to search page: no text field found".
  - **Cause:** The app is stuck in a deep profile or detail page where the global search icon/bar is unavailable.
  - **Recovery:** *[AUTOMATICALLY HANDLED]* The `search` action now incorporates an automatic `back_to_root` escape mechanism that scans the UI tree for a "Return" button and clicks it (or uses a fixed fallback coordinate `x:64, y:54` relative to the window) until it reaches the home/search page.
- **Failure 2 (Direct URL Extraction):** Attempting to get a user's direct Profile URL (`https://www.xiaohongshu.com/user/profile/...`).
  - **Cause:** macOS Accessibility API does not expose underlying deep links or hidden IDs.
  - **Recovery:** Do not attempt to extract Profile URLs. Always construct and provide a "Search Direct Link" instead: `https://www.xiaohongshu.com/search_result/?keyword={username}`.

### read-detail — Read note detail page

Captures both a screenshot and all accessible text from the current screen. Use this after tapping into a specific note.

```bash
bash execute.sh '{"action":"read-detail"}'
bash execute.sh '{"action":"read-detail","limit":200}'
```

**Returns:** `screenshotPath` (PNG file path) + `texts` (array of extracted text items with positions). The screenshot can be analyzed by a vision model for image/video content that the Accessibility API cannot read.

### goto-profile — Navigate to a user's profile

Finds a username on the current screen via Accessibility API text matching, clicks on it, waits for the profile page to load, and returns profile data.

**Enhancement:** It will first attempt to find and click the "Users" (`用户`) tab at the top of the screen before searching for the username. This filters out irrelevant posts and significantly improves the accuracy of navigating to actual user profiles instead of just notes mentioning the user.

```bash
bash execute.sh '{"action":"goto-profile","username":"曲晓音"}'
bash execute.sh '{"action":"goto-profile","username":"张咋啦"}'
```

**Prerequisite:** The username must be visible on screen (e.g. in search results or feed). Use `search` first to find the user, then `goto-profile` to navigate to their profile.

**Returns:** `clickedAt` (coordinates clicked), `isProfilePage` (whether profile indicators like follower count were detected), `texts` (all text from the resulting page).

## Typical Workflows

### Browse the feed
1. `feed` (limit: 150) — see what's on screen
2. `scroll-feed` — load more posts
3. `tap` on an interesting post's coordinates
4. `read-detail` — get the full detail page

### Search for content
1. `search` with a keyword — types and searches
2. Review returned posts
3. `tap` on a result to open it, or `goto-profile` with a username to visit their profile
4. `read-detail` to extract detail content
5. Use device back gesture or `tap` the back button to return

### Navigate to a user's profile
1. `search` with the username or related keyword
2. `goto-profile` with the exact username string from results
3. `read-detail` to get profile page content

### Monitor / screenshot
1. `screenshot` — capture current state for vision model analysis
2. `nav` — check which tab/category is active

## Parameters

| Parameter    | Required     | Default | Description |
|--------------|--------------|---------|-------------|
| `action`     | Yes          | -       | `feed`, `scroll-feed`, `nav`, `raw`, `screenshot`, `search`, `tap`, `read-detail`, `goto-profile` |
| `limit`      | No           | `50`    | Max text items to extract (feed, raw, read-detail) |
| `amount`     | No           | `5`     | Scroll lines (scroll-feed only) |
| `keyword`    | search only  | -       | Search query string |
| `username`   | goto-profile only | -  | Exact username to find and click on |
| `x`          | tap only     | -       | Absolute screen X coordinate |
| `y`          | tap only     | -       | Absolute screen Y coordinate |
| `outputPath` | No           | auto    | Custom screenshot save path (screenshot only) |

## Technical Notes

- iPad app text is in `AXDescription` attribute, not `AXValue`
- Post body text in detail view may not be accessible via Accessibility API (custom rendering) — use `screenshot` + vision model as fallback
- Screenshots and tap/click require the app to be on the current macOS Space
- Accessibility API text reading works across Spaces (no focus needed)
- **NEVER use `killall -9` on iPad apps** — destroys the window permanently with no programmatic recovery
