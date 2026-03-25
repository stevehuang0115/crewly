#!/bin/bash
# =============================================================================
# RedNote (小红书) Reader Skill — Pure iPad App Mode
# All operations via Accessibility API, screencapture, and osascript (JXA).
# Zero network requests — cannot trigger account bans.
#
# Actions:
#   feed          — Read structured feed posts via Accessibility API
#   scroll-feed   — Scroll the feed then read new content
#   nav           — Read navigation structure
#   raw           — Raw text dump from UI
#   screenshot    — Capture the app window as a PNG image
#   search        — Type a keyword into the search box and read results
#   tap           — Simulate a mouse click at given coordinates
#   read-detail   — Read a note detail page (screenshot + text extraction)
#   goto-profile  — Navigate to a user's profile by username text match
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

APP_NAME="discover"
MAX_DEPTH=28

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"action\":\"feed|scroll-feed|nav|raw|screenshot|search|tap|read-detail|goto-profile\"}'"

ACTION=$(printf '%s' "$INPUT" | jq -r '.action // empty')
require_param "action" "$ACTION"

# =============================================================================
# Shared helpers
# =============================================================================

# Check that the app is running and accessible
check_app() {
  local running
  running=$(osascript -l JavaScript -e "
    var app = Application('System Events');
    var procs = app.processes.whose({name: '$APP_NAME'});
    procs.length;
  " 2>/dev/null || echo "0")

  if [ "$running" = "0" ]; then
    open -a "$APP_NAME" || open -b "com.xingin.discover" || true
    sleep 5
    running=$(osascript -l JavaScript -e "
      var app = Application('System Events');
      var procs = app.processes.whose({name: '$APP_NAME'});
      procs.length;
    " 2>/dev/null || echo "0")
    if [ "$running" = "0" ]; then
      error_exit "小红书 (discover) is not running and could not be started automatically. Please start the app first."
    fi
  fi

  # Check accessibility — use osascript ObjC bridge instead of swift
  # (swift -e fails if Xcode license is not accepted, masking the real error)
  local trusted
  trusted=$(osascript -l JavaScript -e "ObjC.import('Cocoa'); $.AXIsProcessTrusted()" 2>/dev/null || echo "false")
  if [ "$trusted" != "true" ]; then
    error_exit "Accessibility permission required. System Settings > Privacy & Security > Accessibility > enable the app running this script (e.g. Terminal, claude, iTerm2)."
  fi
}

# Focus the app window (bring to front)
focus_app() {
  osascript -l JavaScript -e "
    var app = Application('System Events');
    var proc = app.processes.byName('$APP_NAME');
    proc.frontmost = true;
  " >/dev/null 2>&1
  sleep 0.3
}

# Return visible window count for the app (numeric, defaults to 0 on any error).
get_window_count() {
  local wins
  wins=$(osascript -l JavaScript -e "
    var app = Application('System Events');
    var proc = app.processes.byName('$APP_NAME');
    try { proc.windows().length; } catch (e) { 0; }
  " 2>/dev/null || echo "0")
  if ! [[ "$wins" =~ ^[0-9]+$ ]]; then
    wins=0
  fi
  echo "$wins"
}

# Wait briefly for a window to appear after recovery actions.
wait_for_window() {
  local tries="${1:-12}" # ~6s total with 0.5s sleep
  local wins i
  for i in $(seq 1 "$tries"); do
    wins=$(get_window_count)
    if [ "$wins" -gt 0 ]; then
      echo "$wins"
      return 0
    fi
    sleep 0.5
  done
  echo "0"
  return 0
}

# Ensure the app window is visible, attempt to recover if not
ensure_window() {
  local wins i
  for i in {1..3}; do
    wins=$(get_window_count)
    if [ "$wins" -gt 0 ]; then
      return 0
    fi
    
    # Try 1: Simple activate
    osascript -l JavaScript -e "Application('$APP_NAME').activate();" >/dev/null 2>&1
    sleep 0.8
    wins=$(wait_for_window 4)
    if [ "$wins" -gt 0 ]; then
      return 0
    fi
    
    # Try 2: Click menu Window -> rednote
    osascript -e "tell application \"System Events\" to tell process \"$APP_NAME\" to click menu item \"rednote\" of menu 1 of menu bar item \"Window\" of menu bar 1" >/dev/null 2>&1
    # Fallback for title case variants.
    osascript -e "tell application \"System Events\" to tell process \"$APP_NAME\" to click menu item \"Rednote\" of menu 1 of menu bar item \"Window\" of menu bar 1" >/dev/null 2>&1
    sleep 0.8
    wins=$(wait_for_window 4)
    if [ "$wins" -gt 0 ]; then
      return 0
    fi
    
    # Try 3: Graceful kill and reopen (NEVER killall -9)
    if [ "$i" -eq 2 ]; then
      killall "$APP_NAME" 2>/dev/null || true
      sleep 3
      open -a "$APP_NAME" || open -b "com.xingin.discover"
      wins=$(wait_for_window 20) # allow cold launch
      if [ "$wins" -gt 0 ]; then
        return 0
      fi
    fi
  done
  
  wins=$(get_window_count)
  if [ "$wins" -eq 0 ]; then
    error_exit "Failed to recover app window. Process is running but no UI is visible. User manual intervention required."
  fi
}

# Verify discover is still the frontmost app; re-focus if not.
# Call this after any click_at() to guard against focus theft.
verify_focus() {
  local frontmost
  frontmost=$(osascript -l JavaScript -e "
    var app = Application('System Events');
    var procs = app.processes.whose({frontmost: true});
    procs.length > 0 ? procs[0].name() : '';
  " 2>/dev/null || echo "")

  if [ "$frontmost" != "$APP_NAME" ]; then
    focus_app
  fi
}

# Get the app window geometry as JSON: {x, y, w, h}
get_window_geometry() {
  osascript -l JavaScript -e "
    var app = Application('System Events');
    var proc = app.processes.byName('$APP_NAME');
    var wins = proc.windows();
    if (!wins || wins.length === 0) {
      throw new Error('no-window');
    }
    var win = wins[0];
    var pos = win.position();
    var size = win.size();
    JSON.stringify({x: pos[0], y: pos[1], w: size[0], h: size[1]});
  " 2>/dev/null || error_exit "Failed to get window geometry. Is the app window visible?"
}

# Simulate a mouse click at absolute screen coordinates (x, y)
click_at() {
  local cx="$1" cy="$2"
  osascript -l JavaScript -e "
    ObjC.import('CoreGraphics');
    var point = \$.CGPointMake($cx, $cy);
    var mouseDown = \$.CGEventCreateMouseEvent(null, \$.kCGEventLeftMouseDown, point, \$.kCGMouseButtonLeft);
    var mouseUp = \$.CGEventCreateMouseEvent(null, \$.kCGEventLeftMouseUp, point, \$.kCGMouseButtonLeft);
    \$.CGEventPost(\$.kCGHIDEventTap, mouseDown);
    \$.CGEventPost(\$.kCGHIDEventTap, mouseUp);
  " >/dev/null 2>&1
}

# Generic descriptions to skip when extracting text
SKIP_DESCS_JS="var skipDescs={'group':1,'button':1,'scroll area':1,'collection':1,'text':1,'standard window':1,'image':1,'tab bar':1,'close button':1,'full screen button':1,'minimize button':1};"

# =============================================================================
# screenshot — Capture the app window as a PNG
# =============================================================================
do_screenshot() {
  local output_path
  output_path=$(printf '%s' "$INPUT" | jq -r '.outputPath // empty')
  if [ -z "$output_path" ]; then
    output_path="/tmp/rednote-screenshot-$(date +%s).png"
  fi

  check_app
  ensure_window
  focus_app

  local geom
  geom=$(get_window_geometry)
  local X Y W H
  X=$(echo "$geom" | jq -r '.x')
  Y=$(echo "$geom" | jq -r '.y')
  W=$(echo "$geom" | jq -r '.w')
  H=$(echo "$geom" | jq -r '.h')

  # Small delay to ensure the window is fully rendered after focus
  sleep 0.3

  screencapture -R "${X},${Y},${W},${H}" "$output_path" 2>/dev/null
  if [ ! -f "$output_path" ]; then
    error_exit "Screenshot failed. The app must be on the current Space (not a different desktop)."
  fi

  echo "{\"success\":true,\"action\":\"screenshot\",\"data\":{\"path\":\"$output_path\",\"window\":{\"x\":$X,\"y\":$Y,\"w\":$W,\"h\":$H}}}"
}

# =============================================================================
# tap — Simulate a mouse click at given coordinates
# =============================================================================
do_tap() {
  local tap_x tap_y
  tap_x=$(printf '%s' "$INPUT" | jq -r '.x // empty')
  tap_y=$(printf '%s' "$INPUT" | jq -r '.y // empty')
  require_param "x" "$tap_x"
  require_param "y" "$tap_y"

  check_app
  ensure_window
  focus_app

  click_at "$tap_x" "$tap_y"
  sleep 0.3
  verify_focus

  echo "{\"success\":true,\"action\":\"tap\",\"data\":{\"x\":$tap_x,\"y\":$tap_y}}"
}

# =============================================================================
# Helper: Find AXTextField position via Accessibility API
# Returns JSON: {"found":true/false,"x":N,"y":N,"w":N,"h":N}
# =============================================================================
find_text_field() {
  osascript -l JavaScript -e "
    var app = Application('System Events');
    var proc = app.processes.byName('$APP_NAME');
    var result = {found: false, x: 0, y: 0, w: 0, h: 0};
    function scan(el, depth) {
      if (depth > 20 || result.found) return;
      var role = '';
      try { role = el.role(); } catch(e) {}
      if (role === 'AXTextField' || role === 'AXTextArea') {
        result.found = true;
        try { var p = el.position(); result.x = p[0]; result.y = p[1]; } catch(e) {}
        try { var s = el.size(); result.w = s[0]; result.h = s[1]; } catch(e) {}
        return;
      }
      try {
        var children = el.uiElements();
        for (var i = 0; i < Math.min(children.length, 50); i++) {
          scan(children[i], depth + 1);
          if (result.found) return;
        }
      } catch(e) {}
    }
    var windows = proc.windows();
    for (var w = 0; w < windows.length; w++) { scan(windows[w], 0); }
    JSON.stringify(result);
  " 2>/dev/null || echo '{"found":false}'
}

# =============================================================================
# search — Type a keyword into the search box and read results
#
# Flow: home page → search landing → type keyword → search results
# Handles three starting states:
#   1. Home feed (no text field) — clicks search icon first
#   2. Search landing page (text field present, no results)
#   3. Search results page (text field present, with results)
# =============================================================================
do_search() {
  local keyword
  keyword=$(printf '%s' "$INPUT" | jq -r '.keyword // empty')
  require_param "keyword" "$keyword"

  check_app
  ensure_window
  focus_app

  local geom win_x win_y win_w
  geom=$(get_window_geometry)
  win_x=$(echo "$geom" | jq -r '.x')
  win_y=$(echo "$geom" | jq -r '.y')
  win_w=$(echo "$geom" | jq -r '.w')

  # Step 1: Navigate to search page if on the home feed.
  # Ensure we are not stuck in a deep page (like a profile or detail page)
  for i in {1..5}; do
    local tf_info
    tf_info=$(find_text_field)
    if [ "$(echo "$tf_info" | jq -r '.found')" = "true" ]; then
      break
    fi
    # Try to find and click Return/返回 button via UI tree
    local back_clicked
    back_clicked=$(osascript -l JavaScript -e "
      var app = Application('System Events');
      var proc = app.processes.byName('$APP_NAME');
      var clicked = false;
      function scan(el, depth) {
        if (depth > 15 || clicked) return;
        try {
          var role = el.role();
          var desc = el.description();
          if (role === 'AXButton' && (desc === 'Return' || desc === '返回' || desc === 'close button')) {
            var p = el.position();
            var s = el.size();
            var cx = p[0] + s[0]/2;
            var cy = p[1] + s[1]/2;
            ObjC.import('CoreGraphics');
            var point = \$.CGPointMake(cx, cy);
            var mouseDown = \$.CGEventCreateMouseEvent(null, \$.kCGEventLeftMouseDown, point, \$.kCGMouseButtonLeft);
            var mouseUp = \$.CGEventCreateMouseEvent(null, \$.kCGEventLeftMouseUp, point, \$.kCGMouseButtonLeft);
            \$.CGEventPost(\$.kCGHIDEventTap, mouseDown);
            \$.CGEventPost(\$.kCGHIDEventTap, mouseUp);
            clicked = true;
            return;
          }
        } catch(e) {}
        try {
          var children = el.uiElements();
          for (var j = 0; j < Math.min(children.length, 50); j++) {
            scan(children[j], depth + 1);
            if (clicked) return;
          }
        } catch(e) {}
      }
      var windows = proc.windows();
      for (var w = 0; w < windows.length; w++) { scan(windows[w], 0); }
      clicked;
    " 2>/dev/null || echo "false")
    
    if [ "$back_clicked" = "true" ]; then
      sleep 1.5
      verify_focus
    else
      # Fallback back coordinate
      local bx=$(( win_x + 64 ))
      local by=$(( win_y + 54 ))
      click_at "$bx" "$by"
      sleep 1.5
      verify_focus
    fi
  done

  # Detect current page by checking for an AXTextField (present on search pages).
  local tf_info tf_found
  tf_info=$(find_text_field)
  tf_found=$(echo "$tf_info" | jq -r '.found')

  if [ "$tf_found" != "true" ]; then
    # On the home page — click the search area in the top-right corner.
    verify_focus
    local search_click_x search_click_y
    search_click_x=$(( win_x + win_w - 80 ))
    search_click_y=$(( win_y + 52 ))
    click_at "$search_click_x" "$search_click_y"
    sleep 1
    verify_focus

    # Re-detect text field after page transition
    tf_info=$(find_text_field)
    tf_found=$(echo "$tf_info" | jq -r '.found')
    if [ "$tf_found" != "true" ]; then
      error_exit "Failed to navigate to search page: no text field found after clicking search icon. The app may not be on the home page or search icon position has changed."
    fi
  fi

  # Step 2: Click the text field to ensure it's focused.
  verify_focus
  local field_cx field_cy
  if [ "$tf_found" = "true" ]; then
    local tf_x tf_y tf_w tf_h
    tf_x=$(echo "$tf_info" | jq -r '.x')
    tf_y=$(echo "$tf_info" | jq -r '.y')
    tf_w=$(echo "$tf_info" | jq -r '.w')
    tf_h=$(echo "$tf_info" | jq -r '.h')
    field_cx=$(( tf_x + tf_w / 3 ))
    field_cy=$(( tf_y + tf_h / 2 ))
  else
    field_cx=$(( win_x + 400 ))
    field_cy=$(( win_y + 52 ))
  fi
  click_at "$field_cx" "$field_cy"
  sleep 0.3
  verify_focus

  # Step 3: Clear any existing text (Cmd+A then Delete)
  osascript -l JavaScript -e "
    var se = Application('System Events');
    se.keystroke('a', {using: 'command down'});
    delay(0.2);
    se.keyCode(51); // Delete key
  " >/dev/null 2>&1
  sleep 0.2

  # Step 4: Paste the keyword via clipboard (reliable for CJK characters).
  verify_focus
  printf '%s' "$keyword" | pbcopy
  sleep 0.1
  osascript -l JavaScript -e "
    var se = Application('System Events');
    se.keystroke('v', {using: 'command down'});
  " >/dev/null 2>&1
  sleep 0.5

  # Step 5: Press Enter to submit the search
  verify_focus
  osascript -l JavaScript -e "
    var se = Application('System Events');
    se.keyCode(36); // Enter
  " >/dev/null 2>&1

  # Wait for results to load
  sleep 3

  # Step 6: Read the feed (search results use the same layout)
  local feed_result
  feed_result=$(do_feed_internal 150)

  echo "{\"success\":true,\"action\":\"search\",\"keyword\":$(printf '%s' "$keyword" | jq -Rs .),\"data\":$feed_result}"
}

# =============================================================================
# read-detail — Read a note detail page (screenshot + text extraction)
# =============================================================================
do_read_detail() {
  check_app

  # Take a screenshot of the current detail page
  local screenshot_path="/tmp/rednote-detail-$(date +%s).png"
  focus_app
  sleep 0.3

  local geom
  geom=$(get_window_geometry)
  local X Y W H
  X=$(echo "$geom" | jq -r '.x')
  Y=$(echo "$geom" | jq -r '.y')
  W=$(echo "$geom" | jq -r '.w')
  H=$(echo "$geom" | jq -r '.h')

  screencapture -R "${X},${Y},${W},${H}" "$screenshot_path" 2>/dev/null

  # Extract text via Accessibility API
  local limit
  limit=$(printf '%s' "$INPUT" | jq -r '.limit // 200')

  local text_result
  text_result=$(osascript -l JavaScript -e "
    var app = Application('System Events');
    var proc = app.processes.byName('$APP_NAME');
    $SKIP_DESCS_JS

    var items = [];
    var maxDepth = $MAX_DEPTH;

    function extractAll(el, depth) {
      if (depth > maxDepth || items.length >= $limit) return;
      var role = 'unknown';
      try { role = el.role(); } catch(e) {}

      if (role === 'AXStaticText' || role === 'AXButton' || role === 'AXGenericElement') {
        var text = '';
        try {
          var desc = el.description();
          if (desc && desc.trim().length > 0 && !skipDescs[desc.toLowerCase()]) {
            text = desc;
          }
        } catch(e) {}
        if (!text) {
          try {
            var val = el.value();
            if (val !== null && val !== undefined && String(val).trim().length > 0) {
              text = String(val);
            }
          } catch(e) {}
        }
        if (text) {
          var pos = null;
          try { var p = el.position(); pos = {x: p[0], y: p[1]}; } catch(e) {}
          items.push({role: role, text: text.substring(0, 500), pos: pos});
        }
      }

      try {
        var children = el.uiElements();
        for (var i = 0; i < Math.min(children.length, 100); i++) {
          extractAll(children[i], depth + 1);
          if (items.length >= $limit) return;
        }
      } catch(e) {}
    }

    var windows = proc.windows();
    for (var w = 0; w < windows.length; w++) {
      extractAll(windows[w], 0);
    }
    JSON.stringify(items);
  " 2>&1)

  if [ $? -ne 0 ]; then
    error_exit "Failed to extract detail text: $text_result"
  fi

  local has_screenshot="false"
  if [ -f "$screenshot_path" ]; then
    has_screenshot="true"
  fi

  echo "{\"success\":true,\"action\":\"read-detail\",\"data\":{\"screenshotPath\":\"$screenshot_path\",\"hasScreenshot\":$has_screenshot,\"texts\":$text_result}}"
}

# =============================================================================
# feed — Read structured feed posts (internal helper accepts limit arg)
# =============================================================================
do_feed_internal() {
  local limit="${1:-50}"

  local result
  result=$(osascript -l JavaScript -e "
    var app = Application('System Events');
    var proc = app.processes.byName('$APP_NAME');
    $SKIP_DESCS_JS

    var items = [];
    var maxDepth = $MAX_DEPTH;

    function extractAll(el, depth) {
      if (depth > maxDepth || items.length >= $limit) return;
      var role = 'unknown';
      try { role = el.role(); } catch(e) {}

      if (role === 'AXStaticText' || role === 'AXButton' || role === 'AXGenericElement') {
        var text = '';
        try {
          var desc = el.description();
          if (desc && desc.trim().length > 0 && !skipDescs[desc.toLowerCase()]) {
            text = desc;
          }
        } catch(e) {}
        if (!text) {
          try {
            var val = el.value();
            if (val !== null && val !== undefined && String(val).trim().length > 0) {
              text = String(val);
            }
          } catch(e) {}
        }
        if (text) {
          var pos = null;
          try { var p = el.position(); pos = {x: p[0], y: p[1]}; } catch(e) {}
          items.push({role: role, text: text.substring(0, 500), pos: pos});
        }
      }

      try {
        var children = el.uiElements();
        for (var i = 0; i < Math.min(children.length, 100); i++) {
          extractAll(children[i], depth + 1);
          if (items.length >= $limit) return;
        }
      } catch(e) {}
    }

    var windows = proc.windows();
    for (var w = 0; w < windows.length; w++) {
      extractAll(windows[w], 0);
    }

    var FEED_Y_THRESHOLD = 260;
    var nav = [];
    var posts = [];
    var currentPost = null;

    var navLabels = {'Home':1,'Market':1,'Messages':1,'Me':1,'Following':1,
      'Explore':1,'Video':1,'For You':1,'Live':1,'Series':1,'Travel':1,
      'Career':1,'Food':1,'Comedy':1,'Cars':1,'Digital technology':1,
      'Love & life':1,'Music':1,'Crafts':1,'Fashion':1,'Reading':1,
      'Photography':1,'rednote':1};

    for (var i = 0; i < items.length; i++) {
      var item = items[i];

      if (item.pos && item.pos.y < FEED_Y_THRESHOLD) {
        if (item.text && item.text.length > 0) nav.push(item.text);
        continue;
      }

      if (navLabels[item.text]) {
        nav.push(item.text);
        continue;
      }

      if (item.text === 'Sponsored' || item.text === 'Release Tag') continue;

      var isLikeCount = /^[\d,]+$/.test(item.text);

      if (item.role === 'AXButton') {
        var btnText = item.text.replace('Like','').trim();
        if (item.text === 'Like' || /^[\d,]+$/.test(btnText)) {
          if (currentPost) {
            currentPost.likes = (item.text === 'Like') ? '0' : item.text;
            posts.push(currentPost);
            currentPost = null;
          }
          continue;
        }
      }

      if (item.role === 'AXStaticText' && isLikeCount) {
        if (currentPost) {
          currentPost.likes = item.text;
          posts.push(currentPost);
          currentPost = null;
        }
        continue;
      }

      if (item.role === 'AXStaticText') {
        if (!currentPost) {
          currentPost = {title: item.text};
        } else if (!currentPost.author) {
          currentPost.author = item.text;
        } else {
          posts.push(currentPost);
          currentPost = {title: item.text};
        }
      }
    }
    if (currentPost) posts.push(currentPost);

    var uniquePosts = [];
    var seenTitles = {};
    for (var j = 0; j < posts.length; j++) {
      var pt = posts[j].title;
      if (pt && pt.trim() !== '' && !seenTitles[pt]) {
        seenTitles[pt] = true;
        uniquePosts.push(posts[j]);
      }
    }

    JSON.stringify({nav: nav, posts: uniquePosts, totalItems: items.length});
  " 2>&1)

  if [ $? -ne 0 ]; then
    error_exit "Failed to read feed: $result"
  fi
  echo "$result"
}

# =============================================================================
# feed — Public entry point
# =============================================================================
do_feed() {
  local limit
  limit=$(printf '%s' "$INPUT" | jq -r '.limit // 50')
  check_app
  ensure_window

  local result
  result=$(do_feed_internal "$limit")
  echo "{\"success\":true,\"action\":\"feed\",\"data\":$result}"
}

# =============================================================================
# scroll-feed — Scroll the feed and read new content
# =============================================================================
do_scroll_feed() {
  local amount
  amount=$(printf '%s' "$INPUT" | jq -r '.amount // 5')
  check_app
  ensure_window
  focus_app

  # Scroll down
  osascript -l JavaScript -e "
    ObjC.import('CoreGraphics');
    var event = \$.CGEventCreateScrollWheelEvent(null, \$.kCGScrollEventUnitLine, 2, $(( -amount )), 0);
    \$.CGEventPost(\$.kCGHIDEventTap, event);
  " >/dev/null 2>&1
  sleep 0.5

  # Now read the feed
  do_feed
}

# =============================================================================
# nav — Read navigation structure
# =============================================================================
do_nav() {
  check_app
  ensure_window

  local result
  result=$(osascript -l JavaScript -e "
    var app = Application('System Events');
    var proc = app.processes.byName('$APP_NAME');
    $SKIP_DESCS_JS
    var nav = {bottomTabs: [], topTabs: [], categories: [], searchHint: ''};

    function scan(el, depth) {
      if (depth > $MAX_DEPTH) return;
      var role = 'unknown';
      try { role = el.role(); } catch(e) {}

      if (role === 'AXStaticText' || role === 'AXGenericElement') {
        var text = '';
        try { var d = el.description(); if (d && !skipDescs[d.toLowerCase()]) text = d; } catch(e) {}
        if (!text) try { var v = el.value(); if (v) text = String(v); } catch(e) {}

        if (text) {
          var pos = null;
          try { var p = el.position(); pos = {x: p[0], y: p[1]}; } catch(e) {}

          if (pos && pos.y > 990) {
            nav.bottomTabs.push(text);
          }
          else if (['Following','Explore','Video'].indexOf(text) >= 0) {
            nav.topTabs.push(text);
          }
          else if (pos && pos.y >= 190 && pos.y <= 250 && depth >= 20) {
            nav.categories.push(text);
          }
        }
      }

      if (role === 'AXGroup') {
        try {
          var desc = el.description();
          if (desc === '搜索' || desc === 'search') {
            nav.searchHint = desc;
          }
        } catch(e) {}
      }

      try {
        var children = el.uiElements();
        for (var i = 0; i < Math.min(children.length, 50); i++) {
          scan(children[i], depth + 1);
        }
      } catch(e) {}
    }

    var windows = proc.windows();
    for (var w = 0; w < windows.length; w++) {
      scan(windows[w], 0);
    }
    JSON.stringify(nav);
  " 2>&1)

  if [ $? -ne 0 ]; then
    error_exit "Failed to read nav: $result"
  fi
  echo "{\"success\":true,\"action\":\"nav\",\"data\":$result}"
}

# =============================================================================
# raw — Raw text dump
# =============================================================================
do_raw() {
  local limit
  limit=$(printf '%s' "$INPUT" | jq -r '.limit // 50')
  check_app
  ensure_window

  local result
  result=$(osascript -l JavaScript -e "
    var app = Application('System Events');
    var proc = app.processes.byName('$APP_NAME');
    $SKIP_DESCS_JS
    var texts = [];
    var maxDepth = $MAX_DEPTH;

    function extract(el, depth) {
      if (depth > maxDepth || texts.length >= $limit) return;
      var role = 'unknown';
      try { role = el.role(); } catch(e) {}

      try {
        var val = el.value();
        if (val !== null && val !== undefined && String(val).trim().length > 0) {
          texts.push({role: role, text: String(val).substring(0, 1000)});
        }
      } catch(e) {}
      try {
        var title = el.title();
        if (title && title.trim().length > 0) {
          texts.push({role: role, text: title});
        }
      } catch(e) {}
      try {
        var desc = el.description();
        if (desc && desc.trim().length > 0 && !skipDescs[desc.toLowerCase()]) {
          texts.push({role: role, text: desc});
        }
      } catch(e) {}
      try {
        var children = el.uiElements();
        for (var i = 0; i < Math.min(children.length, 100); i++) {
          extract(children[i], depth + 1);
          if (texts.length >= $limit) return;
        }
      } catch(e) {}
    }

    var windows = proc.windows();
    for (var w = 0; w < windows.length; w++) {
      extract(windows[w], 0);
    }

    var seen = {};
    var unique = [];
    for (var i = 0; i < texts.length; i++) {
      if (!seen[texts[i].text]) {
        seen[texts[i].text] = true;
        unique.push(texts[i]);
      }
    }
    JSON.stringify(unique);
  " 2>&1)

  if [ $? -ne 0 ]; then
    error_exit "Failed to read raw text: $result"
  fi
  echo "{\"success\":true,\"action\":\"raw\",\"texts\":$result}"
}

# =============================================================================
# goto-profile — Navigate to a user's profile by username
#
# Searches all AXStaticText elements for the exact username string,
# clicks on it, waits for page transition, and reads profile data.
# =============================================================================
do_goto_profile() {
  local username
  username=$(printf '%s' "$INPUT" | jq -r '.username // empty')
  require_param "username" "$username"
  local max_retries
  max_retries=$(printf '%s' "$INPUT" | jq -r '.retry // 1')
  local goto_timeout_sec
  goto_timeout_sec=$(printf '%s' "$INPUT" | jq -r '.timeoutSec // 35')
  local fallback_first_card
  fallback_first_card=$(printf '%s' "$INPUT" | jq -r '.fallbackFirstCard // true')
  local goto_started_epoch
  goto_started_epoch=$(date +%s 2>/dev/null || echo 0)

  check_app
  ensure_window
  focus_app

  # Attempt to click "Users" / "用户" tab first to ensure we are on the right tab
  osascript -l JavaScript -e "
    var app = Application('System Events');
    var proc = app.processes.byName('$APP_NAME');
    var clicked = false;
    function scan(el, depth) {
      if (depth > 20 || clicked) return;
      try {
        var role = el.role();
        var text = '';
        try { var d = el.description(); if (d) text = d; } catch(e) {}
        if (!text) try { var v = el.value(); if (v) text = String(v); } catch(e) {}
        if (!text) try { var t = el.title(); if (t) text = t; } catch(e) {}
        if (!text) try { var n = el.name(); if (n) text = String(n); } catch(e) {}

        if ((role === 'AXStaticText' || role === 'AXGenericElement' || role === 'AXButton') && (text === 'Users' || text === '用户')) {
          var p = el.position();
          var s = el.size();
          if (p && s && p[1] >= 180 && p[1] <= 300) {
            var cx = p[0] + s[0]/2;
            var cy = p[1] + s[1]/2;
            ObjC.import('CoreGraphics');
            var point = \$.CGPointMake(cx, cy);
            var mouseDown = \$.CGEventCreateMouseEvent(null, \$.kCGEventLeftMouseDown, point, \$.kCGMouseButtonLeft);
            var mouseUp = \$.CGEventCreateMouseEvent(null, \$.kCGEventLeftMouseUp, point, \$.kCGMouseButtonLeft);
            \$.CGEventPost(\$.kCGHIDEventTap, mouseDown);
            \$.CGEventPost(\$.kCGHIDEventTap, mouseUp);
            clicked = true;
            return;
          }
        }
      } catch(e) {}
      try {
        var children = el.uiElements();
        for (var j = 0; j < Math.min(children.length, 50); j++) {
          scan(children[j], depth + 1);
          if (clicked) return;
        }
      } catch(e) {}
    }
    var windows = proc.windows();
    for (var w = 0; w < windows.length; w++) { scan(windows[w], 0); }
  " >/dev/null 2>&1
  sleep 1.5
  verify_focus

  # Search all AXStaticText elements for the username and get its position.
  # Matching strategy: exact -> prefix -> contains (normalized), with retry.
  local attempt=0
  local found="false"
  local click_x=0 click_y=0 candidate_count=0 matched_candidate="" normalized_query=""
  local started_at ended_at elapsed_ms
  started_at=$(( $(date +%s 2>/dev/null || echo 0) * 1000 ))

  while [ "$attempt" -le "$max_retries" ]; do
    local now_epoch
    now_epoch=$(date +%s 2>/dev/null || echo 0)
    if [ $((now_epoch - goto_started_epoch)) -ge "$goto_timeout_sec" ]; then
      echo "{\"success\":false,\"action\":\"goto-profile\",\"errorCode\":\"timeout\",\"message\":\"goto-profile timed out before candidate match.\",\"log\":{\"attempt\":$attempt,\"elapsedMs\":$(( (now_epoch - goto_started_epoch) * 1000 )),\"candidateCount\":$candidate_count,\"normalizedQuery\":$(printf '%s' "$normalized_query" | jq -Rs .),\"matchedCandidate\":$(printf '%s' "$matched_candidate" | jq -Rs .)}}"
      return 1
    fi
    local match_result
    match_result=$(osascript -l JavaScript -e "
      var app = Application('System Events');
      var proc = app.processes.byName('$APP_NAME');
      var target = $(printf '%s' "$username" | jq -Rs .);
      var maxDepth = $MAX_DEPTH;
      function norm(s) {
        if (!s) return '';
        return String(s)
          .toLowerCase()
          .replace(/[\\s\\u3000]/g, '')
          .replace(/[()（）\\[\\]{}]/g, '')
          .replace(/[：:·•。,.，!！?？'\"‘’“”-_]/g, '');
      }
      var targetNorm = norm(target);
      var candidates = [];
      var best = {found:false, x:0, y:0, score:0, matched:''};
      function rank(tn, qn) {
        if (!tn || !qn) return 0;
        if (tn === qn) return 3;
        if (tn.indexOf(qn) === 0 || qn.indexOf(tn) === 0) return 2;
        if (tn.indexOf(qn) >= 0 || qn.indexOf(tn) >= 0) return 1;
        return 0;
      }
      function scan(el, depth) {
        if (depth > maxDepth) return;
        var role = '';
        try { role = el.role(); } catch(e) {}
        if (role === 'AXStaticText' || role === 'AXButton' || role === 'AXGenericElement') {
          var text = '';
          try { var d = el.description(); if (d && d.trim().length > 0) text = d; } catch(e) {}
          if (!text) { try { var v = el.value(); if (v !== null && v !== undefined) text = String(v); } catch(e) {} }
          if (text) {
            var tn = norm(text);
            var score = rank(tn, targetNorm);
            if (score > 0) {
              try {
                var p = el.position();
                var s = el.size();
                if (p && s && p[1] >= 220 && p[1] <= 980) {
                  candidates.push({text:text, score:score});
                  if (score > best.score) {
                    best = {found:true, x:p[0] + Math.floor(s[0]/2), y:p[1] + Math.floor(s[1]/2), score:score, matched:text};
                  }
                }
              } catch(e) {}
            }
          }
        }
        try {
          var children = el.uiElements();
          for (var i = 0; i < Math.min(children.length, 120); i++) scan(children[i], depth + 1);
        } catch(e) {}
      }
      var windows = proc.windows();
      for (var w = 0; w < windows.length; w++) scan(windows[w], 0);
      JSON.stringify({
        found: best.found,
        x: best.x,
        y: best.y,
        candidateCount: candidates.length,
        normalizedQuery: targetNorm,
        matchedCandidate: best.matched
      });
    " 2>/dev/null || echo '{"found":false,"candidateCount":0,"normalizedQuery":"","matchedCandidate":""}')
    found=$(echo "$match_result" | jq -r '.found')
    click_x=$(echo "$match_result" | jq -r '.x // 0')
    click_y=$(echo "$match_result" | jq -r '.y // 0')
    candidate_count=$(echo "$match_result" | jq -r '.candidateCount // 0')
    normalized_query=$(echo "$match_result" | jq -r '.normalizedQuery // ""')
    matched_candidate=$(echo "$match_result" | jq -r '.matchedCandidate // ""')

    if [ "$found" = "true" ]; then
      break
    fi

    attempt=$((attempt + 1))
    if [ "$attempt" -le "$max_retries" ]; then
      sleep 1
      verify_focus
    fi
  done

  # Fallback: if no candidates are visible, run a fresh search with username once
  # and retry the same matching loop.
  if [ "$found" != "true" ] && [ "$candidate_count" -eq 0 ]; then
    # Explicit retry path: re-focus and re-open Users candidate list once.
    verify_focus
    osascript -l JavaScript -e "
      var app = Application('System Events');
      var proc = app.processes.byName('$APP_NAME');
      var clicked = false;
      function scan(el, depth) {
        if (depth > 20 || clicked) return;
        try {
          var role = el.role();
          var text = '';
          try { var d = el.description(); if (d) text = d; } catch(e) {}
          if (!text) try { var v = el.value(); if (v) text = String(v); } catch(e) {}
          if (!text) try { var t = el.title(); if (t) text = t; } catch(e) {}
          if ((role === 'AXStaticText' || role === 'AXGenericElement' || role === 'AXButton') && (text === 'Users' || text === '用户')) {
            var p = el.position(); var s = el.size();
            if (p && s) {
              ObjC.import('CoreGraphics');
              var point = \$.CGPointMake(p[0] + s[0]/2, p[1] + s[1]/2);
              var mouseDown = \$.CGEventCreateMouseEvent(null, \$.kCGEventLeftMouseDown, point, \$.kCGMouseButtonLeft);
              var mouseUp = \$.CGEventCreateMouseEvent(null, \$.kCGEventLeftMouseUp, point, \$.kCGMouseButtonLeft);
              \$.CGEventPost(\$.kCGHIDEventTap, mouseDown);
              \$.CGEventPost(\$.kCGHIDEventTap, mouseUp);
              clicked = true;
            }
          }
        } catch(e) {}
        try {
          var children = el.uiElements();
          for (var j = 0; j < Math.min(children.length, 50); j++) {
            scan(children[j], depth + 1);
            if (clicked) return;
          }
        } catch(e) {}
      }
      var windows = proc.windows();
      for (var w = 0; w < windows.length; w++) scan(windows[w], 0);
    " >/dev/null 2>&1
    sleep 1

    local _old_input _kw_json
    _old_input="$INPUT"
    _kw_json=$(printf '%s' "$username" | jq -Rs .)
    INPUT="{\"action\":\"search\",\"keyword\":${_kw_json}}"
    do_search >/tmp/rednote-goto-fallback-search-$$.json 2>/dev/null || true
    INPUT="$_old_input"
    sleep 1
    verify_focus

    attempt=0
    while [ "$attempt" -le "$max_retries" ]; do
      local now_epoch_retry
      now_epoch_retry=$(date +%s 2>/dev/null || echo 0)
      if [ $((now_epoch_retry - goto_started_epoch)) -ge "$goto_timeout_sec" ]; then
        echo "{\"success\":false,\"action\":\"goto-profile\",\"errorCode\":\"timeout\",\"message\":\"goto-profile timed out during retry path.\",\"log\":{\"attempt\":$attempt,\"elapsedMs\":$(( (now_epoch_retry - goto_started_epoch) * 1000 )),\"candidateCount\":$candidate_count,\"normalizedQuery\":$(printf '%s' "$normalized_query" | jq -Rs .),\"matchedCandidate\":$(printf '%s' "$matched_candidate" | jq -Rs .)}}"
        return 1
      fi
      local match_result_retry
      match_result_retry=$(osascript -l JavaScript -e "
        var app = Application('System Events');
        var proc = app.processes.byName('$APP_NAME');
        var target = $(printf '%s' "$username" | jq -Rs .);
        var maxDepth = $MAX_DEPTH;
        function norm(s) {
          if (!s) return '';
          return String(s)
            .toLowerCase()
            .replace(/[\\s\\u3000]/g, '')
            .replace(/[()（）\\[\\]{}]/g, '')
            .replace(/[：:·•。,.，!！?？'\"‘’“”-_]/g, '');
        }
        var targetNorm = norm(target);
        var candidates = [];
        var best = {found:false, x:0, y:0, score:0, matched:''};
        function rank(tn, qn) {
          if (!tn || !qn) return 0;
          if (tn === qn) return 3;
          if (tn.indexOf(qn) === 0 || qn.indexOf(tn) === 0) return 2;
          if (tn.indexOf(qn) >= 0 || qn.indexOf(tn) >= 0) return 1;
          return 0;
        }
        function scan(el, depth) {
          if (depth > maxDepth) return;
          var role = '';
          try { role = el.role(); } catch(e) {}
          if (role === 'AXStaticText' || role === 'AXButton' || role === 'AXGenericElement') {
            var text = '';
            try { var d = el.description(); if (d && d.trim().length > 0) text = d; } catch(e) {}
            if (!text) { try { var v = el.value(); if (v !== null && v !== undefined) text = String(v); } catch(e) {} }
            if (text) {
              var tn = norm(text);
              var score = rank(tn, targetNorm);
              if (score > 0) {
                try {
                  var p = el.position();
                  var s = el.size();
                  if (p && s && p[1] >= 220 && p[1] <= 980) {
                    candidates.push({text:text, score:score});
                    if (score > best.score) {
                      best = {found:true, x:p[0] + Math.floor(s[0]/2), y:p[1] + Math.floor(s[1]/2), score:score, matched:text};
                    }
                  }
                } catch(e) {}
              }
            }
          }
          try {
            var children = el.uiElements();
            for (var i = 0; i < Math.min(children.length, 120); i++) scan(children[i], depth + 1);
          } catch(e) {}
        }
        var windows = proc.windows();
        for (var w = 0; w < windows.length; w++) scan(windows[w], 0);
        JSON.stringify({
          found: best.found,
          x: best.x,
          y: best.y,
          candidateCount: candidates.length,
          normalizedQuery: targetNorm,
          matchedCandidate: best.matched
        });
      " 2>/dev/null || echo '{"found":false,"candidateCount":0,"normalizedQuery":"","matchedCandidate":""}')
      found=$(echo "$match_result_retry" | jq -r '.found')
      click_x=$(echo "$match_result_retry" | jq -r '.x // 0')
      click_y=$(echo "$match_result_retry" | jq -r '.y // 0')
      candidate_count=$(echo "$match_result_retry" | jq -r '.candidateCount // 0')
      normalized_query=$(echo "$match_result_retry" | jq -r '.normalizedQuery // ""')
      matched_candidate=$(echo "$match_result_retry" | jq -r '.matchedCandidate // ""')
      if [ "$found" = "true" ]; then
        break
      fi
      attempt=$((attempt + 1))
      if [ "$attempt" -le "$max_retries" ]; then
        sleep 1
        verify_focus
      fi
    done
  fi

  ended_at=$(( $(date +%s 2>/dev/null || echo 0) * 1000 ))
  elapsed_ms=$((ended_at - started_at))
  if [ "$elapsed_ms" -lt 0 ]; then elapsed_ms=0; fi

  # Optional fallback mode: deterministic clicks on top user-card regions when
  # no candidates are detected, then verify profile keywords.
  if [ "$candidate_count" -eq 0 ] && [ "$found" != "true" ] && [ "$fallback_first_card" = "true" ]; then
    verify_focus
    local geom fx fy
    geom=$(get_window_geometry)

    local fallback_profile_data fallback_is_profile fallback_texts fallback_now
    local try_idx=0
    local fallback_hit="false"
    local fx1 fy1 fx2 fy2 fx3 fy3
    fx1=$(echo "$geom" | jq -r '.x + ((.w * 0.22)|floor)')
    fy1=$(echo "$geom" | jq -r '.y + ((.h * 0.28)|floor)')
    fx2=$(echo "$geom" | jq -r '.x + ((.w * 0.22)|floor)')
    fy2=$(echo "$geom" | jq -r '.y + ((.h * 0.40)|floor)')
    fx3=$(echo "$geom" | jq -r '.x + ((.w * 0.22)|floor)')
    fy3=$(echo "$geom" | jq -r '.y + ((.h * 0.52)|floor)')
    local fallback_points="${fx1},${fy1} ${fx2},${fy2} ${fx3},${fy3}"

    for pt in $fallback_points; do
      fx="${pt%,*}"
      fy="${pt#*,}"
      click_at "$fx" "$fy"
      sleep 1
      verify_focus
      sleep 1

      fallback_profile_data=$(osascript -l JavaScript -e "
      var app = Application('System Events');
      var proc = app.processes.byName('$APP_NAME');
      var maxDepth = $MAX_DEPTH;
      var texts = [];
      function extract(el, depth) {
        if (depth > maxDepth || texts.length >= 80) return;
        var role = '';
        try { role = el.role(); } catch(e) {}
        if (role === 'AXStaticText' || role === 'AXButton' || role === 'AXGenericElement') {
          var text = '';
          try { var d = el.description(); if (d && d.trim().length > 0) text = d; } catch(e) {}
          if (!text) { try { var v = el.value(); if (v !== null && v !== undefined && String(v).trim().length > 0) text = String(v); } catch(e) {} }
          if (text) texts.push({role: role, text: text.substring(0, 300)});
        }
        try {
          var children = el.uiElements();
          for (var i = 0; i < Math.min(children.length, 80); i++) {
            extract(children[i], depth + 1);
            if (texts.length >= 80) return;
          }
        } catch(e) {}
      }
      var windows = proc.windows();
      for (var w = 0; w < windows.length; w++) extract(windows[w], 0);
      var isProfile = false;
      for (var i = 0; i < texts.length; i++) {
        var t = texts[i].text;
        if (/follow/i.test(t) || /粉丝/.test(t) || /关注/.test(t) || /获赞/.test(t)) {
          isProfile = true; break;
        }
      }
      JSON.stringify({isProfile:isProfile, texts:texts});
    " 2>/dev/null || echo '{"isProfile":false,"texts":[]}')
      fallback_is_profile=$(echo "$fallback_profile_data" | jq -r '.isProfile')
      fallback_texts=$(echo "$fallback_profile_data" | jq -c '.texts')
      fallback_now=$(date +%s 2>/dev/null || echo 0)
      if [ $((fallback_now - goto_started_epoch)) -ge "$goto_timeout_sec" ]; then
        echo "{\"success\":false,\"action\":\"goto-profile\",\"errorCode\":\"timeout\",\"message\":\"goto-profile timed out after fallback click.\",\"log\":{\"attempt\":$attempt,\"elapsedMs\":$(( (fallback_now - goto_started_epoch) * 1000 )),\"candidateCount\":$candidate_count,\"normalizedQuery\":$(printf '%s' "$normalized_query" | jq -Rs .),\"matchedCandidate\":$(printf '%s' "$matched_candidate" | jq -Rs .),\"fallbackMode\":\"first_user_card_multi\",\"fallbackClickedAt\":{\"x\":$fx,\"y\":$fy},\"fallbackTry\":$try_idx}}"
        return 1
      fi
      if [ "$fallback_is_profile" = "true" ]; then
        fallback_hit="true"
        break
      fi
      # Best-effort back one step before trying next candidate region.
      osascript -l JavaScript -e "
        ObjC.import('CoreGraphics');
        var ev = \$.CGEventCreateKeyboardEvent(null, 123, true);
        \$.CGEventSetFlags(ev, \$.kCGEventFlagMaskCommand);
        \$.CGEventPost(\$.kCGHIDEventTap, ev);
      " >/dev/null 2>&1 || true
      sleep 0.6
      try_idx=$((try_idx + 1))
    done
    if [ "$fallback_hit" = "true" ]; then
      echo "{\"success\":true,\"action\":\"goto-profile\",\"data\":{\"username\":$(printf '%s' "$username" | jq -Rs .),\"clickedAt\":{\"x\":$fx,\"y\":$fy},\"isProfilePage\":true,\"texts\":$fallback_texts},\"log\":{\"attempt\":$attempt,\"elapsedMs\":$elapsed_ms,\"candidateCount\":$candidate_count,\"normalizedQuery\":$(printf '%s' "$normalized_query" | jq -Rs .),\"matchedCandidate\":$(printf '%s' "$matched_candidate" | jq -Rs .),\"fallbackMode\":\"first_user_card_multi\"}}"
      return 0
    fi
    echo "{\"success\":false,\"action\":\"goto-profile\",\"errorCode\":\"not_found\",\"message\":\"Fallback first-user-card clicks did not reach profile page.\",\"log\":{\"attempt\":$attempt,\"elapsedMs\":$elapsed_ms,\"candidateCount\":$candidate_count,\"normalizedQuery\":$(printf '%s' "$normalized_query" | jq -Rs .),\"matchedCandidate\":$(printf '%s' "$matched_candidate" | jq -Rs .),\"fallbackMode\":\"first_user_card_multi\",\"fallbackClickedAt\":{\"x\":$fx,\"y\":$fy},\"fallbackTry\":$try_idx}}"
    return 1
  fi

  if [ "$candidate_count" -eq 0 ]; then
    echo "{\"success\":false,\"action\":\"goto-profile\",\"errorCode\":\"search_results_unavailable\",\"message\":\"No user candidates detected on screen.\",\"log\":{\"attempt\":$attempt,\"elapsedMs\":$elapsed_ms,\"candidateCount\":$candidate_count,\"normalizedQuery\":$(printf '%s' "$normalized_query" | jq -Rs .),\"matchedCandidate\":$(printf '%s' "$matched_candidate" | jq -Rs .)}}"
    return 1
  fi
  if [ "$found" != "true" ]; then
    echo "{\"success\":false,\"action\":\"goto-profile\",\"errorCode\":\"retry_exhausted\",\"message\":\"Username not matched after retry.\",\"log\":{\"attempt\":$attempt,\"elapsedMs\":$elapsed_ms,\"candidateCount\":$candidate_count,\"normalizedQuery\":$(printf '%s' "$normalized_query" | jq -Rs .),\"matchedCandidate\":$(printf '%s' "$matched_candidate" | jq -Rs .)}}"
    return 1
  fi

  # Click on the username
  verify_focus
  click_at "$click_x" "$click_y"
  sleep 1
  verify_focus

  # Wait for profile page to load and read profile data
  sleep 1

  local profile_data
  profile_data=$(osascript -l JavaScript -e "
    var app = Application('System Events');
    var proc = app.processes.byName('$APP_NAME');
    var maxDepth = $MAX_DEPTH;
    var texts = [];

    function extract(el, depth) {
      if (depth > maxDepth || texts.length >= 100) return;
      var role = '';
      try { role = el.role(); } catch(e) {}

      if (role === 'AXStaticText' || role === 'AXButton' || role === 'AXGenericElement') {
        var text = '';
        try {
          var desc = el.description();
          if (desc && desc.trim().length > 0) text = desc;
        } catch(e) {}
        if (!text) {
          try {
            var val = el.value();
            if (val !== null && val !== undefined && String(val).trim().length > 0) text = String(val);
          } catch(e) {}
        }
        if (text) {
          var pos = null;
          try { var p = el.position(); pos = {x: p[0], y: p[1]}; } catch(e) {}
          texts.push({role: role, text: text.substring(0, 500), pos: pos});
        }
      }

      try {
        var children = el.uiElements();
        for (var i = 0; i < Math.min(children.length, 100); i++) {
          extract(children[i], depth + 1);
          if (texts.length >= 100) return;
        }
      } catch(e) {}
    }

    var windows = proc.windows();
    for (var w = 0; w < windows.length; w++) { extract(windows[w], 0); }

    // Look for profile indicators: follower/following counts, bio, etc.
    var isProfile = false;
    var profileInfo = {username: '', followers: '', following: '', likes: '', bio: ''};
    for (var i = 0; i < texts.length; i++) {
      var t = texts[i].text;
      if (/follow/i.test(t) || /粉丝/.test(t) || /关注/.test(t) || /获赞/.test(t)) {
        isProfile = true;
      }
    }
    JSON.stringify({isProfile: isProfile, texts: texts});
  " 2>/dev/null || echo '{"isProfile":false,"texts":[]}')

  local is_profile
  is_profile=$(echo "$profile_data" | jq -r '.isProfile')
  local profile_texts
  profile_texts=$(echo "$profile_data" | jq -c '.texts')

  if [ "$is_profile" != "true" ]; then
    echo "{\"success\":false,\"action\":\"goto-profile\",\"errorCode\":\"not_found\",\"message\":\"Clicked candidate but profile indicators not detected.\",\"log\":{\"attempt\":$attempt,\"elapsedMs\":$elapsed_ms,\"candidateCount\":$candidate_count,\"normalizedQuery\":$(printf '%s' "$normalized_query" | jq -Rs .),\"matchedCandidate\":$(printf '%s' "$matched_candidate" | jq -Rs .)},\"data\":{\"username\":$(printf '%s' "$username" | jq -Rs .),\"clickedAt\":{\"x\":$click_x,\"y\":$click_y},\"isProfilePage\":$is_profile,\"texts\":$profile_texts}}"
    return 1
  fi

  echo "{\"success\":true,\"action\":\"goto-profile\",\"data\":{\"username\":$(printf '%s' "$username" | jq -Rs .),\"clickedAt\":{\"x\":$click_x,\"y\":$click_y},\"isProfilePage\":$is_profile,\"texts\":$profile_texts},\"log\":{\"attempt\":$attempt,\"elapsedMs\":$elapsed_ms,\"candidateCount\":$candidate_count,\"normalizedQuery\":$(printf '%s' "$normalized_query" | jq -Rs .),\"matchedCandidate\":$(printf '%s' "$matched_candidate" | jq -Rs .)}}"
}

# =============================================================================
# Dispatch
# =============================================================================
case "$ACTION" in
  feed)          do_feed ;;
  scroll-feed)   do_scroll_feed ;;
  nav)           do_nav ;;
  raw)           do_raw ;;
  screenshot)    do_screenshot ;;
  search)        do_search ;;
  tap)           do_tap ;;
  read-detail)   do_read_detail ;;
  goto-profile)  do_goto_profile ;;
  *)             error_exit "Unknown action: $ACTION (use feed, scroll-feed, nav, raw, screenshot, search, tap, read-detail, goto-profile)" ;;
esac
