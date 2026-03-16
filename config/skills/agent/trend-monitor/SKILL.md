---
name: Trend Monitor
description: Monitor and store trending topics from X, Google Trends, Hacker News, Product Hunt, Reddit, and GitHub. Save browser-extracted trends, query latest data, and get AI-filtered topic suggestions for content planning.
version: 1.0.0
category: content
skillType: claude-skill
assignableRoles:
  - content-strategist
  - product-manager
  - generalist
triggers:
  - trending topics
  - what is trending
  - trend monitor
  - hot topics
  - content ideas
  - topic suggestions
tags:
  - trends
  - monitoring
  - content
  - social-media
  - hackernews
  - producthunt
  - x-twitter
  - marketing
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Trend Monitor

Monitor trending topics across platforms using browser automation, then store and query them for content planning.

## Architecture

This skill has two parts:
1. **Browser scanning** (agent-driven) — You use Playwright MCP or Chrome browser tools to visit pages and extract trends
2. **Data management** (execute.sh) — Save, query, and get suggestions from stored trend data

## Data Actions (execute.sh)

### `save` — Store trends from a browser scan

| Parameter | Required | Description |
|-----------|----------|-------------|
| `action` | Yes | `"save"` |
| `source` | Yes | `x-trending`, `google-trends`, `hackernews`, `producthunt`, `reddit`, `github-trending`, `custom` |
| `trends` | Yes | JSON array of trend objects (see schema below) |
| `projectPath` | No | Project path for storage location |

**Trend object schema:**
```json
{
  "title": "Topic or headline",
  "url": "https://source-url",
  "description": "Brief description",
  "engagement": "500 points / 200 comments",
  "relevanceScore": 8,
  "tags": ["ai", "agents", "automation"]
}
```

`relevanceScore` (1-10): How relevant to AI Agent / Crewly content. Score guide:
- 9-10: Directly about AI agents, orchestration, multi-agent systems
- 7-8: About AI tools, LLMs, automation, developer tooling
- 5-6: About SaaS, startups, productivity, SMB
- 3-4: General tech, not directly relevant
- 1-2: Not relevant

### `list` — List available trend scan files

| Parameter | Required | Description |
|-----------|----------|-------------|
| `action` | Yes | `"list"` |
| `source` | No | Filter by source |
| `date` | No | Filter by date (YYYY-MM-DD) |
| `limit` | No | Max files to return (default: 10) |

### `latest` — Get the most recent trends

| Parameter | Required | Description |
|-----------|----------|-------------|
| `action` | Yes | `"latest"` |
| `source` | No | Filter by source |
| `limit` | No | Max items (default: 20) |

### `suggest` — Get AI-filtered topic suggestions

| Parameter | Required | Description |
|-----------|----------|-------------|
| `action` | Yes | `"suggest"` |
| `line` | No | Content line: `crewly` or `personal` (default: crewly) |
| `limit` | No | Max suggestions (default: 5) |

## Browser Scanning Guide

### Step-by-step: How to scan each source

The agent should perform these browser operations, then pass the extracted data to `execute.sh save`.

---

### Source 1: Hacker News (hackernews)

**URL:** `https://news.ycombinator.com`

**Steps:**
1. Navigate to `https://news.ycombinator.com`
2. Take a snapshot of the page
3. Extract from each story row:
   - Title text
   - URL (href from titleline link)
   - Points and comment count (from subline)
4. Score relevance (AI/agent/automation related = high score)
5. Save top 20 stories

**Alternative (faster):** Use WebSearch with query `site:news.ycombinator.com AI agents` for targeted results.

**Example save:**
```bash
bash execute.sh '{"action":"save","source":"hackernews","projectPath":"/path/to/project","trends":[
  {"title":"Show HN: Open-source AI agent framework","url":"https://news.ycombinator.com/item?id=123","engagement":"342 points, 89 comments","relevanceScore":9,"tags":["ai","agents","open-source"]},
  {"title":"Why we moved from n8n to custom orchestration","url":"https://example.com/post","engagement":"156 points, 43 comments","relevanceScore":8,"tags":["automation","n8n","orchestration"]}
]}'
```

---

### Source 2: X/Twitter Trending (x-trending)

**URL:** `https://x.com/explore/tabs/trending`

**Steps:**
1. Navigate to `https://x.com/explore/tabs/trending` (or `https://x.com/explore`)
2. Take a snapshot
3. Extract trending topics and hashtags
4. For each trend, note:
   - Topic name / hashtag
   - Tweet count or category if shown
   - Brief context if available
5. Score relevance to AI/tech/startup

**Alternative:** Use WebSearch with `site:x.com trending AI agents` or check `https://trends24.in/united-states/`

---

### Source 3: Product Hunt (producthunt)

**URL:** `https://www.producthunt.com`

**Steps:**
1. Navigate to `https://www.producthunt.com`
2. Take a snapshot of today's launches
3. Extract from each product:
   - Product name and tagline
   - Upvote count
   - URL
   - Category/tags
4. Filter for AI/automation/developer tools
5. Score relevance

---

### Source 4: Google Trends (google-trends)

**URL:** `https://trends.google.com/trending?geo=US`

**Steps:**
1. Navigate to `https://trends.google.com/trending?geo=US`
2. Take a snapshot
3. Extract daily trending searches
4. Filter for tech/AI related terms
5. Score relevance

**Alternative:** Use WebSearch with `Google Trends AI agents 2026` for curated results.

---

### Source 5: Reddit (reddit)

**URLs:**
- `https://www.reddit.com/r/artificial/hot/`
- `https://www.reddit.com/r/LocalLLaMA/hot/`
- `https://www.reddit.com/r/SideProject/hot/`

**Steps:**
1. Navigate to each subreddit
2. Extract top 10 posts: title, score, comment count, URL
3. Score relevance

---

### Source 6: GitHub Trending (github-trending)

**URL:** `https://github.com/trending`

**Steps:**
1. Navigate to `https://github.com/trending`
2. Extract: repo name, description, stars today, language
3. Filter for AI/agent/automation repos
4. Score relevance

---

## Recommended Scan Schedule

| Time | Source | Frequency |
|------|--------|-----------|
| Morning | Hacker News + Product Hunt | Daily |
| Afternoon | X Trending + Reddit | Daily |
| Weekly | Google Trends + GitHub Trending | Monday |

## Workflow Integration

```
1. Agent runs browser scans → saves via execute.sh save
2. Agent calls execute.sh suggest → gets AI-filtered topics
3. Agent feeds suggestions to content-writer skill
4. Agent adds chosen topics to content-calendar
```

## Example: Full Daily Scan

```bash
# After scanning HN via browser and extracting data:
bash execute.sh '{"action":"save","source":"hackernews","projectPath":"/path","trends":[...]}'

# After scanning PH via browser:
bash execute.sh '{"action":"save","source":"producthunt","projectPath":"/path","trends":[...]}'

# Get suggestions for content:
bash execute.sh '{"action":"suggest","line":"crewly","projectPath":"/path"}'

# Check latest across all sources:
bash execute.sh '{"action":"latest","limit":"10","projectPath":"/path"}'
```
