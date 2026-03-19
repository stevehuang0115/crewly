# Source Citation Standards

**Trigger**: always
**Applies to**: *
**Version**: 1.0.0

## Overview

Proper citation is non-negotiable for research integrity. Every factual claim,
statistic, and direct quote must be attributed to its source using the format
below. These standards apply to all research output — reports, briefings,
competitive analyses, and strategy documents.

## Citation Format

### Inline Citations
Use numbered references in square brackets within the text:

```
Crewly's PTY isolation model prevents lateral movement between agents [1],
unlike OpenClaw's shared-process architecture which exposed 135,000+ instances
to the ClawHavoc attack [2][3].
```

### Reference List
At the end of every document, include a numbered reference list:

```
## References

[1] Crewly Architecture Docs, "PTY Isolation Model", v1.3.34, March 2026.
    Source: specs/project.md (Primary — project documentation)

[2] SecurityWeek, "OpenClaw Vulnerability Exposes Thousands of AI Agents",
    March 5, 2026. URL: [link] (Secondary — tech publication)

[3] CVE-2026-0104, NIST National Vulnerability Database.
    URL: [link] (Primary — official vulnerability record)
```

### Citation Components
Each reference must include:
1. **Author/Organization** — Who published it
2. **Title** — What was published
3. **Date** — When (month + year minimum)
4. **Source type** — Primary, Secondary, or Tertiary
5. **URL or location** — Where to verify

## Source Credibility Tiers

| Tier | Source Type | Reliability | Use For |
|------|-----------|-------------|---------|
| **Tier 1 (Primary)** | Official docs, GitHub repos, CVE records, SEC filings, press releases | Highest | Core claims, architecture facts, vulnerability data |
| **Tier 2 (Secondary)** | Major tech publications (Ars Technica, SecurityWeek, The Verge), analyst reports, peer-reviewed papers | High | Market data, trend analysis, expert opinions |
| **Tier 3 (Tertiary)** | Blog posts, conference talks, podcast transcripts, social media from verified accounts | Medium | Supporting evidence, community sentiment, anecdotes |
| **Tier 4 (Unreliable)** | Anonymous posts, unverified social media, AI-generated content, SEO spam sites | Do Not Use | Never cite as evidence |

## Verification Process

1. **Can you access the source directly?** If not, find an accessible alternative
2. **Is the source independent?** Avoid circular citations (A cites B cites A)
3. **Is the date current?** Flag sources older than 6 months
4. **Does the claim match the source?** Re-read the actual text — don't paraphrase beyond what it says
5. **Is there a counter-source?** Seek at least one opposing viewpoint for controversial claims

## Checklist

- [ ] Every factual claim has an inline citation [N]
- [ ] Reference list included at document end
- [ ] Each reference has: author, title, date, source type, URL
- [ ] No Tier 4 sources used as evidence
- [ ] All URLs/locations are accessible and correct
- [ ] No circular citations
- [ ] Sources older than 6 months are flagged
- [ ] Claims accurately reflect source content
- [ ] Counter-sources acknowledged for controversial claims

## Exceptions

- **Common knowledge** (e.g., "TypeScript is a superset of JavaScript") does not
  need citation.
- **Internal team decisions** cited by meeting date and participants do not need
  external verification.
- **Preliminary analysis** may use fewer citations but must be clearly labeled
  and updated within 48 hours.
