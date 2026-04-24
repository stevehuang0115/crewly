---
name: Gmail Reader
description: "List unread emails from a Google account's inbox. Requires a google-oauth credential bound to the 'gmail' slot with gmail.readonly scope."
version: 1.0.0
category: communication
skillType: claude-skill
assignableRoles:
  - orchestrator
  - assistant
triggers:
  - read gmail
  - unread emails
  - check inbox
  - list emails
  - my unread messages
tags:
  - gmail
  - email
  - oauth
  - google
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
credentials:
  - slot: gmail
    type: google-oauth
    provider: google
    required: true
    requiredScopes:
      - https://www.googleapis.com/auth/gmail.readonly
    description: "Google account whose inbox will be read. Bind with credentialBindings.gmail."
notices:
  - type: requirement
    message: "Requires a Google account added in Settings → Credentials (via the Gemini CLI Workspace extension flow)."
---

# Gmail Reader

Reads unread emails from a Google account's inbox. The account is selected at
execution time via the `gmail` credential slot, so the same skill can be used
across multiple Google accounts (e.g., work vs personal).

## Usage

Run via `crewly_execute_skill` with `credentialBindings.gmail` set to the
credential UUID of the Google account to query. Optionally pass a max-results
value as the first positional argument (default 10, capped at 50).

```bash
# Direct invocation (env vars must be set by the executor)
bash execute.sh 10
```

## Inputs

- **Argument (optional):** max number of unread messages to return (1–50, default 10)

## Required Env (injected by the skill executor)

- `CREWLY_CRED_GMAIL_ACCESS_TOKEN` — valid OAuth access token with `gmail.readonly`
- `CREWLY_CRED_GMAIL_EMAIL` — account email (for display only)

## Output

Plain-text summary of unread messages, one per block:
```
From: Someone <a@b.com>
Subject: Hello
Date: Mon, 22 Apr 2026 10:00:00 -0700
Snippet: First 120 characters of the message body...
ID: <message-id>
```

If there are no unread messages, prints `No unread messages.` and exits 0.

## Errors

- `Exit 1 — CREWLY_CRED_GMAIL_ACCESS_TOKEN not set` — no credential bound to the `gmail` slot
- `Exit 2 — Gmail API error: <status>` — access token invalid or insufficient scope (should trigger re-authorization)

## How the credential is resolved

Crewly's skill executor reads the `credentials:` frontmatter above, looks up
the credential bound to the `gmail` slot (either from `credentialBindings` or
the skill's `default`), refreshes the access token if needed, and injects it
as `CREWLY_CRED_GMAIL_ACCESS_TOKEN` before spawning this script. Raw token
values never reach the agent/LLM context — output is auto-redacted of any
injected secrets before being returned.
