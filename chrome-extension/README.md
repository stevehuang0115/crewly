# Crewly Remote Browser — Chrome Extension Demo

Allows Crewly Cloud agents to remotely operate a user's Chrome browser via WebSocket.

## Quick Start

### 1. Install test server dependencies

```bash
cd chrome-extension/
npm install
```

### 2. Load the extension in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this `chrome-extension/` folder
5. The Crewly Remote icon appears in your toolbar

### 3. Start the test server

```bash
node test-server.js
# or: node test-server.js 9333  (custom port)
```

### 4. Connect the extension

1. Click the Crewly Remote icon in Chrome toolbar
2. Enter `ws://localhost:9222` (or your custom port)
3. Click **Connect** — status turns green

### 5. Send commands from the test server CLI

```
navigate https://example.com     — Open a URL
screenshot                        — Capture visible tab
readText                          — Read full page text
readText h1                       — Read text of an element
getTabs                           — List all tabs
exec document.title               — Run JS in active tab
help                              — Show all commands
```

## Supported Tools

| Tool | Params | Returns | Chrome API |
|------|--------|---------|------------|
| `navigate` | `url` | title, url | `chrome.tabs.update` |
| `screenshot` | — | base64 PNG | `chrome.tabs.captureVisibleTab` |
| `readText` | `selector` (optional) | text content | `chrome.scripting.executeScript` |
| `getTabs` | — | tab list | `chrome.tabs.query` |
| `executeScript` | `code` | result | `chrome.scripting.executeScript` |

## Command Format

```json
// Request (server → extension)
{"id": "cmd-1", "tool": "navigate", "params": {"url": "https://example.com"}}

// Response (extension → server)
{"id": "cmd-1", "success": true, "result": {"title": "Example Domain", "url": "https://example.com/"}}
```

## Architecture

```
Test Server (Node.js)  ←— WebSocket —→  Background SW  ←— Chrome APIs —→  Browser
     ↑                                       ↑
  CLI input                              Popup UI
```

- **background.js** — Service Worker: WebSocket connection, command routing, heartbeat
- **popup.html/js** — UI for server URL input and connection status
- **content.js** — Content script placeholder (DOM ops use `chrome.scripting.executeScript`)
- **test-server.js** — Node.js WebSocket server with interactive CLI

## Notes

- The Service Worker has a 5-minute idle timeout in Chrome. The extension sends heartbeat pings every 25s to keep it alive.
- Auto-reconnects on disconnection (3s delay).
- Saves the server URL to `chrome.storage.local` and auto-reconnects on browser restart.
