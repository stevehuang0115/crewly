---
name: Gmail
description: "List, read, search, and send Gmail messages for a Google account. Requires a google-oauth credential bound to the 'gmail' slot."
version: 1.0.0
category: communication
skillType: claude-skill
assignableRoles:
  - orchestrator
  - assistant
triggers:
  - send email
  - reply to email
  - search gmail
  - list emails
  - read email
  - check inbox
  - find email
tags:
  - gmail
  - email
  - oauth
  - google
  - send
  - search
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
      - https://www.googleapis.com/auth/gmail.send
    description: "Google account for Gmail operations (list, read, search, send)."
notices:
  - type: requirement
    message: "Requires a Google account added in Settings → Credentials with both gmail.readonly and gmail.send scopes."
---

# Gmail (multi-action)

Multi-action Gmail skill that lets agents `list`, `read`, `search`, and `send`
messages on behalf of a connected Google account. The account is selected at
execution time via the `gmail` credential slot, so the same skill can be reused
across multiple Google accounts.

> Note: a separate `gmail-reader` skill (read-only, plain-text output) is kept
> for the orchestrator's `credential-manager read-gmail` action. This skill is
> the structured-JSON, full-feature version intended for direct agent use.

## Usage

Run via `crewly_execute_skill` with `credentialBindings.gmail` set to the
credential UUID of the Google account to use. Pass a JSON object on argv[1]
specifying the action and its parameters.

```bash
# Direct invocation (env vars must be set by the executor)
bash execute.sh '{"action":"list","q":"is:unread in:inbox","maxResults":10}'
bash execute.sh '{"action":"read","id":"18fa7b..."}'
bash execute.sh '{"action":"search","q":"from:foo@bar.com","maxResults":5}'
bash execute.sh '{"action":"send","to":"a@b.com","subject":"Hello","body":"Hi there."}'
```

## Actions

### `list` / `search`

List messages matching a Gmail search query. `search` is an alias for `list`.

**Input:**
```json
{"action":"list", "q":"is:unread in:inbox", "maxResults":10}
```
- `q` (optional) — Gmail search query. Defaults to `is:unread in:inbox`.
- `maxResults` (optional) — Number of messages to return. Clamped 1..50, default 10.

**Output:**
```json
{
  "success": true,
  "account": "info@steam-fun.com",
  "query": "is:unread in:inbox",
  "count": 3,
  "messages": [
    {"id":"18f...", "threadId":"18e...", "subject":"...", "from":"...", "date":"...", "snippet":"..."}
  ]
}
```

### `read`

Fetch a single message by ID and return decoded headers + body.

**Input:**
```json
{"action":"read", "id":"18fa7b..."}
```
- `id` (required) — Gmail message id (from a `list` result).

**Output:**
```json
{
  "success": true,
  "id": "18fa7b...",
  "threadId": "...",
  "headers": {"from":"...", "to":"...", "cc":"...", "subject":"...", "date":"..."},
  "body": "decoded plain text body",
  "bodyHtml": "<...> (only if no text/plain part exists)",
  "snippet": "..."
}
```

### `send`

Send a new email via the bound Google account.

**Input:**
```json
{"action":"send", "to":"a@b.com", "subject":"Hello", "body":"Plain text.", "cc":"x@y.com", "bcc":"z@y.com"}
```
- `to` (required) — Recipient address. Comma-separated list allowed.
- `subject` (required) — Subject line.
- `body` (required) — Plain-text body.
- `cc`, `bcc` (optional) — CC / BCC recipients.

**Output:**
```json
{"success": true, "id": "18fa...", "threadId": "..."}
```

## Required Env (injected by the skill executor)

- `CREWLY_CRED_GMAIL_ACCESS_TOKEN` — valid OAuth access token with `gmail.readonly` and `gmail.send`
- `CREWLY_CRED_GMAIL_EMAIL` — account email (used as `From:` in `send`)

The Crewly skill executor refreshes the access token before spawning this
script. Token refresh failures and missing-scope errors are surfaced by the
executor before this script ever runs — this script does NOT touch refresh
tokens or scope checks.

## Errors

- **Exit 1** — input/usage error (missing token, missing required field, unknown action).
- **Exit 2** — Gmail API error (4xx/5xx).

Raw access tokens and refresh tokens are never printed to stdout/stderr.
