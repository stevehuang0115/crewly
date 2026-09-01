---
name: Remote Browser
description: "Drive the user's real Chrome browser through the Crewly Chrome Extension. Navigate, click, fill forms, screenshot, read text, run JS, inspect cookies/console. Each agent gets its own bound tab, so concurrent agents never fight over the active tab. Plain HTTP + bash — usable by any agent runtime, not just Claude."
version: 1.0.0
category: browser
skillType: claude-skill
assignableRoles:
  - developer
  - qa
  - researcher
  - marketing
triggers:
  - remote browser
  - drive chrome
  - control my browser
  - use my chrome
  - browser automation
  - fill the form
  - take a screenshot of the page
  - scrape the page
tags:
  - browser
  - chrome
  - extension
  - automation
  - scraping
---

# Remote Browser

Control the user's **real, logged-in Chrome** — their sessions, their cookies,
their extensions — through the Crewly Chrome Extension.

```
agent → bash execute.sh → POST /api/browser/* → WebSocket → Chrome Extension → real tab
```

The transport is plain HTTP from a bash script, so **any agent runtime can use
it** (Claude Code, Codex, Gemini CLI, a cron job). There is no MCP dependency
and nothing model-specific.

## Why this and not a headless browser

Use this when the task needs the user's **actual logged-in state** — an account
only they are signed into, a site behind SSO, a page whose content differs for
an authenticated user. For anything that works logged-out, a headless browser is
cheaper and will not disturb the user's window.

## Usage

Two equivalent calling conventions:

```bash
# JSON argument
bash execute.sh '{"action":"navigate","url":"https://example.com"}'

# Flags
bash execute.sh --action navigate --url https://example.com
bash execute.sh -a click -s "#submit"
```

`bash execute.sh --help` prints the action list.

## Actions

### Page control
| Action | Required | Optional |
|---|---|---|
| `navigate` | `--url` | |
| `screenshot` | | |
| `full-page-screenshot` | | scrolls and stitches the whole page |
| `read-text` | | `--selector` (defaults to whole page) |
| `scroll` | | `--params` e.g. `'{"direction":"down","amount":3}'` |
| `scroll-in-element` | | `--params` with a selector + direction |

### Interaction
| Action | Required | Optional |
|---|---|---|
| `click` | `--selector` | or `--params` for coordinate clicks |
| `fill` | `--selector` `--value` | replaces the field's contents |
| `type` | `--selector` `--text` | types keystroke by keystroke |
| `hover` | `--selector` | |
| `press-key` | `--params` e.g. `'{"key":"Enter"}'` | |
| `select-option` | `--selector` + one of `--value` / `--params` with `label` or `index` | resolution order: value → label → index |
| `set-file-input` | `--params` with selector + file path | |

### Reading the page
| Action | Required | Optional |
|---|---|---|
| `get-element` | `--selector` | |
| `get-interactive-elements` | | `--params` — buttons/links/inputs with refs |
| `search-text` | `--text` | locate text on the page |
| `list-options` | `--selector` | enumerate a `<select>` |
| `wait-for-selector` | `--selector` | blocks until it appears |
| `execute-js` | `--code` | alias: `execute`. Raw JS in page context |

### Browser state
| Action | Notes |
|---|---|
| `tabs` | list open tabs |
| `cookies` | optional `?domain=` on the endpoint |
| `console` | recent console messages; optional `?clear=true` |
| `local-storage` | `--params` to scope the read |
| `status` | extension connection status |
| `instances` | connected browser instances |
| `proxy-connect` | manually connect the proxy to Cloud Relay |

### Tab binding
| Action | Notes |
|---|---|
| `bind-tab` | bind a tab to this agent; `--active` foregrounds it (default: background) |
| `unbind-tab` | release the tab and close it |

## Per-agent tab binding

This is what makes the skill safe to run from several agents at once.

When `CREWLY_SESSION_NAME` is set in the agent's environment it is forwarded as
the `X-Agent-Session` header, and the backend dispatches each command to **that
agent's own tab** instead of whatever tab the user is looking at.

- The first command from a fresh agent auto-binds a new background tab.
- The resulting id is cached at
  `~/.crewly/runtime/<agentSession>/browser-tab-id`, so later calls skip the
  bind round-trip.
- Concurrent agents therefore never steal each other's page — and never yank
  the user's foreground tab out from under them.

Escape hatches:

| Flag | Effect |
|---|---|
| `--tab-id <n>` | pin one call to a specific tab (tests, debugging) |
| `--no-bind` | drop the session header and use the legacy active-tab path |
| `--active` | with `bind-tab`, open the tab in the foreground |

With `CREWLY_SESSION_NAME` unset, behaviour falls back to the legacy active-tab
path, so scripts written before per-tab dispatch keep working unchanged.

## Examples

```bash
# Read a page that requires the user's login
bash execute.sh -a navigate -u "https://app.example.com/reports"
bash execute.sh -a wait-for-selector -s ".report-table"
bash execute.sh -a read-text -s ".report-table"

# Fill and submit a form
bash execute.sh -a fill -s "#email" -v "someone@example.com"
bash execute.sh -a type -s "#note" -t "Following up on the quote"
bash execute.sh -a click -s "button[type=submit]"

# Pull structured data out of the DOM
bash execute.sh -a execute-js -c '[...document.querySelectorAll(".row")].map(r=>r.innerText)'

# Explicit lifecycle when doing a long multi-step job
bash execute.sh -a bind-tab
# ... many commands ...
bash execute.sh -a unbind-tab
```

## Prerequisites

- Crewly backend running, with the Chrome Extension connected
  (`bash execute.sh -a status` to confirm)
- `curl` and `jq` in PATH

## Cautions

- **This is the user's real browser.** Actions have real effects under their
  real identity: a click can send a message, place an order, or delete
  something. Confirm before anything irreversible or outward-facing.
- Never enter passwords, card numbers, or other credentials — ask the user to
  do it themselves in their own window.
- Avoid clicking elements that raise native `alert()` / `confirm()` dialogs:
  they block the extension until dismissed by hand.
- Always `unbind-tab` when a job is done, or abandoned tabs accumulate in the
  user's window.
