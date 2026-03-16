---
name: Customer Feedback Analyzer
description: Analyze customer feedback to extract sentiment, topics, priority, and actionable insights.
version: 1.0.0
category: analytics
skillType: claude-skill
assignableRoles:
  - product-manager
  - support
  - generalist
  - sales
triggers:
  - analyze feedback
  - customer feedback
  - feedback analysis
  - sentiment analysis
tags:
  - feedback
  - customer
  - sentiment
  - analytics
  - product-management
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 15000
---

# Customer Feedback Analyzer

Analyze customer feedback text (reviews, emails, survey responses) and categorize it by sentiment, topic, priority, and actionability. Outputs a structured analysis with suggested follow-up actions.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `feedback` | Yes | The feedback text to analyze |
| `source` | No | Where feedback came from: `email`, `review`, `survey`, `support-ticket`, `social` |
| `customerName` | No | Customer name for tracking |

## Example

```bash
bash config/skills/agent/feedback-analyzer/execute.sh '{"feedback":"The dashboard is great but it is really slow when loading team data. Would be nice to have a loading indicator.","source":"survey","customerName":"John"}'
```

## Output

JSON with sentiment analysis (positive/negative/mixed/neutral), detected topics, priority level, actionability flag, and suggested follow-up actions.
