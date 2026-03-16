# Source Citation Standards

**Trigger**: always
**Applies to**: *
**Version**: 1.0.0

## Overview

Defines the citation format, credibility verification process, and source quality standards for all research output. Every claim, statistic, or factual statement must be traceable to a credible, verifiable source.

## Steps

### Step 1: Assess Source Credibility

Before citing any source, evaluate it against this credibility tier system:

| Tier | Source Type | Examples | Trust Level |
|------|-----------|----------|-------------|
| **Tier 1** | Official/Primary | Company docs, official blogs, SEC filings, peer-reviewed papers | High — cite directly |
| **Tier 2** | Reputable Secondary | Major tech publications, established analysts, government data | High — cite with attribution |
| **Tier 3** | Community/Expert | Developer blogs, conference talks, Stack Overflow (high-rep answers) | Medium — cross-reference required |
| **Tier 4** | User-Generated | Reddit, forums, tweets, personal blogs | Low — use only for sentiment, not facts |
| **Tier 5** | AI-Generated | ChatGPT, Gemini, Claude outputs | Not citable — verify claim via Tier 1-3 source |

Rules:
- Key claims must cite at least one Tier 1 or Tier 2 source
- Tier 3 sources require cross-referencing with at least one other independent source
- Tier 4 sources may only be used to illustrate community sentiment, not as factual evidence
- Tier 5 sources are never citable — always find the original source

### Step 2: Format Citations

**Inline citation format:**

```
According to [Source Name](URL), {claim}. [Accessed: YYYY-MM-DD]
```

**Numbered reference format (for longer documents):**

In the body text:
```
{claim} [1].
```

In the Sources section:
```
[1] Author/Organization. "Title." Source Name, Date. URL. Accessed: YYYY-MM-DD.
```

**Required metadata for every citation:**
- Author or organization name
- Title of the specific page or document
- Publication name or website
- Publication date (or "n.d." if not available)
- URL (full, not shortened)
- Access date

### Step 3: Verify Source Freshness

- For technology topics: sources older than 12 months require verification that the information is still current
- For market data: sources older than 6 months should be flagged as potentially outdated
- For API/product documentation: always verify against the latest official docs
- Date the source with `[as of YYYY-MM]` when freshness matters

### Step 4: Handle Missing or Conflicting Sources

**When sources conflict:**
- Present both perspectives with citations
- Note the contradiction explicitly: "Source A states X [1], while Source B reports Y [2]."
- If possible, identify the more authoritative source and explain why
- Never silently choose one interpretation over another

**When no source exists:**
- Clearly label the statement as the team's analysis or opinion
- Use phrasing like: "Based on our analysis..." or "We observe that..."
- Do not present unsourced analysis as established fact

### Step 5: Compile the Sources Section

At the end of every research deliverable, include a Sources section:

```markdown
## Sources

[1] Author. "Title." Publication, Date. URL. Accessed: YYYY-MM-DD.
[2] Organization. "Title." Date. URL. Accessed: YYYY-MM-DD.
...
```

- Order sources by first appearance in the document
- Include all sources referenced in the text
- Do not include sources that were consulted but not cited
- Separate primary sources from secondary sources if the list exceeds 10 items

## Checklist

- [ ] Every factual claim has at least one citation
- [ ] Key claims cite Tier 1 or Tier 2 sources
- [ ] Tier 3 sources are cross-referenced with an independent source
- [ ] No Tier 5 (AI-generated) sources cited
- [ ] Citations include all required metadata (author, title, date, URL, access date)
- [ ] Source freshness verified (< 12 months for tech, < 6 months for market data)
- [ ] Conflicting sources presented with both perspectives
- [ ] Unsourced analysis clearly labeled as team opinion
- [ ] Sources section compiled at the end of the deliverable
- [ ] All URLs are valid and accessible

## Exceptions

- **Internal knowledge base references**: When citing internal Crewly documentation or team decisions, a document title and date suffice — no URL required.
- **Common knowledge**: Universally accepted facts (e.g., "JavaScript runs in web browsers") do not require citation.
- **Social media monitoring**: When reporting on community sentiment, aggregate observations may replace individual citations (e.g., "Multiple Reddit threads in r/programming discussed...") but must note the search terms and date range used.
