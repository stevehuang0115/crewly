---
name: "Marketplace Search & Install"
description: Search the Crewly marketplace for skills, roles, and models. Auto-install matching items when the agent lacks a capability.
version: 1.0.0
category: automation
skillType: claude-skill
assignableRoles:
  - developer
  - qa
  - tpm
  - designer
  - frontend-developer
  - backend-developer
  - fullstack-dev
  - qa-engineer
  - product-manager
  - architect
  - generalist
  - sales
  - support
triggers:
  - search marketplace
  - find skill
  - install skill
  - marketplace search
  - need capability
  - missing skill
tags:
  - marketplace
  - skills
  - install
  - search
  - auto-discover
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Marketplace Search & Install

Search the Crewly marketplace for skills, roles, and models. When you lack a capability needed for a task, use this skill to auto-discover and install it from the marketplace.

## Actions

### `search` — Find items in the marketplace

```bash
bash {{AGENT_SKILLS_PATH}}/marketplace-search/execute.sh '{"action":"search","query":"code review"}'
```

Optional filters:
- `type`: `skill`, `model`, or `role`
- `category`: `development`, `design`, `communication`, `research`, `content-creation`, `automation`, `analysis`, `integration`, `quality`, `security`

```bash
bash {{AGENT_SKILLS_PATH}}/marketplace-search/execute.sh '{"action":"search","query":"testing","type":"skill","category":"quality"}'
```

### `search-and-install` — Find and auto-install the best match

Use this when you need a capability you don't have. It searches for matching skills and installs the first available one automatically.

```bash
bash {{AGENT_SKILLS_PATH}}/marketplace-search/execute.sh '{"action":"search-and-install","query":"code review"}'
```

### `install` — Install a specific item by ID

```bash
bash {{AGENT_SKILLS_PATH}}/marketplace-search/execute.sh '{"action":"install","id":"skill-code-review-pro"}'
```

### `installed` — List currently installed items

```bash
bash {{AGENT_SKILLS_PATH}}/marketplace-search/execute.sh '{"action":"installed"}'
```

### `updates` — Check for available updates

```bash
bash {{AGENT_SKILLS_PATH}}/marketplace-search/execute.sh '{"action":"updates"}'
```

## When to Use

- **Before starting a task** that requires a capability you don't have — search for a matching skill
- **When a task fails** due to missing tools — auto-discover the right skill
- **Periodically** — check for updates to installed skills
- **When exploring** what capabilities are available in the ecosystem

## Output

JSON response with search results or install status. Each item includes:
- `id`, `name`, `description`, `version`, `author`
- `installStatus`: `not_installed`, `installed`, or `update_available`
- `category`, `tags`, `rating`, `downloads`
