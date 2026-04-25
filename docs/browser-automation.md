# Browser Automation

Crewly agents can automate browser tasks using the [Playwright MCP Server](https://www.npmjs.com/package/@playwright/mcp). This enables agents to navigate web pages, fill forms, click buttons, take screenshots, and extract data.

## How It Works

When an agent session starts, Crewly automatically:

1. Reads your browser automation settings
2. Generates a `.mcp.json` config file in the project directory
3. Claude Code picks up the config and makes Playwright tools available

The agent can then use `mcp__playwright__*` tools (navigate, click, fill, screenshot, etc.) without any manual setup.

## Enabling Browser Automation

Browser automation is **enabled by default**. You can configure it in two ways:

### Global Setting (all agents)

In the Crewly Settings page, toggle **Enable Browser Automation** under the Skills section. This controls all agents.

The setting is stored in `~/.crewly/settings.json`:

```json
{
  "skills": {
    "enableBrowserAutomation": true,
    "browserProfile": {
      "headless": true,
      "stealth": false,
      "humanDelayMinMs": 300,
      "humanDelayMaxMs": 1200
    }
  }
}
```

### Per-Agent Override

You can enable or disable browser automation for individual team members by setting `enableBrowserAutomation` on the member config. This overrides the global setting.

Example team configuration:

```json
{
  "members": [
    {
      "name": "Web Scraper",
      "role": "developer",
      "enableBrowserAutomation": true
    },
    {
      "name": "Code Reviewer",
      "role": "qa-engineer",
      "enableBrowserAutomation": false
    }
  ]
}
```

When `enableBrowserAutomation` is not set on a member, the global setting is used.

## Configuration Options

### Headless Mode

When `headless: true` (default), the browser runs invisibly in the background. Set to `false` if you need to see the browser window during automation.

### Stealth Mode

When `stealth: true`, Crewly uses a community fork (`@mcp-world/playwright-mcp-world`) that includes anti-detection features. This helps avoid bot detection on sites that block automated browsers.

**Default:** `false` (uses the official `@playwright/mcp` package)

### Human Delay

Controls the pause between browser actions to simulate human-like behavior:

- `humanDelayMinMs`: Minimum delay in milliseconds (default: 300)
- `humanDelayMaxMs`: Maximum delay in milliseconds (default: 1200)

The actual delay for each action is randomly chosen between min and max.

## Available Browser Tools

When browser automation is enabled, agents have access to these MCP tools:

| Tool | Description |
|------|-------------|
| `mcp__playwright__browser_navigate` | Navigate to a URL |
| `mcp__playwright__browser_screenshot` | Take a screenshot |
| `mcp__playwright__browser_click` | Click an element |
| `mcp__playwright__browser_fill` | Fill an input field |
| `mcp__playwright__browser_select` | Select from a dropdown |
| `mcp__playwright__browser_hover` | Hover over an element |
| `mcp__playwright__browser_evaluate` | Run JavaScript on the page |
| `mcp__playwright__browser_console_messages` | Get console output |
| `mcp__playwright__browser_network_requests` | Monitor network activity |
| `mcp__playwright__browser_tab_list` | List open tabs |
| `mcp__playwright__browser_tab_new` | Open a new tab |
| `mcp__playwright__browser_tab_select` | Switch tabs |
| `mcp__playwright__browser_tab_close` | Close a tab |
| `mcp__playwright__browser_close` | Close the browser |

## Generated Config

Crewly generates a `.mcp.json` file in the project root. Example:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--headless",
        "--human-delay-min", "300",
        "--human-delay-max", "1200"
      ]
    }
  }
}
```

The file is listed in `.gitignore` — it is per-machine config and should not be committed.

If you have an existing `.mcp.json` with other MCP servers, Crewly merges its config without overwriting your entries.

## Troubleshooting

### Playwright tools not available

1. Check that `enableBrowserAutomation` is `true` in Settings
2. Verify `.mcp.json` exists in the project root and contains a `playwright` entry
3. Restart the agent session (the config is generated at startup)
4. Check agent logs for MCP config errors

### Browser actions failing

1. Ensure the page has fully loaded before interacting with elements
2. Use specific selectors (IDs, data-testid attributes)
3. Take a screenshot after navigation to verify the page state
4. Close the browser when done to free resources

### Bot detection / blocked by site

1. Enable stealth mode: set `stealth: true` in `browserProfile`
2. Increase human delays to look more natural
3. Some sites cannot be automated — consider using the Accessibility API approach for iPad apps instead

### High token usage

Browser automation uses approximately 114K tokens per task (Ethan's benchmark). Consider:

- Using browser automation only when necessary
- Closing the browser promptly after extracting data
- Using `browser_evaluate` for bulk data extraction instead of multiple click/read cycles

---

## Crewly in Chrome — `remote-browser` skill

A separate path from Playwright MCP, the `remote-browser` skill drives the
**user's actual Chrome browser** via the Crewly Chrome Extension over a
WebSocket bridge. Use this when an automation needs the user's real
logged-in sessions (cookies, OAuth, social platforms) — Playwright runs a
clean sandboxed browser with no logins.

```
remote-browser skill ─HTTP→ /api/browser/* ─WS→ Chrome Extension
   bash execute.sh                         ↑     ↑
                                  backend           user's Chrome
```

### Per-tab dispatch (1 agent : 1 tab)

As of 2026-04-25 (spec
`.crewly/specs/crewly-in-chrome-per-tab-fix-2026-04-25.md`, OSS commits
`96710c98` / `e4a39ddb`, Chrome Extension v0.4.0 commit `0c13dd0`),
**each agent owns its own Chrome tab**. Multi-agent concurrent web
automation no longer collides on whichever tab the user has focused.

#### How it works

1. Backend reads the `X-Agent-Session` header (auto-set by `_common/lib.sh`
   from `$CREWLY_SESSION_NAME`) on every `/api/browser/*` call.
2. On the agent's first command, backend tells the Extension to create a
   fresh background tab and remembers `agentSession → tabId`.
3. All subsequent commands from that agent are dispatched to its bound
   tab — `navigate`, `read-text`, `click`, etc.
4. Tabs land in a "Crewly" tab group (purple) so the user sees them
   collapsed. They never steal focus.

#### Skill usage

```bash
# Standard call — auto-binds on first command, uses bound tab thereafter.
CREWLY_SESSION_NAME=my-agent bash config/skills/agent/remote-browser/execute.sh \
  '{"action":"navigate","url":"https://example.com"}'

# Explicit pre-bind (lets the skill cache the tabId locally for resilience
# across backend restarts):
CREWLY_SESSION_NAME=my-agent bash …/execute.sh --action bind-tab

# Foreground a fresh bind (debug only):
CREWLY_SESSION_NAME=my-agent bash …/execute.sh --action bind-tab --active

# Override an explicit tab id (testing/debug):
CREWLY_SESSION_NAME=my-agent bash …/execute.sh --action read-text --tab-id 42

# Force the legacy active-tab path (drop the X-Agent-Session header for
# this one call — useful for one-off scripts that pre-date per-tab):
bash …/execute.sh --action read-text --no-bind

# Release at the end of a long-running session:
CREWLY_SESSION_NAME=my-agent bash …/execute.sh --action unbind-tab
```

#### Backward compatibility

When `CREWLY_SESSION_NAME` is unset OR `--no-bind` is used, the call
falls back to the user's currently-active tab — preserves every script
that pre-dates per-tab dispatch.

#### Operational guardrails

- **Hard cap**: 50 concurrent agent→tab bindings (override via
  `CREWLY_TAB_BIND_MAX`). At cap, `POST /api/browser/bind` returns 503
  with `error: "tab_pool_full"` and a `retryAfterMs` hint.
- **Soft warning**: bindings ≥ 25 logs a warning (and pings Slack via
  the alert pipeline).
- **TTL**: idle bindings expire after 30 min (override via
  `CREWLY_TAB_BIND_TTL_MINUTES`). Sweep runs every 5 min and closes
  the orphaned tab.
- **User-closes-tab**: the Extension's `chrome.tabs.onRemoved` listener
  forwards a `tabRemoved` signal so the backend clears the binding
  immediately — the agent's next call auto-rebinds.
- **Reconcile on reconnect**: every WS connection establishment, the
  Extension sends a tab inventory; backend drops stale bindings and
  asks the Extension to close orphan Crewly-group tabs.

#### Diagnostics

- `GET /api/browser/bindings` — JSON snapshot of all current
  agent→tab bindings, plus `hardCap` / `softWarn` thresholds.
- Extension console (chrome://extensions → Crewly in Chrome → service
  worker) — look for `[crewly] Sent tab inventory`, `[crewly] Agent
  tab bound`, `[crewly] Binding cleared` log lines.
- Backend logs — `BrowserBridge` component lines tagged with
  `bindAgentTab` / `unbindAgentTab` / `reconcile_extension_missing`.

#### When to use Playwright vs Crewly in Chrome

| Need | Use |
|---|---|
| Logged-in social platforms (LinkedIn, XHS, Twitter) | Crewly in Chrome |
| Public sites / scraping / repeatable tests | Playwright MCP |
| Multi-agent concurrent automation | Crewly in Chrome (per-tab) |
| Headless / CI environments | Playwright MCP |
| Cookies / OAuth tokens from user's real browser | Crewly in Chrome |
| Sandboxed / no-side-effect sessions | Playwright MCP |
