# AI Marketing Team Template

A 3-agent AI marketing team designed for SMBs. Automates content strategy, creation, and analytics across social media platforms.

## Team Composition

- **Maya (Strategist)**: Plans weekly content calendars, researches trends, monitors competitors, and delegates content tasks to the Writer.
- **Alex (Writer)**: Creates platform-specific social media posts, blog articles, and email newsletters following brand guidelines.
- **Jordan (Analyst)**: Compiles weekly performance reports with platform metrics, top performers, and data-driven recommendations.

## Workflow

The team follows a weekly content cycle:

1. **Strategy** (Maya) — Research trends, review last week's performance, create content calendar
2. **Creation** (Alex) — Write content pieces from the calendar, following platform and brand guidelines
3. **Analysis** (Jordan) — Compile performance metrics, identify top content, recommend optimizations

## Included Skills

- `content-calendar` — CRUD operations for content scheduling
- `social-media-post` — Generate platform-specific posts
- `seo-blog-writer` — Write SEO-optimized blog content
- `daily-standup-report` — Generate team activity reports

## Quick Start

```bash
npx crewly create team --template marketing-team
```

## Customization

1. Fill in `knowledge/docs/brand-voice-guide.md` with your brand's voice and tone
2. Update `goals.md` with your specific marketing KPIs
3. Adjust content mix ratios in the Strategist's role prompt

## Quality Gates

- **Strategy Quality** — Validates calendar completeness and content mix
- **Content Quality** — Checks brand voice, grammar, and platform formatting
- **Report Quality** — Ensures metrics accuracy and actionable recommendations
