---
name: Social Media Draft Generator
description: Generate platform-optimized social media drafts for Twitter/X, LinkedIn, and Reddit. It only writes drafts: you review each one and publish it yourself.
version: 1.1.0
category: content
skillType: claude-skill
assignableRoles:
  - product-manager
  - generalist
  - designer
  - sales
triggers:
  - social media post
  - tweet
  - linkedin post
  - social post
  - create post
tags:
  - social-media
  - content
  - twitter
  - linkedin
  - reddit
  - marketing
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Social Media Draft Generator

Generate platform-optimized social media **drafts** from a topic or content summary. Supports Twitter/X, LinkedIn, and Reddit formats with character limits and platform-specific conventions.

> **Drafts only**
> - This skill writes drafts. It never publishes anything.
> - Agents must NOT publish a draft on any platform, via Crewly in Chrome or any other automation.
> - Workflow: generate the draft, share it with the owner (for example in Slack, with a compose link for X), and the owner reviews and publishes it.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `topic` | Yes | Topic or content summary to create posts about |
| `platforms` | No | Comma-separated: `twitter`, `linkedin`, `reddit` (default: all) |
| `url` | No | URL to link to in the posts |
| `hashtags` | No | Comma-separated hashtags to include |
| `tone` | No | `professional`, `casual`, `technical`, `exciting` (default: professional) |

## Example

```bash
bash config/skills/agent/social-media-post/execute.sh '{"topic":"Crewly v1.1 launch with live terminal streaming","platforms":"twitter,linkedin","url":"https://crewly.dev","hashtags":"AIAgents,OpenSource","tone":"exciting"}'
```

## Output

JSON with a `posts` array containing platform-specific content, character counts, and platform limits. Each post is formatted according to the platform's conventions.
