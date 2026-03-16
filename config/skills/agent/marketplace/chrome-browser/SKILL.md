---
name: Claude Code Chrome Browser
description: Enable browser automation capabilities in Claude Code using the Chrome extension. This allows agents to interact with web pages, fill forms, click buttons, and perform automated browser tasks.
version: 1.0.0
category: automation
skillType: mcp
triggers:
  - browser
  - chrome
  - web automation
  - browse
  - click
  - fill form
  - navigate
tags:
  - browser
  - automation
  - chrome
  - mcp
  - web
execution:
  type: mcp-tool
  mcpTool:
    toolName: "mcp__claude-in-chrome__*"
    defaultParams:
runtime:
  runtime: claude-code
  flags:
    - --chrome
notices:
  - type: requirement
    message: This skill requires the Claude Code Chrome extension to be installed in your browser.
  - type: info
    message: This skill is only available when using Claude Code as the AI runtime.
---

# Claude Code Chrome Browser

This skill enables browser automation capabilities through the Claude Code Chrome extension.

## Capabilities

When this skill is enabled, agents can:

- Navigate to web pages
- Read page content and structure
- Fill out forms and input fields
- Click buttons and links
- Take screenshots
- Execute JavaScript on pages
- Interact with dynamic web applications

## Usage

The browser automation tools are available through MCP (Model Context Protocol) when Claude Code is started with the `--chrome` flag.

### Available Tools

- `mcp__claude-in-chrome__navigate` - Navigate to URLs
- `mcp__claude-in-chrome__read_page` - Read page accessibility tree
- `mcp__claude-in-chrome__find` - Find elements using natural language
- `mcp__claude-in-chrome__form_input` - Fill form fields
- `mcp__claude-in-chrome__computer` - Mouse and keyboard interactions
- `mcp__claude-in-chrome__javascript_tool` - Execute JavaScript
- `mcp__claude-in-chrome__get_page_text` - Extract page text content

## Requirements

1. Install the Claude Code Chrome extension from the Chrome Web Store
2. Keep Chrome running with the extension active
3. Ensure Claude Code is started with the `--chrome` flag (Crewly handles this automatically when this skill is enabled)

## Best Practices

- Always wait for page loads before interacting with elements
- Use `find` to locate elements by description before clicking
- Take screenshots to verify page state when debugging
- Handle dynamic content with appropriate waits
