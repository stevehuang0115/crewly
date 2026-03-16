---
name: Competitor Content Tracker
description: Track and compare competitor content activity across blogs, social media, GitHub releases, and community channels. Supports CrewAI, n8n, Relevance AI, AutoGen, LangChain, and others.
version: 1.0.0
category: content
skillType: claude-skill
assignableRoles:
  - content-strategist
  - product-manager
  - generalist
triggers:
  - competitor content
  - track competitor
  - competitor analysis
  - what are competitors posting
  - competitive content
tags:
  - competitors
  - content
  - tracking
  - analysis
  - crewai
  - n8n
  - relevance-ai
  - marketing
  - competitive-intelligence
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Competitor Content Tracker

Track and compare competitor content activity using browser automation and web search. Store structured data for trend analysis and content strategy.

## Architecture

1. **Browser scanning** (agent-driven) — Visit competitor pages, extract content data
2. **Data management** (execute.sh) — Save, query, and compare stored data

## Data Actions (execute.sh)

### `save` — Store content items from a competitor scan

| Parameter | Required | Description |
|-----------|----------|-------------|
| `action` | Yes | `"save"` |
| `competitor` | Yes | `crewai`, `n8n`, `relevance-ai`, `autogen`, `langchain`, `langraph`, `openai`, `other` |
| `sourceType` | Yes | `blog`, `twitter`, `linkedin`, `github-release`, `changelog`, `youtube`, `community`, `press`, `other` |
| `items` | Yes | JSON array of content items (see schema below) |

**Content item schema:**
```json
{
  "title": "Blog post or content title",
  "url": "https://...",
  "publishedDate": "2026-02-27",
  "description": "Brief summary",
  "engagement": "45 likes, 12 comments",
  "contentType": "blog post / tweet / video",
  "tags": ["mcp", "agents", "enterprise"]
}
```

### `list` — List tracked content files

| Parameter | Required | Description |
|-----------|----------|-------------|
| `action` | Yes | `"list"` |
| `competitor` | No | Filter by competitor |
| `limit` | No | Max results (default: 20) |

### `latest` — Get latest content from a competitor

| Parameter | Required | Description |
|-----------|----------|-------------|
| `action` | Yes | `"latest"` |
| `competitor` | Yes | Which competitor |
| `sourceType` | No | Filter by source type |
| `limit` | No | Max items (default: 15) |

### `compare` — Compare content activity across competitors

| Parameter | Required | Description |
|-----------|----------|-------------|
| `action` | Yes | `"compare"` |
| `competitors` | No | Comma-separated list (default: `crewai,n8n,relevance-ai`) |
| `days` | No | Lookback period in days (default: 7) |

## Browser Scanning Guide

### Competitor: CrewAI

**Blog:**
- URL: `https://www.crewai.com/blog`
- Extract: title, date, summary, URL for each post
- Focus on: product announcements, enterprise features, case studies

**GitHub:**
- URL: `https://github.com/crewAIInc/crewAI/releases`
- Extract: version, release date, key changes
- Also check: `https://docs.crewai.com/en/changelog`

**Twitter/X:**
- URL: `https://x.com/craborai` (CrewAI official)
- Extract: recent tweets, engagement (likes, retweets, replies)
- Focus on: product announcements, partnership news

**PyPI (version tracking):**
- URL: `https://pypi.org/project/crewai/#history`
- Extract: version numbers, release dates

**Example save:**
```bash
bash execute.sh '{"action":"save","competitor":"crewai","sourceType":"blog","projectPath":"/path","items":[
  {"title":"The State of Agentic AI in 2026","url":"https://www.crewai.com/blog/state-of-agentic-ai","publishedDate":"2026-02-25","description":"Survey of 500 enterprises on AI agent adoption","engagement":"high - featured on front page","tags":["enterprise","survey","market-data"]},
  {"title":"CrewAI v1.10.0 Release","url":"https://github.com/crewAIInc/crewAI/releases/tag/v1.10.0","publishedDate":"2026-02-27","description":"MCP enhancements, HITL improvements","engagement":"64 open issues","tags":["release","mcp","hitl"]}
]}'
```

---

### Competitor: n8n

**Blog / Community:**
- URL: `https://community.n8n.io/c/announcements/`
- URL: `https://blog.n8n.io/`
- Extract: announcements, feature updates, security bulletins

**GitHub:**
- URL: `https://github.com/n8n-io/n8n/releases`
- Extract: version, date, key changes
- Also: `https://docs.n8n.io/release-notes/`

**Twitter/X:**
- URL: `https://x.com/n8n_io`
- Extract: recent tweets, engagement

**Security (critical to track):**
- URL: `https://community.n8n.io/tag/security`
- Extract: CVE disclosures, patch versions

**Example save:**
```bash
bash execute.sh '{"action":"save","competitor":"n8n","sourceType":"community","projectPath":"/path","items":[
  {"title":"Security Bulletin February 25, 2026","url":"https://community.n8n.io/t/security-bulletin-february-25-2026/270324","publishedDate":"2026-02-25","description":"8 critical/high CVEs disclosed","engagement":"community discussion active","tags":["security","cve","critical"]}
]}'
```

---

### Competitor: Relevance AI

**Changelog:**
- URL: `https://relevanceai.com/changelog`
- Extract: feature name, date, description

**Blog:**
- URL: `https://relevanceai.com/blog`
- Extract: posts, topics, publication dates

**Twitter/X:**
- URL: `https://x.com/RelevanceAI_`
- Extract: tweets, engagement

---

### Competitor: AutoGen (Microsoft)

**GitHub:**
- URL: `https://github.com/microsoft/autogen/releases`
- Extract: version, changes, community engagement

**Blog:**
- URL: `https://microsoft.github.io/autogen/blog/`
- Extract: posts, research papers

---

### Competitor: LangChain / LangGraph

**Blog:**
- URL: `https://blog.langchain.dev/`
- Extract: posts, product announcements

**GitHub:**
- URL: `https://github.com/langchain-ai/langgraph/releases`
- Extract: releases, features

**Twitter/X:**
- URL: `https://x.com/LangChainAI`

---

## Recommended Scan Schedule

| Frequency | What to Scan |
|-----------|-------------|
| **Daily** | CrewAI Twitter, n8n Twitter — quick check for announcements |
| **Twice/week** | CrewAI blog, n8n community, Relevance AI changelog |
| **Weekly** | GitHub releases (all competitors), full comparison report |
| **Ad-hoc** | When WebSearch reveals breaking news (acquisitions, security events, major launches) |

## Workflow Integration

```
1. Agent scans competitor pages via browser/WebSearch
2. Agent saves structured data via execute.sh save
3. Agent runs compare to see cross-competitor activity
4. Agent identifies content opportunities (reactive or counter-narrative)
5. Agent feeds opportunities to trend-monitor suggest or content-writer draft
```

## Content Strategy Angles by Competitor

### vs CrewAI
- **Their strength:** Enterprise narrative, large community, Python ecosystem
- **Our angle:** TypeScript/runtime-agnostic, live terminal, simpler setup for SMBs
- **Content trigger:** When they release enterprise features, we publish "here's how SMBs get the same power without the complexity"

### vs n8n
- **Their strength:** Massive community (177K stars), mature integrations, visual workflow builder
- **Our angle:** Security (PTY isolation vs their CVE history), AI-native (they added AI), full autonomy vs workflow steps
- **Content trigger:** Security events, workflow builder limitations for AI tasks

### vs Relevance AI
- **Their strength:** No-code agents, marketplace scale (215+ agents)
- **Our angle:** Developer control, open source, custom skills, not locked into their platform
- **Content trigger:** When they push no-code, we publish "why developers need code-level control for AI agents"

## Compare Report Example

```bash
# Weekly comparison across top 3 competitors
bash execute.sh '{"action":"compare","competitors":"crewai,n8n,relevance-ai","days":"7","projectPath":"/path"}'
```

This outputs total items tracked, breakdown by source type, and recent titles for each competitor. Use this to identify:
- Who is publishing most actively?
- What topics are they focusing on?
- Where are there gaps we can fill?
