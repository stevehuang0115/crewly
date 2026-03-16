---
name: Content Writer
description: "Generate platform-specific writing briefs and manage content drafts. Supports X threads, LinkedIn posts, Xiaohongshu notes, Substack newsletters, YouTube descriptions, and blog posts. Includes brand voice presets for Crewly and Steve's personal content."
version: 1.0.0
category: content
skillType: claude-skill
assignableRoles:
  - content-strategist
  - product-manager
  - generalist
  - designer
triggers:
  - write content
  - create post
  - draft content
  - write thread
  - write article
  - content draft
tags:
  - content
  - writing
  - draft
  - social-media
  - marketing
  - x-thread
  - linkedin
  - xiaohongshu
  - substack
  - youtube
  - blog
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Content Writer

Generate platform-specific content drafts with brand voice, tone, and format guidelines. Manages the full lifecycle from writing brief to saved draft.

## Workflow

```
1. Generate writing brief     → execute.sh '{"action":"draft",...}'
2. Write content using brief  → Agent uses LLM to write
3. Save completed draft       → execute.sh '{"action":"save",...}'
4. Add to content calendar    → content-calendar skill
5. Steve reviews + publishes  → Manual
```

## Actions

### `draft` — Generate a writing brief

Returns structured guidelines for writing a specific piece of content. The agent then uses these to generate the actual text.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `action` | Yes | `"draft"` |
| `topic` | Yes | What to write about |
| `platform` | Yes | `x-thread`, `x-single`, `linkedin`, `xiaohongshu`, `substack`, `youtube-desc`, `blog` |
| `line` | No | `crewly` (brand) or `personal` (Steve). Default: `crewly` |
| `tone` | No | `professional`, `casual`, `technical`, `inspiring`, `provocative`, `educational`. Default: `professional` |
| `length` | No | `short`, `medium`, `long`. Default: `medium` |
| `audience` | No | Custom audience description (overrides default) |
| `context` | No | Additional context: reference data, trend info, competitor analysis |
| `references` | No | URLs or docs to reference |
| `cta` | No | Specific call-to-action to include |

### `save` — Save a completed draft

| Parameter | Required | Description |
|-----------|----------|-------------|
| `action` | Yes | `"save"` |
| `title` | Yes | Content title |
| `platform` | Yes | Platform name |
| `content` | Yes | The full content text (markdown) |
| `line` | No | Content line (default: crewly) |
| `draftId` | No | Draft ID from the brief (for traceability) |
| `calendarId` | No | Content calendar entry ID to link |

### `get` — Read a saved draft

| Parameter | Required | Description |
|-----------|----------|-------------|
| `action` | Yes | `"get"` |
| `filePath` | Yes* | Path to the draft file |
| `draftId` | Yes* | Or search by draft ID |

*One of filePath or draftId required.

### `list` — List saved drafts

| Parameter | Required | Description |
|-----------|----------|-------------|
| `action` | Yes | `"list"` |
| `platform` | No | Filter by platform |
| `limit` | No | Max results (default: 20) |

## Examples

### Generate a writing brief for an X thread
```bash
bash execute.sh '{"action":"draft","topic":"AI agent security - what we learned from n8n 8 CVEs","platform":"x-thread","line":"crewly","tone":"provocative","context":"n8n disclosed 8 critical CVEs on 2/25/2026 including RCE via sandbox escape. Crewly uses PTY isolation."}'
```

### Generate a brief for a Xiaohongshu post
```bash
bash execute.sh '{"action":"draft","topic":"My AI team shipped while I slept - week 1 report","platform":"xiaohongshu","line":"personal","tone":"casual"}'
```

### Save a completed draft
```bash
bash execute.sh '{"action":"save","title":"AI agent security thread","platform":"x-thread","line":"crewly","content":"[1/5] n8n just disclosed 8 critical CVEs...\n\n[2/5] The scariest one?...","projectPath":"/path/to/project"}'
```

### List all LinkedIn drafts
```bash
bash execute.sh '{"action":"list","platform":"linkedin","projectPath":"/path/to/project"}'
```

## Platform Writing Tips

### X Thread Best Practices
- Hook tweet is everything — if they don't stop scrolling, nothing else matters
- Each tweet = one idea, one screenshot, or one data point
- Use numbers: "3 things I learned" > "Things I learned"
- End with a thread-pull: "If this was useful, follow me for more"
- Steve's top performers on Xiaohongshu all had strong visual hooks — apply same principle

### LinkedIn Best Practices
- First line shows in feed preview — make it impossible to not click "see more"
- "I" stories outperform "You should" advice
- Specific > general: "We saved 47 hours/week" > "We saved a lot of time"
- Post between 8-10am EST Tuesday-Thursday for max reach

### Xiaohongshu Best Practices (from Steve's data)
- Video outperforms image-text (20 videos vs 12 image-text in Steve's archive)
- Top tags to use: 创业MVP, 职场smalltalk, 用好ai拿捏职场, vibecoding
- Steve's top post (201 likes): "Claude Code牛马工厂" — visual + relatable + specific tool
- Social/community posts (Google coffee chat: 164 likes) also perform well
- Include 8+ hashtags for discovery

### Substack Best Practices
- Subject line = open rate. Test: numbers, questions, or contrarian takes
- Personal stories in the opening paragraph build connection
- Include 1 actionable takeaway readers can use this week
- Cross-promote: mention X thread, YouTube video in each issue

## Brand Voice Quick Reference

### Crewly Brand
- **Do:** Use specific metrics, show product screenshots, reference real use cases
- **Don't:** Claim "revolutionary" or "game-changing", oversell features not yet built
- **Signature phrases:** "AI Team", "Ready in Days", "Quality Gates", "Live Terminal"

### Steve Personal
- **Do:** Share real numbers, mention Google/side projects, be vulnerable about failures
- **Don't:** Lecture, be preachy, use generic "hustle" motivation
- **Signature phrases:** "一人公司", "下班2小时", "留在牌桌上", "Build in Public"
