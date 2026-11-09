---
id: common-communication
version: 1
createdAt: 2026-01-29T00:00:00Z
updatedAt: 2026-01-29T00:00:00Z
createdBy: system
role: all
category: communication
priority: 10
title: Communication Protocol
description: Standard communication protocol for all agents
triggers:
  - message
  - send
  - communicate
  - team
  - ask
tags:
  - communication
  - team
  - protocol
# Rule metadata (#877): what this rule prevents, where seen, when to re-test
prevents: "none recorded — part of the original default SOP library (2026-01-29); re-test before keeping"
seenOn: "unknown"
reviewBy: 2026-12-31
source: https://github.com/stevehuang0115/crewly/commit/77d504515
---

# Communication Protocol

## When to Communicate

- **Starting work** - Notify PM when accepting task
- **Progress updates** - Every 30 minutes or on completion
- **Blockers** - Immediately when blocked
- **Questions** - When unclear about requirements
- **Completion** - When task is ready for review

## Message Format

Keep messages:
- **Concise** - Get to the point
- **Actionable** - Clear what's needed
- **Contextual** - Include relevant details

## Escalation Path

1. First: Try to resolve yourself
2. Then: Ask teammate
3. Then: Ask PM
4. Finally: Escalate to orchestrator

## Tools

- `send_message` - Direct to specific agent
- `report_progress` - Status updates
- `request_review` - Ask for code review
