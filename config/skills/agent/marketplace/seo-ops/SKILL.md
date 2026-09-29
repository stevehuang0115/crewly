---
name: SEO Ops
description: "Search Console-driven SEO operations for any site: query patterns (low-CTR top-3, near-miss 4-20, rising queries, keyword cannibalization), per-URL report cards, pre-publish SEO/AEO checks, a gated programmatic-page queue, and a live-diff gate that stops agents from removing things from live pages. Use when auditing organic search, deciding what to rewrite, or before changing a live page. For writing posts use seo-blog-writer instead."
version: 1.0.0
category: productivity
skillType: claude-skill
author: Crewly
license: MIT
assignableRoles:
  - marketing
  - content-strategist
  - generalist
  - developer
  - fullstack-dev
triggers:
  - seo report
  - search console
  - keyword cannibalization
  - pre-publish seo check
  - programmatic seo pages
  - live page diff
tags:
  - seo
  - aeo
  - search-console
  - marketing
  - content
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 120000
---

# SEO Ops

Search Console-driven SEO operations for any site. One skill, one JSON config per site.
Read-only against Google (scopes `webmasters.readonly`, optionally `analytics.readonly`); it never edits a site.

## Setup (once per machine, one line)

```bash
export SEO_OPS_GOOGLE_CREDENTIALS=/path/to/service-account.json
```

Needs `python3` >= 3.8 and `openssl` (both preinstalled on macOS and most Linux). No pip installs.
Then add the service account's email (`client_email` inside the JSON) as a **restricted** user in
Search Console for your property (Settings -> Users and permissions), and enable the Search Console API
for its Google Cloud project. For GA4, add it as Viewer on the property.

Copy `seo-ops.config.example.json` next to your project and fill it in:

| Key | Meaning |
|-----|---------|
| `siteUrl` | Site origin, e.g. `https://example.com` |
| `gscProperty` | `sc-domain:example.com` or a URL-prefix property |
| `ga4PropertyId` | GA4 property id (used by `page-report --ga4`) |
| `credentialsPath` | **Name of the env var** holding the key file path. Never the key, never a path |
| `sitemapUrl` | Sitemap or sitemap index URL |
| `exclusions.queries` / `exclusions.pages` | Regexes (case-insensitive) dropped from every report (brand terms, `site:` checks, admin paths) |
| `publishMethod` | Free text shown to you after each command, e.g. "open a blog PR on <org>/web" |
| `maxPagesPerDay` | Pattern-queue release limit (default 1) |
| `thresholds`, `prepublish`, `liveDiff`, `patternQueue` | Optional tuning, see the example file |

## Commands

Run as `bash config/skills/agent/marketplace/seo-ops/execute.sh --config seo-ops.config.json <command> ...`
or with a JSON argument: `execute.sh '{"command":"gsc-report","config":"seo-ops.config.json","days":28}'`.

Exit codes: `0` ok, `1` gate failed / needs human approval, `2` setup or credentials problem, `3` permission problem.
Every command prints **what it examined**. A check that examined nothing exits `1`; it never reports clean.

### `gsc-report [--days 28] [--json out.json]`
Search Console for the last N days (ending 3 days ago, vs the previous N). Four patterns, all computed in code:
1. Top-3 position with CTR < 35% (and 100+ impressions): rewrite title/description.
2. Positions 4-20 with 40+ impressions: add content and internal links.
3. Fastest-rising queries (new ones flagged): topic candidates.
4. **Keyword cannibalization**: a query served by 2+ pages (each with 10+ impressions). Pick the winner, point the others at it.

### `page-report [--url U ... | --urls-file F] [--include REGEX] [--days 28] [--ga4]`
Report card per URL (default: every sitemap URL). Flags: not in sitemap; 0 impressions after 7 days; average position > 20;
top-5 with CTR < 5%. Pages under 7 days old get numbers only (Search Console lags 2-3 days). Age comes from sitemap `lastmod`; unknown age is reported, not guessed.

### `prepublish-check (--url U | --file draft.html [--canonical-url U]) [--target "query"] [--brief]`
SEO (title, description, canonical, h1/h2, body length, internal links, sitemap, structured data) and AEO
(direct-answer opening, a figure early, primary-source link, question headings, dates, no "see above" wording).
Warns when a "best / latest / comparison" page title lacks the current year. `FAIL` exits `1`; clear FAILs before publishing, judge WARNs.

### `pattern-queue plan | next | status [--out DIR] [--json F]`
Programmatic pages (template x variables) behind a **"should this page exist" gate**. Nothing is queued blindly.
- **Demand gate**: queries matching the variable values (or their aliases) must reach `patternQueue.demand.minImpressions` over `demand.days`. Zero matched queries = skipped, reported as a count and reason. `seeds` bypass this gate only.
- **Near-duplicate gate**: bound data is compared with the parent page and every already-accepted or released sibling; similarity >= `similarity.threshold` (default 0.90) is skipped with the score and the page it duplicates. Put label fields in `similarity.ignoreKeys`.
- **Live data binding**: the template must contain `{{data.field}}` bindings and `dataSource` (a `url` or `command` template using `{variable}`) must return JSON. A template with no bindings is **rejected**; an unresolved binding **fails the render** and does not use up the day's slot.
- `plan` prints the ranked build/skip list with a reason for every candidate. `next` releases at most `maxPagesPerDay` (default **1**) and **refuses** a second release the same day (before any network call). Locales count together as one page unless `localesCountTogether` is false. State lives in `patternQueue.statePath`.

### `live-diff --url LIVE (--proposed-file F | --proposed-url U)`  (no config needed)
The gate to run **before changing any live page**. Fetches the live HTML, compares with the proposed version and reports removed/added
headings, tables, links and structured data (down to JSON-LD properties), plus text-length delta.
**Anything REMOVED, or text shrinking more than `liveDiff.maxTextShrinkPct` (30%), exits `1` with "NEEDS HUMAN APPROVAL":
stop and show the report to a person.** Pure additions and text edits pass. If either side parses to 0 elements it fails (nothing was compared).
Tables are matched by header row, so updating cell values is an edit, deleting a table is a removal.

## Rules for agents

- Run `live-diff` before every edit to a published page; never override its exit code yourself.
- Do not put keys, property ids of other customers, or site data in this skill's folder.
- Missing/unauthorized credentials produce a one-screen fix message; follow it rather than retrying.
- Publish through the site's own process (see `publishMethod`); this skill does not publish.
