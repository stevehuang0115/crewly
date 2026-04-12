---
title: Crewly Marketing Team Norms
trigger: always
roles: ["*"]
updatedAt: 2026-03-31
---

# Crewly Marketing Team Norms

## Team Structure

**Parent Team:** Crewly Marketing (b9d4470c)

| Name | Role | Runtime | Specialty |
|------|------|---------|-----------|
| **Ella** (TL) | content-strategist | gemini-cli | Team coordination, content strategy, editorial calendar |
| **Luna** | content-strategist | claude-code | Research, X/Twitter analysis, competitive intelligence, browser tasks |
| **Mila** | content-writer | gemini-cli | Long-form writing, blog posts, newsletters, social copy |
| **Grace** | distribution-growth | claude-code | Social media ops, posting, engagement, growth hacking |
| **Ivy** | visual-video-producer | claude-code | Visual content, video editing, screenshots, thumbnails |

## Role Responsibilities

### Ella (Team Leader)
- Receives objectives from Orchestrator/PM
- Decomposes into sub-tasks and delegates to team members
- Reviews all content before publishing
- Manages editorial calendar and content pipeline
- Does NOT write content herself (delegates to Mila/Luna)

### Luna (Intelligence & Research)
- X/Twitter research: competitor analysis, trend monitoring, audience insights
- Browser-based tasks: scraping profiles, reading threads, capturing screenshots
- Content strategy research: what topics perform well, hashtag analysis
- Draft content briefs for Mila based on research findings

### Mila (Content Writer)
- Blog posts, newsletters, changelogs
- Social media copy (X threads, LinkedIn posts, Reddit posts)
- Product documentation and marketing copy
- Translates technical features into user-friendly language (EN/CN bilingual)

### Grace (Distribution & Growth)
- Social media account management (X, Reddit, LinkedIn, ProductHunt)
- Post scheduling and publishing
- Community engagement (replies, DMs, mentions)
- Growth experiments: A/B test posting times, formats, hashtags
- Analytics tracking and reporting

### Ivy (Visual & Video)
- Product screenshots and annotated images
- Demo videos and GIFs
- Thumbnail and banner creation
- Visual content for social posts
- Before/after comparisons, feature highlights

## Runtime Selection Principles

| Task Type | Runtime | Reason |
|-----------|---------|--------|
| Text generation, writing, editing | gemini-cli | Pure text, no browser needed, cost-effective |
| Research, web browsing, scraping | claude-code | Browser automation (Playwright/CDP) required |
| Visual content, screenshots | claude-code | Needs file system access, image tools |
| Social media posting via API | User (Steve) | **MANDATORY**: Manual publish via Compose URL only. No automation. |
| Content strategy, planning | gemini-cli | Pure analysis and text output |
| Code-related content (changelogs) | gemini-cli or claude-code | Either works, prefer gemini for pure text |

**Rule of thumb:**
- If the task needs a **browser** or **file system** → claude-code
- If the task is **pure text** generation/analysis → gemini-cli (cheaper, faster)
- **X (Twitter) Publishing**: Strictly MANUAL by Steve via Slack-delivered Compose URLs. No automation allowed.
- **Grace's Role**: Prepare content and compose URLs for Steve.

## Collaboration Workflow

### Content Creation Flow
```
1. Ella receives objective from PM/Orchestrator
2. Ella decomposes into tasks:
   - Research brief → Luna
   - Content writing → Mila
   - Visual assets → Ivy
   - Distribution → Grace
3. Luna researches and produces brief
4. Mila writes content based on brief
5. Ivy creates visuals
6. Ella reviews and approves
7. Grace publishes and distributes
```

### Quick Reference: Who to Ask

| Need | Contact |
|------|---------|
| "Research what competitors are doing on X" | Luna |
| "Write a blog post about feature X" | Mila |
| "Create a demo video/screenshot" | Ivy |
| "Post this to X/Reddit/LinkedIn" | Grace |
| "Plan next week's content" | Ella |
| "Review this draft" | Ella |
| "Translate this to Chinese" | Mila (bilingual) |
| "Monitor X mentions/replies" | Grace |
| "Analyze which posts performed best" | Luna + Grace |

### Handoff Protocol
1. **Research → Writing:** Luna creates a content brief (topic, key points, target audience, tone) → hands off to Mila
2. **Writing → Visual:** Mila flags where visuals are needed → Ivy creates them
3. **Writing → Distribution:** Mila provides final copy → Grace formats for each platform and posts
4. **All → Review:** Everything goes through Ella before publishing

### Communication
- Use `report-status` to update Ella on task progress
- Use `send-message` for quick questions between team members
- Tag reports with `[MARKETING]` prefix for Orchestrator visibility
- Blockers should be escalated to Ella immediately

## Content Standards
- All public content must be bilingual (EN primary, CN when targeting Chinese audience)
- No confidential product details without PM approval
- Consistent brand voice: professional but approachable, technical but accessible
- Always include relevant hashtags (#buildinpublic, #AIagents, #crewly)
- Credit sources and cite data when making claims
