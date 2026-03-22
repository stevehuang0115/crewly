---
name: brand-onboarding
description: Interactive brand onboarding questionnaire that collects business information and generates a Brand Voice Guide for marketing team agents.
version: 1.0.0
category: marketing
assignableRoles:
  - strategist
  - orchestrator
triggers:
  - on_team_create
  - manual
tags:
  - marketing
  - onboarding
  - brand
  - setup
execution:
  type: script
  script: execute.sh
  interpreter: bash
  timeout: 60000
---

# Brand Onboarding

Collects brand information from the business owner and generates a Brand Voice Guide
that all marketing team agents use to maintain brand consistency.

## Usage

### Start onboarding session
```bash
bash execute.sh '{"action":"start","teamId":"team-123","templateId":"marketing-team"}'
```

### Submit an answer (step-by-step)
```bash
bash execute.sh '{"action":"answer","sessionId":"session-uuid","value":"Sunrise Bakery"}'
```

### Submit all answers at once (batch mode)
```bash
bash execute.sh '{"action":"batch","teamId":"team-123","templateId":"marketing-team","answers":{"business_name":"Sunrise Bakery","industry":"Food","description":"Artisan bakery","target_customer":"Health-conscious millennials","competitors":"Blue Apron, HelloFresh","personality":"Warm, Authentic, Passionate","tone":"casual","goals":"Brand awareness, Community building","platforms":"Instagram, X (Twitter)","content_examples":"https://example.com"}}'
```

### Complete onboarding (generate guide)
```bash
bash execute.sh '{"action":"complete","sessionId":"session-uuid","outputDir":"/path/to/knowledge/docs"}'
```

### Get current question
```bash
bash execute.sh '{"action":"question","sessionId":"session-uuid"}'
```

## Questions (10 total)

1. Business name
2. Industry
3. One-sentence business description
4. Target customer profile
5. Top 3 competitors
6. Brand personality (3 words)
7. Content tone (Formal/Casual/Playful/Authoritative)
8. Marketing goals
9. Social platforms
10. Content examples

## Output

Generates `brand-voice-guide.md` in the specified output directory with:
- Business Profile section
- Brand Voice (personality, tone, do's, don'ts)
- Content Strategy (goals, platforms, content mix ratios)
- Platform-specific Guidelines
- Writing Rules
