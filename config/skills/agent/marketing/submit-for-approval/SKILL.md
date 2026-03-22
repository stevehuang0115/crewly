---
name: submit-for-approval
description: Submit marketing content (posts, articles) for human approval via Slack. Used by Writer and Strategist agents in the Marketing Team template.
version: 1.0.0
category: marketing
assignableRoles:
  - writer
  - strategist
  - content-writer
  - content-strategist
triggers:
  - before_publish
  - manual
tags:
  - marketing
  - approval
  - slack
  - content
execution:
  type: script
  script: execute.sh
  interpreter: bash
  timeout: 30000
---

# Submit for Approval

Submits marketing content for human review and approval via Slack.

## Usage

```bash
bash execute.sh '{"action":"submit","platform":"Instagram","contentType":"post","content":"Your post text here...","hashtags":["#tag1","#tag2"],"visualDirection":"Photo of product","scheduledTime":"2026-03-25T09:00:00Z"}'
```

## Actions

### submit
Submit content for approval. Sends a formatted message to the configured Slack channel.

**Parameters:**
- `platform` (required): Target platform (Instagram, X, LinkedIn, Facebook)
- `contentType` (required): Content type (post, article, newsletter, thread)
- `content` (required): The actual content text
- `hashtags` (optional): Array of hashtags
- `visualDirection` (optional): Visual/image brief
- `scheduledTime` (optional): When to publish

### status
Check the status of a pending approval.

**Parameters:**
- `approvalId` (required): The approval request ID

### list
List all pending approvals for the current team.

## Response Format

```json
{
  "success": true,
  "approvalId": "abc-123",
  "status": "pending",
  "message": "Content submitted for approval. The business owner will review via Slack."
}
```

## Integration

This skill integrates with the ContentApprovalService in the Crewly backend.
The approval message is sent to Slack where the business owner can reply
with "approve" or "reject [reason]" to resolve the request.
