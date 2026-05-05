---
name: Get My Active Work
description: Retrieve the live Request + WorkItem briefing for your session. Use this when the startup briefing is stale or truncated.
natural_language_description: Show me the active Requests and WorkItems I am currently on the hook for, plus anything that auto-resolved in the last 30 minutes.
version: 1.0.0
category: state-recovery
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
  # Canonical convention is hyphenated (`team-lead`); the underscore variant
  # (`team_lead`) was a duplicate-key typo discovered during the 4-piece skill-mistake
  # audit (post-PR #446 merge). Removing it to keep the role-name surface single-shape.
  - team-lead
  - orchestrator
triggers:
  - get my active work
  - active work
  - what am I on the hook for
  - refresh state
tags:
  - state
  - recovery
  - request
  - workitem
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Get My Active Work

Returns the authoritative live state — open Requests you are on the hook for,
in-flight WorkItems targeted at you (or claimed by you), pending reviews where
you are the verifier, outbound delegations you issued, and recently
auto-resolved items from the last 30 minutes.

This is the **freshness escape hatch** for the recovery protocol:

- The same briefing is auto-injected into your system prompt at session
  registration — you don't normally need to call this skill on startup.
- Call this skill mid-session if (a) the briefing was truncated (more than
  the 45-item cap had to be dropped), or (b) the snapshot is stale (>5
  minutes since registration, especially after long-running tasks).

State is the source of truth. Memory is supplementary. If the briefing shows
something your memory disagrees with, **trust the state** — investigate the
divergence rather than override it.

## Parameters

| Flag | JSON Field | Required | Description |
|------|-----------|----------|-------------|
| `--session` / `-s` | `sessionName` | Yes | Your agent session name |
| `--role` / `-r` | `role` | No | Agent role (default `developer`; orchestrator gets 3× cap) |
| `--format` / `-f` | `format` | No | `json` (default) or `markdown` |
| `--window` / `-w` | `recentlyResolvedWindowMs` | No | Window for recently auto-resolved items in ms (default `1800000` / 30min) |

## Examples — CLI Flags (preferred)

```bash
# Default JSON briefing
bash config/skills/agent/core/get-my-active-work/execute.sh --session dev-1

# Markdown rendering — pipe straight into your context
bash config/skills/agent/core/get-my-active-work/execute.sh --session dev-1 --format markdown

# Orchestrator system-wide briefing
bash config/skills/agent/core/get-my-active-work/execute.sh --session crewly-orc --role orchestrator
```

## Output

JSON (default): `{ success: true, data: ActiveWorkBriefing }`. The shape is:

```jsonc
{
  "openRequests": [{ "id": "req-abc", "title": "...", "status": "running", "priority": "high", "ageHours": 2.1 }],
  "activeWorkItems": [{ "id": "wi-123", "title": "...", "status": "running", "ageHours": 0.5, "requestId": "req-abc" }],
  "pendingReviews": [{ "id": "wi-456", "title": "...", "ageHours": 1.0, "claimedBy": "dev-x" }],
  "outboundDelegations": [{ "id": "wi-789", "title": "...", "status": "running", "target": "dev-leo" }],
  "recentlyAutoResolved": [{ "id": "wi-old", "title": "...", "resolvedAt": "...", "resolvedReason": "sla_close_run" }],
  "truncated": false,
  "totalCounts": { "requests": 12, "workItems": 47 }
}
```

When `--format markdown` is set, the response is `text/markdown` rendering of
the briefing — append it directly to your working context.
