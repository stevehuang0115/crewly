---
name: Gmail
description: "Multi-action Gmail skill for agents — list/read/search/send messages, manage labels (add/remove/list), and toggle read/unread. Requires a google-oauth credential bound to the 'gmail' slot with gmail.modify scope."
version: 1.1.0
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
  - mark email as read
  - mark email as unread
  - add label to email
  - remove label from email
  - list gmail labels
tags:
  - gmail
  - email
  - oauth
  - google
  - send
  - search
  - labels
  - modify
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
      - https://www.googleapis.com/auth/gmail.modify
    description: "Google account for Gmail operations. gmail.modify is a functional superset that covers read, send, label management, and read/unread toggling — one scope unlocks all 9 actions."
notices:
  - type: requirement
    message: "Requires a Google account added in Settings → Credentials with the gmail.modify scope (the default Crewly OAuth flow grants it automatically)."
---

# Gmail (multi-action, v1.1.0)

Multi-action Gmail skill that lets agents manage messages and labels on behalf
of a connected Google account. The account is selected at execution time via
the `gmail` credential slot, so the same skill can be reused across multiple
Google accounts (e.g., work vs personal).

> Note: a separate `gmail-reader` skill (read-only, plain-text output) is kept
> for the orchestrator's `credential-manager read-gmail` action. This skill is
> the structured-JSON, full-feature version intended for direct agent use.

## Why a single `gmail.modify` scope?

`gmail.modify` is a Google-side functional superset that covers `gmail.readonly`,
`gmail.send`, and label/state mutations. The Crewly skill executor performs
**string-exact** scope matching (no superset awareness), so declaring the
single most-capable scope keeps the requirement check simple and lets all 9
actions share one OAuth grant.

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
bash execute.sh '{"action":"list-labels"}'
bash execute.sh '{"action":"add-label","id":"18fa...","labelId":"Label_5"}'
bash execute.sh '{"action":"remove-label","id":"18fa...","labelId":"Label_5"}'
bash execute.sh '{"action":"mark-as-read","id":"18fa..."}'
bash execute.sh '{"action":"mark-as-unread","id":"18fa..."}'
```

## Actions

### Email operations

#### `list` / `search`

List messages matching a Gmail search query. `search` is an alias for
`list` (shares code).

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

#### `read`

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
  "labelIds": ["INBOX","UNREAD"],
  "headers": {"from":"...", "to":"...", "cc":"...", "subject":"...", "date":"..."},
  "body": "decoded plain text body",
  "bodyHtml": "<...> (only if no text/plain part exists)",
  "snippet": "..."
}
```

The body extraction walks `payload.parts[]` recursively and prefers
`text/plain`. If only `text/html` is available, the HTML is returned as
`bodyHtml` and a tag-stripped plaintext fallback is placed in `body`.

#### `send`

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

### Label management

#### `list-labels`

List all labels on the account (system + user-defined). Call this before
`add-label` to discover valid label IDs.

**Input:**
```json
{"action":"list-labels"}
```

**Output:**
```json
{
  "success": true,
  "account": "info@steam-fun.com",
  "count": 12,
  "labels": [
    {"id":"INBOX", "name":"INBOX", "type":"system"},
    {"id":"UNREAD", "name":"UNREAD", "type":"system"},
    {"id":"Label_5", "name":"Work", "type":"user"}
  ]
}
```

#### `add-label` / `remove-label`

Add or remove one or more labels on a message.

**Input:**
```json
{"action":"add-label", "id":"18fa7b...", "labelId":"Label_5"}
{"action":"remove-label", "id":"18fa7b...", "labelIds":["Label_5","Label_7"]}
```
- `id` (required) — Gmail message id.
- `labelId` (string) OR `labelIds` (array) (required, at least one) — Label IDs to add/remove. The script accepts either form.

**Output:**
```json
{"success": true, "id":"18fa7b...", "threadId":"...", "labelIds":["INBOX","Label_5","UNREAD"]}
```
The `labelIds` array reflects the post-modification state of the message.

### Status management

#### `mark-as-read` / `mark-as-unread`

Convenience wrappers that toggle the system `UNREAD` label.

**Input:**
```json
{"action":"mark-as-read", "id":"18fa7b..."}
{"action":"mark-as-unread", "id":"18fa7b..."}
```
- `id` (required) — Gmail message id.

**Output:** identical to `add-label` / `remove-label` (includes `labelIds` so the agent can confirm the transition).

## Required Env (injected by the skill executor)

- `CREWLY_CRED_GMAIL_ACCESS_TOKEN` — valid OAuth access token with `gmail.modify`
- `CREWLY_CRED_GMAIL_EMAIL` — account email (used as `From:` in `send`)

The Crewly skill executor refreshes the access token before spawning this
script. Token refresh failures and missing-scope errors are surfaced by the
executor before this script ever runs — this script does NOT touch refresh
tokens or scope checks.

## Errors

- **Exit 1** — input/usage error (missing token, missing required field, unknown action). JSON `{"success":false,"error":"..."}` on stdout, human message on stderr.
- **Exit 2** — Gmail API error (4xx/5xx). JSON `{"success":false,"error":"..."}` on stdout, status + Google's error message on stderr.

Raw access tokens and refresh tokens are never printed to stdout/stderr.

## How the credential is resolved

Crewly's skill executor reads the `credentials:` frontmatter above, looks up
the credential bound to the `gmail` slot (either from `credentialBindings`
passed to `crewly_execute_skill`, or this skill's default), refreshes the
access token if needed, and injects it as `CREWLY_CRED_GMAIL_ACCESS_TOKEN`
before spawning this script. Output is auto-redacted of any injected secrets
before being returned to the agent.

## Changelog

- **1.1.0** — added `add-label`, `remove-label`, `list-labels`, `mark-as-read`, `mark-as-unread`. Reduced `requiredScopes` to single `gmail.modify` (functional superset for all 9 actions).
- **1.0.0** — initial release with `list`, `read`, `search`, `send`.
