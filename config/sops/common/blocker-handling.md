---
id: common-blocker-handling
version: 1
createdAt: 2026-01-29T00:00:00Z
updatedAt: 2026-01-29T00:00:00Z
createdBy: system
role: all
category: escalation
priority: 9
title: Blocker Handling
description: How to handle and escalate blockers
triggers:
  - blocked
  - stuck
  - help
  - issue
  - problem
tags:
  - escalation
  - blockers
  - help
# Rule metadata (#877): what this rule prevents, where seen, when to re-test
prevents: "none recorded — part of the original default SOP library (2026-01-29); re-test before keeping"
seenOn: "unknown"
reviewBy: 2026-12-31
source: https://github.com/stevehuang0115/crewly/commit/77d504515
---

# Blocker Handling

## Types of Blockers

1. **Technical** - Code issue, bug, error
2. **Dependency** - Waiting on another task
3. **Clarity** - Unclear requirements
4. **Access** - Missing permissions/resources
5. **External** - Third-party issue

## Resolution Steps

1. **Identify** - What exactly is blocking?
2. **Research** - Can you find a solution?
3. **Document** - Record what you've tried
4. **Ask** - Use `recall` tool for similar issues
5. **Escalate** - If still blocked after 30 min

## When to Escalate

- Blocked for more than 30 minutes
- Multiple failed attempts
- Need external help
- Critical path affected

## Escalation Message

Include:
- What you're trying to do
- What's blocking you
- What you've tried
- What help you need
