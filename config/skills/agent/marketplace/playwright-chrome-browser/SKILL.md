---
name: Playwright Chrome Browser
description: Enable browser automation capabilities using Playwright MCP server. This allows agents to interact with web pages, take screenshots, fill forms, and perform automated browser tasks through the Playwright automation framework.
version: 1.0.0
category: automation
skillType: mcp
triggers:
  - playwright
  - browser
  - web automation
  - screenshot
  - click
  - fill form
  - navigate
  - headless
tags:
  - browser
  - automation
  - playwright
  - mcp
  - web
  - headless
  - testing
execution:
  type: mcp-tool
  mcpTool:
    toolName: "mcp__playwright__*"
    defaultParams:
runtime:
  runtime: claude-code
  requiredMcpServers:
    - "@playwright/mcp"
notices:
  - type: requirement
    message: "This skill requires the Playwright MCP server. Crewly auto-configures this when browser automation is enabled in Settings. Manual install: npx @playwright/mcp@latest"
  - type: info
    message: This skill is only available when using Claude Code as the AI runtime.
  - type: info
    message: Playwright runs in headless mode by default. The browser window is not visible during automation.
---

# Playwright Chrome Browser

This skill enables browser automation capabilities through the Playwright MCP server for Claude Code.

## Prerequisites

Crewly auto-configures the Playwright MCP server when browser automation is enabled in Settings (`enableBrowserAutomation: true`). The `.mcp.json` file is generated automatically during agent startup.

For manual installation:

```bash
npx @playwright/mcp@latest
```

## Capabilities

When this skill is enabled, agents can:

- Navigate to web pages
- Take screenshots of pages or specific elements
- Fill out forms and input fields
- Click buttons and links
- Extract text content from pages
- Wait for elements to appear
- Handle multiple browser tabs
- Execute in headless mode (no visible browser window)

## Usage

The browser automation tools are available through MCP (Model Context Protocol) when the Playwright MCP server is configured in Claude Code.

### Available Tools

- `mcp__playwright__browser_navigate` - Navigate to a URL
- `mcp__playwright__browser_screenshot` - Take a screenshot
- `mcp__playwright__browser_click` - Click on an element
- `mcp__playwright__browser_fill` - Fill an input field
- `mcp__playwright__browser_select` - Select from dropdown
- `mcp__playwright__browser_hover` - Hover over an element
- `mcp__playwright__browser_evaluate` - Execute JavaScript on the page
- `mcp__playwright__browser_console_messages` - Get console messages
- `mcp__playwright__browser_network_requests` - Monitor network activity
- `mcp__playwright__browser_tab_list` - List open tabs
- `mcp__playwright__browser_tab_new` - Open a new tab
- `mcp__playwright__browser_tab_select` - Switch between tabs
- `mcp__playwright__browser_tab_close` - Close a tab
- `mcp__playwright__browser_close` - Close the browser

## Comparison with Chrome Browser Skill

| Feature | Playwright MCP | Chrome Extension |
|---------|---------------|------------------|
| Installation | MCP server install | Chrome extension |
| Browser visibility | Headless (invisible) | Visible browser |
| Speed | Faster (no rendering) | Real browser speed |
| Reliability | Very stable | Depends on extension |
| Use case | Testing, scraping | Interactive automation |

## Best Practices

1. **Always take screenshots** after navigation to verify page state
2. **Use specific selectors** - prefer IDs and data-testid attributes
3. **Wait for elements** before interacting with them
4. **Handle errors gracefully** - pages may load slowly or fail
5. **Close browser when done** to free resources

## Example Workflow

```
1. Navigate to the target URL
2. Wait for page to load
3. Take a screenshot to verify state
4. Interact with elements (click, fill, select)
5. Take another screenshot to verify result
6. Extract needed data
7. Close the browser
```

## Troubleshooting

### MCP Server Not Found
If you get an error about the MCP server not being available:
1. Verify `enableBrowserAutomation` is `true` in Crewly Settings
2. Check that `.mcp.json` exists in the project root with a `playwright` entry
3. Restart the agent session to regenerate MCP config
4. Manual fallback: `npx @playwright/mcp@latest`

### Element Not Found
- Ensure the page has fully loaded before interacting
- Verify the selector is correct using browser dev tools
- Try alternative selectors (text content, aria labels)

### Screenshot Failures
- Ensure the browser has navigated to a page first
- Check that the element exists if taking element screenshot
- Verify sufficient disk space for screenshot storage
