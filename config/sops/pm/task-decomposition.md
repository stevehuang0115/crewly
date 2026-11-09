---
id: pm-task-decomposition
version: 1
createdAt: 2026-01-29T00:00:00Z
updatedAt: 2026-01-29T00:00:00Z
createdBy: system
role: pm
category: workflow
priority: 10
title: Task Decomposition
description: How to break down large tasks into manageable subtasks
triggers:
  - task
  - decompose
  - break down
  - story
  - ticket
tags:
  - planning
  - workflow
  - tasks
# Rule metadata (#877): what this rule prevents, where seen, when to re-test
prevents: "none recorded — part of the original default SOP library (2026-01-29); re-test before keeping"
seenOn: "unknown"
reviewBy: 2026-12-31
source: https://github.com/stevehuang0115/crewly/commit/77d504515
---

# Task Decomposition

## When to Decompose

Break down tasks when:
- Estimated time > 4 hours
- Multiple components involved
- Multiple people needed
- Unclear scope

## Decomposition Steps

1. **Identify the goal** - What's the end result?
2. **List deliverables** - What needs to be produced?
3. **Identify dependencies** - What must happen first?
4. **Create subtasks** - One per deliverable
5. **Add acceptance criteria** - How do we know it's done?

## Task Quality

Each task should have:
- Clear title (action verb + object)
- Description with context
- Acceptance criteria (checklist)
- Estimated size (S/M/L)
- Dependencies listed

## Example

**Bad:** "Build user feature"

**Good:**
- "Implement user registration API endpoint"
- "Add user registration form component"
- "Write tests for user registration flow"
- "Add input validation for registration fields"
