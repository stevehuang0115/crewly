---
name: AI Studio App Builder
description: Use Chrome to build React apps on Google AI Studio (aistudio.google.com). Navigate to the Build page, input prompts, and generate interactive prototypes.
version: 1.0.0
category: automation
skillType: claude-skill
triggers:
  - ai studio
  - google ai studio
  - build app
  - react prototype
  - gemini app
tags:
  - ai-studio
  - google
  - gemini
  - react
  - prototype
  - chrome
execution:
  type: instructions-only
runtime:
  runtime: claude-code
notices:
  - type: requirement
    message: This skill depends on the chrome-browser skill. Ensure the Claude Code Chrome extension is installed and Chrome is running.
  - type: requirement
    message: You must be signed into a Google account in Chrome that has access to Google AI Studio.
  - type: info
    message: AI Studio app generation can take 30-60 seconds. The skill instructions include appropriate wait strategies.
---

# AI Studio App Builder

Build React apps on Google AI Studio using Chrome MCP tools. This skill guides you through navigating to AI Studio, entering a prompt, and generating a fully functional React prototype.

## Prerequisites

- Chrome browser running with the Claude Code Chrome extension active
- Signed into a Google account with AI Studio access
- Chrome MCP tools available (`mcp__claude-in-chrome__*`)

## Chrome MCP Tools Reference

| Tool | Purpose |
|------|---------|
| `mcp__claude-in-chrome__navigate` | Navigate to a URL |
| `mcp__claude-in-chrome__computer` | Mouse clicks, keyboard input, scrolling |
| `mcp__claude-in-chrome__find` | Find elements by natural language description |
| `mcp__claude-in-chrome__read_page` | Read the accessibility tree of the current page |
| `mcp__claude-in-chrome__screenshot` | Take a screenshot of the current page |
| `mcp__claude-in-chrome__get_page_text` | Extract all text from the page |
| `mcp__claude-in-chrome__javascript_tool` | Execute JavaScript on the page |
| `mcp__claude-in-chrome__form_input` | Fill form fields |
| `mcp__claude-in-chrome__tabs_context` | List open tabs and reconnect to the extension |

## Step-by-Step Workflow

### Step 1: Navigate to AI Studio

```
mcp__claude-in-chrome__navigate → url: "https://aistudio.google.com"
```

After navigation, take a screenshot to confirm the page loaded:

```
mcp__claude-in-chrome__screenshot
```

### Step 2: Dismiss Intro Modal (if present)

AI Studio sometimes shows a welcome/intro modal on first visit. Check the screenshot — if a modal is visible:

1. Look for a "Got it", "Dismiss", "Close", or "X" button
2. Click it:
   ```
   mcp__claude-in-chrome__find → query: "dismiss button" or "close button" or "got it button"
   mcp__claude-in-chrome__computer → action: click on the found element
   ```

If no modal is present, proceed to the next step.

### Step 3: Navigate to the Build Page

Click on "Build" in the left sidebar to access the app builder:

```
mcp__claude-in-chrome__find → query: "Build" in the left sidebar navigation
mcp__claude-in-chrome__computer → action: click on the Build link
```

Alternatively, navigate directly:

```
mcp__claude-in-chrome__navigate → url: "https://aistudio.google.com/app/build"
```

Take a screenshot to confirm you're on the Build page:

```
mcp__claude-in-chrome__screenshot
```

### Step 4: Start a New App

Look for the main prompt input area. It may appear as:
- A text area with placeholder text like "Build an app..." or "Describe your app..."
- A large input field in the center of the page

```
mcp__claude-in-chrome__find → query: "app prompt input" or "build an app text area" or "describe your app"
mcp__claude-in-chrome__computer → action: click on the input area
```

### Step 5: Enter the Prompt

Type the app description into the input area. Use `computer` with keyboard action for reliable text input:

```
mcp__claude-in-chrome__computer → action: type, text: "<your app prompt here>"
```

**Tips for effective AI Studio prompts:**
- Be specific about the UI layout and components you want
- Mention "React" if you want a React-based app
- Describe interactions (e.g., "clicking a card should expand it")
- Specify data/content to include (e.g., "show a list of 10 programming languages with descriptions")
- Mention styling preferences (e.g., "modern dark theme", "Material Design style")

### Step 6: Submit the Prompt

After entering the prompt, submit it by pressing Enter or clicking the submit/send button:

```
mcp__claude-in-chrome__computer → action: press, key: "Return"
```

Or find and click the submit button:

```
mcp__claude-in-chrome__find → query: "submit button" or "send button" or "generate button"
mcp__claude-in-chrome__computer → action: click on the submit element
```

### Step 7: Wait for Generation

AI Studio takes 30-60 seconds to generate the app. **Do not click or navigate away during generation.**

Wait strategy:
1. Wait 15 seconds, then take a screenshot to check progress
2. Look for indicators: a loading spinner, "Generating..." text, or a progress bar
3. If still generating, wait another 15 seconds and screenshot again
4. Repeat until the app preview appears or an error is shown
5. Maximum wait: 120 seconds before considering it failed

```
# Wait and check
sleep 15
mcp__claude-in-chrome__screenshot

# If still loading, wait more
sleep 15
mcp__claude-in-chrome__screenshot
```

**Signs generation is complete:**
- A live app preview appears on the right side of the screen
- The code editor shows generated React/HTML code
- The loading indicator disappears
- A shareable URL or "Preview" button becomes available

### Step 8: Verify the Result

Once generation is complete, take a screenshot and read the page to confirm:

```
mcp__claude-in-chrome__screenshot
mcp__claude-in-chrome__get_page_text
```

Check for:
- The app preview is rendering correctly
- No error messages are shown
- The generated app matches the prompt intent

### Step 9: Get the App URL

The generated app URL is typically in the browser address bar. Extract it:

```
mcp__claude-in-chrome__javascript_tool → script: "window.location.href"
```

Or read the page for any shared/preview links:

```
mcp__claude-in-chrome__find → query: "share link" or "preview URL" or "app URL"
```

Report the URL back to the user or orchestrator.

### Step 10: Iterate (Optional)

If the generated app needs changes, use the chat/prompt area at the bottom of the page to request modifications:

1. Find the follow-up input:
   ```
   mcp__claude-in-chrome__find → query: "follow up prompt" or "chat input" or "message input"
   mcp__claude-in-chrome__computer → action: click on the input
   ```
2. Type the modification request:
   ```
   mcp__claude-in-chrome__computer → action: type, text: "Change the color scheme to dark mode and add a search bar"
   ```
3. Submit and wait for regeneration (repeat Steps 6-8)

## Troubleshooting

### Chrome Extension Disconnected

If MCP tool calls fail with connection errors:

1. Use `tabs_context` to check the extension status:
   ```
   mcp__claude-in-chrome__tabs_context
   ```
2. If disconnected, the extension may need to be re-enabled in Chrome
3. Try navigating to any page to re-establish the connection:
   ```
   mcp__claude-in-chrome__navigate → url: "https://aistudio.google.com"
   ```

### Page Not Loading

If AI Studio shows a blank page or error:
- Check that you're signed into a Google account
- Try refreshing: `mcp__claude-in-chrome__javascript_tool → script: "location.reload()"`
- Navigate directly to the build page URL

### Generation Stuck or Failed

If generation appears stuck for more than 2 minutes:
1. Take a screenshot to check the current state
2. Look for error messages on the page
3. Try refreshing and re-submitting the prompt
4. If the issue persists, try simplifying the prompt

### Element Not Found

If `find` can't locate an element:
1. Take a screenshot to see the current page state
2. Use `read_page` to examine the accessibility tree
3. Try alternative descriptions for the element
4. Use `javascript_tool` to query the DOM directly:
   ```
   mcp__claude-in-chrome__javascript_tool → script: "document.querySelector('textarea')?.placeholder"
   ```

### Rate Limiting

AI Studio may rate-limit frequent requests:
- Wait at least 30 seconds between generation attempts
- If you see a rate limit message, wait 2-3 minutes before retrying

## Example: Full Workflow

Here is a complete example building a todo app:

```
# 1. Navigate
mcp__claude-in-chrome__navigate → url: "https://aistudio.google.com/app/build"

# 2. Wait for page load
sleep 3
mcp__claude-in-chrome__screenshot

# 3. Find and click the prompt input
mcp__claude-in-chrome__find → query: "app prompt input"
mcp__claude-in-chrome__computer → action: click

# 4. Type the prompt
mcp__claude-in-chrome__computer → action: type, text: "Build a beautiful todo app with React. Include: add/delete/complete tasks, filter by status (all/active/completed), dark mode toggle, local storage persistence, and smooth animations."

# 5. Submit
mcp__claude-in-chrome__computer → action: press, key: "Return"

# 6. Wait for generation
sleep 30
mcp__claude-in-chrome__screenshot

# 7. Check if done, wait more if needed
sleep 20
mcp__claude-in-chrome__screenshot

# 8. Get the URL
mcp__claude-in-chrome__javascript_tool → script: "window.location.href"

# 9. Report back with the URL and a final screenshot
mcp__claude-in-chrome__screenshot
```
