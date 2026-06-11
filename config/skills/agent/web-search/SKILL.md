---
name: web-search
description: Search the live web for a query and return ranked results (title, URL, snippet) as JSON. Works with no API key (DuckDuckGo HTML fallback) and uses the Brave Search API or SerpAPI automatically when BRAVE_API_KEY / SERPAPI_KEY is set. Any agent can call it for research, competitor analysis, market/trend lookups, fact-checking, finding sources to cite, or grounding a non-software goal (marketing, growth, commerce) in real-world information.
category: research
assignableRoles:
  - "*"
version: "1.0.0"
tags:
  - search
  - web
  - research
  - competitor-analysis
  - market-research
  - sources
  - brave
  - serpapi
  - duckduckgo
---

# Web Search

Search the live web and get back ranked results as JSON. This is the agent's
window onto the real world — use it for research, competitor/market analysis,
trend lookups, fact-checking, and finding sources to cite. It is the
load-bearing tool for non-software goals (marketing, growth, commerce) that
need real information, not just the model's training data.

## Usage

```bash
bash {{AGENT_SKILLS_PATH}}/web-search/execute.sh "best protein powder for runners 2026"
bash {{AGENT_SKILLS_PATH}}/web-search/execute.sh --query "competitors of Notion" --limit 5
bash {{AGENT_SKILLS_PATH}}/web-search/execute.sh '{"query":"shopify conversion rate benchmarks","limit":8}'
```

- `--query` / positional / JSON `{"query":...}` — the search query (required).
- `--limit N` / JSON `limit` — max results (default 8, capped at 20).

## Output

Newline-free JSON on stdout:

```json
{
  "query": "competitors of Notion",
  "provider": "brave",
  "results": [
    { "title": "...", "url": "https://...", "snippet": "..." }
  ]
}
```

On failure it still returns valid JSON with an empty `results` array and an
`error` field, so callers can branch without parsing stderr.

## Providers (auto-selected, best → fallback)

1. **Brave Search API** — when `BRAVE_API_KEY` is set. Clean JSON, best quality.
2. **SerpAPI (Google)** — when `SERPAPI_KEY` is set.
3. **DuckDuckGo HTML** — no key required. Best-effort scrape of titles + URLs;
   snippets may be sparse. Always available so the skill works out of the box.

Set a key in your `.env` (`BRAVE_API_KEY=...` — free tier at
https://brave.com/search/api/) for higher-quality, rate-limit-friendly results.

## Notes

- Read-only: this skill only *fetches* search results; it never posts, buys, or
  changes anything.
- Respects a 15s network timeout and returns whatever it has.
