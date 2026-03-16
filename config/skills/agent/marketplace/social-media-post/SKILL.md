---
name: Social Media Post Generator
description: Generate platform-optimized social media posts for Twitter/X, LinkedIn, and Reddit from a topic or content summary.
version: 1.0.0
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

# Social Media Post Generator

Generate platform-optimized social media posts from a topic or content summary. Supports Twitter/X, LinkedIn, and Reddit formats with character limits and platform-specific conventions.

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
