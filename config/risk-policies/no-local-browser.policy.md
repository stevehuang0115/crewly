# Risk Policy: No Local Browser / Desktop Automation

**Applies to:** Agents working on a user's active workstation where opening local browser/desktop windows would interfere with the user's current session.

**Why:** Agents have repeatedly opened the user's local Chrome/iPad/desktop, disrupting real user activity. Several reported incidents trace back to this class of skill.

## Prohibited Actions

**NEVER call any of the following skills:**

- `chrome-attach` — attaches to the user's local Chrome (DO NOT USE)
- `computer-use` — drives the whole local desktop (DO NOT USE)
- `desktop-app-control` — local GUI automation (DO NOT USE)
- `browse-stealth` — opens a local browser (DO NOT USE)
- `screenshot-compare` — only if it invokes local screen capture (use remote equivalent)
- Any Playwright or direct CDP invocation against the local machine
- Any skill whose `execute.sh` calls `open`, `osascript`, `xdotool`, or equivalent

## Required Alternative

When a task requires browsing the web, viewing a page, or interacting with logged-in sites:

**Use `remote-browser`** (the Crewly Chrome Extension bridge). It controls the user's real Chrome via WebSocket/Cloud Relay WITHOUT opening new local windows or stealing focus.

Example:
```bash
bash ${AGENT_SKILLS_PATH}/remote-browser/execute.sh '{"action":"navigate","url":"https://example.com"}'
bash ${AGENT_SKILLS_PATH}/remote-browser/execute.sh '{"action":"read-text"}'
```

If `remote-browser` is unavailable (extension not installed / cloud relay down), **STOP and report** via `send-message` to the team leader or orchestrator. Do NOT fall back to local browser skills.

## Circuit Breaker

If the remote browser service is offline or rate-limited:
1. Report the blocker immediately
2. Mark the WorkItem as `blocked`
3. Wait for human or orchestrator resolution
4. Never silently switch to a local-browser skill to "unblock yourself"

## Logging

Every invocation of `remote-browser` is logged by the skill wrapper. Any attempt to invoke a prohibited skill should be refused by the agent and reported via `record-learning` so the pattern can be audited.
