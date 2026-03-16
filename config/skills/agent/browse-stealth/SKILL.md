---
name: Stealth Browser (Patchright + CDP)
description: Anti-detection browser automation using Patchright (Playwright fork) connected to a real Chrome instance via CDP. Bypasses navigator.webdriver checks, fingerprint anomalies, and headless detection used by platforms like 小红书, X/Twitter, and LinkedIn.
version: 1.0.0
category: browser
skillType: claude-skill
assignableRoles:
  - developer
  - qa
  - qa-engineer
  - fullstack-dev
  - backend-developer
  - frontend-developer
  - generalist
  - ops
  - content-strategist
triggers:
  - stealth browse
  - browse stealth
  - anti-detection
  - xiaohongshu
  - rednote browse
  - patchright
  - cdp browse
  - stealth scrape
tags:
  - browser
  - stealth
  - patchright
  - cdp
  - anti-detection
  - automation
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 120000
---

# Stealth Browser (Patchright + CDP)

Anti-detection browser automation that connects to a **real Chrome instance** via Chrome DevTools Protocol (CDP). This bypasses bot detection used by platforms like 小红书 (RedNote), X/Twitter, and LinkedIn.

## Why Stealth?

Regular Playwright/Puppeteer launches a new Chromium with detectable fingerprints:
- `navigator.webdriver = true`
- Missing browser history, extensions, cookies
- Headless-specific user agent strings

This skill connects to your **existing Chrome** browser, inheriting all your real cookies, extensions, and browser fingerprint.

## Actions

### `read` (default)
Navigate to a URL and extract text content.

```json
{"url": "https://www.xiaohongshu.com/explore", "action": "read"}
```

With specific selectors:
```json
{"url": "https://example.com", "action": "read", "selectors": ["h1", ".article-body", "#comments"]}
```

### `screenshot`
Navigate to a URL and take a screenshot. Saved to `~/.crewly/screenshots/`.

```json
{"url": "https://www.xiaohongshu.com/explore", "action": "screenshot"}
```

### `interact`
Navigate and click on elements.

```json
{"url": "https://example.com", "action": "interact", "selectors": [".like-button", ".follow-btn"]}
```

## Input Format

```json
{
  "url": "https://...",           // Required. Target URL.
  "action": "read",              // Optional. read | screenshot | interact. Default: read.
  "selectors": ["css-selector"], // Optional. CSS selectors for content extraction or interaction.
  "cdpPort": 9222                // Optional. Chrome CDP port. Default: 9222.
}
```

## Output Format

### Success (read)
```json
{
  "success": true,
  "url": "https://...",
  "title": "Page Title",
  "results": {
    "content": "Extracted text content..."
  }
}
```

### Success (screenshot)
```json
{
  "success": true,
  "url": "https://...",
  "title": "Page Title",
  "screenshot": "/Users/.../.crewly/screenshots/stealth_1234567890.png"
}
```

### Risk Control Detected
```json
{
  "success": false,
  "error": "risk_control_detected",
  "signals": ["keyword:验证码", "captcha_url"],
  "advice": "Stop immediately. Risk control triggered."
}
```

## Critical Rules

1. **DO NOT browse too fast** — Add delays between requests (the script does this automatically)
2. **STOP if risk control is detected** — Never retry after CAPTCHA/rate-limit signals
3. **DO NOT use for mass scraping** — This is for occasional reads, not bulk data extraction
4. **Chrome must be running** — The script auto-launches Chrome if needed, but it's better to have Chrome already open with your logged-in sessions

## Prerequisites

- **Google Chrome** installed on macOS
- **Python 3** with `patchright` package (auto-installed on first run)
- Chrome will be launched with `--remote-debugging-port=9222` if not already running

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `chrome_launch_failed` | Close Chrome manually, then retry. macOS enforces single Chrome instance. |
| `cdp_connect_failed` | Chrome may have crashed. Close and reopen Chrome, then retry. |
| `patchright_not_installed` | Run `pip3 install patchright` manually. |
| `risk_control_detected` | Stop browsing that platform. Wait 30+ minutes before retrying. |
| `no_browser_context_found` | Chrome opened but has no windows. Open a tab manually. |
