---
name: Content Repurposer
description: Repurpose source content into platform-optimized versions for X (thread/single), LinkedIn, Xiaohongshu, Substack, and YouTube descriptions. Provides platform-specific style guides, tone modifiers, and brand voice presets.
version: 1.0.0
category: content
skillType: claude-skill
assignableRoles:
  - content-strategist
  - product-manager
  - generalist
  - designer
  - sales
triggers:
  - repurpose content
  - adapt content
  - cross-post
  - multi-platform content
  - convert to thread
  - convert to linkedin
tags:
  - content
  - repurpose
  - multi-platform
  - social-media
  - marketing
  - x-thread
  - linkedin
  - xiaohongshu
  - substack
  - youtube
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Content Repurposer

Repurpose a single piece of source content into platform-optimized versions. Supports X (thread and single tweet), LinkedIn, Xiaohongshu (RedNote), Substack, and YouTube descriptions.

## How It Works

This skill does NOT generate the final content directly. Instead, it:
1. Takes your source content and target platforms
2. Outputs platform-specific **style guides, tone modifiers, and brand voice instructions**
3. You (the agent) then use these guides as context to generate the actual repurposed content

This design keeps the LLM-powered content generation in the agent's hands (where quality control happens) while the skill handles the structured platform rules.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `source` | Yes* | The source content text to repurpose (inline) |
| `sourceFile` | Yes* | Path to a markdown file containing the source content |
| `platforms` | No | Comma-separated target platforms (default: `x-thread,linkedin`) |
| `tone` | No | `professional`, `casual`, `technical`, `inspiring`, `provocative` (default: `professional`) |
| `brand` | No | `personal` (Steve's voice) or `crewly` (Crewly brand voice). Default: `personal` |
| `language` | No | `auto` (xiaohongshu=zh, others=en), `en`, `zh`, or `both`. Default: `auto` |
| `outputDir` | No | Directory to write prompt files (one per platform). If omitted, output is JSON only |

*One of `source` or `sourceFile` is required.

## Supported Platforms

| Platform | Key | Max Length | Format |
|----------|-----|-----------|--------|
| X Thread | `x-thread` | ~1400 chars (5 tweets) | 3-7 tweets with [1/N] markers |
| X Single | `x-single` | 280 chars | Single punchy tweet |
| LinkedIn | `linkedin` | 3000 chars | Professional long-form post |
| Xiaohongshu | `xiaohongshu` | 1000 chars | Chinese, emoji-rich, #话题# tags |
| Substack | `substack` | 10000 chars | Newsletter/article with sections |
| YouTube Desc | `youtube-desc` | 5000 chars | Description with timestamps, links, tags |

## Examples

### Basic: Blog post to X thread + LinkedIn
```bash
bash execute.sh '{"source":"Today I learned that AI agents can coordinate across multiple tasks...","platforms":"x-thread,linkedin","tone":"casual","brand":"personal"}'
```

### From file to all platforms
```bash
bash execute.sh '{"sourceFile":"/path/to/blog-post.md","platforms":"x-thread,linkedin,xiaohongshu,substack","tone":"professional","brand":"crewly","outputDir":"/tmp/repurposed"}'
```

### Steve's personal content to Xiaohongshu
```bash
bash execute.sh '{"source":"My AI team shipped 3 features while I slept...","platforms":"xiaohongshu","tone":"casual","brand":"personal","language":"zh"}'
```

## Output

JSON object containing:
- `platforms[]` — Array of platform configs, each with `styleGuide`, `toneGuide`, `brandVoice`, `language`, `maxLength`
- `filesWritten[]` — Paths to written prompt files (if `outputDir` was specified)
- `instructions` — How to use the output

## Workflow

1. Run this skill to get platform-specific guides
2. For each platform, use the guide as context to generate content with the LLM
3. Review and adjust the generated content
4. Use `content-calendar` skill to schedule the content
5. Publish (manually or via platform-specific publisher skill)
