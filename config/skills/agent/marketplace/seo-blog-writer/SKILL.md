---
name: SEO Blog Writer
description: Generate an SEO-optimized blog post structure with title, meta description, headers, and keyword placement guide.
version: 1.0.0
category: content
skillType: claude-skill
assignableRoles:
  - product-manager
  - generalist
  - designer
  - support
triggers:
  - write blog
  - blog post
  - seo blog
  - content writing
  - blog outline
tags:
  - seo
  - blog
  - content
  - writing
  - marketing
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# SEO Blog Writer

Generate an SEO-optimized blog post outline with title, meta description, headers, keyword placement, and structure. Provides the skeleton that you (the agent) fill in with real content.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `topic` | Yes | Blog post topic |
| `keywords` | Yes | Comma-separated target SEO keywords |
| `wordCount` | No | Target word count (default: 1500) |
| `outputPath` | No | File path to write the outline as markdown |

## Example

```bash
bash config/skills/agent/seo-blog-writer/execute.sh '{"topic":"How to Build AI Agent Teams","keywords":"AI agent teams,multi-agent orchestration","wordCount":1500}'
```

### Writing to file

```bash
bash config/skills/agent/seo-blog-writer/execute.sh '{"topic":"Getting Started with Crewly","keywords":"crewly,AI agents,team automation","outputPath":"/tmp/blog-outline.md"}'
```

## Output

JSON with the full SEO-optimized outline including title, meta description, headers with writing guidance, keyword density recommendations, and link placeholders. If `outputPath` is provided, also writes a markdown file.
