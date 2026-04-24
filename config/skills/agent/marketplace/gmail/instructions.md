# Gmail Suite (v1.0.0)

Multi-action Gmail skill that supports listing, reading, searching, and sending
emails on behalf of a connected Google account.

## Prerequisites

This skill requires a Google OAuth credential bound to the `gmail` slot with
both `https://www.googleapis.com/auth/gmail.readonly` and
`https://www.googleapis.com/auth/gmail.send` scopes.

## Usage

```bash
bash config/skills/agent/marketplace/gmail/execute.sh '{"action":"<one of: list|read|search|send>", ...}'
```

## Action reference

| Action | Required params | Description |
|--------|-----------------|-------------|
| `list` | — | List messages matching `q`. Defaults to `is:unread in:inbox`, `maxResults=10`. |
| `search` | — | Alias for `list` (shares code). |
| `read` | `id` | Fetch full message by ID with decoded headers + body. |
| `send` | `to`, `subject`, `body` | Send a new email. Optional `cc`, `bcc`. |

## Examples

```bash
# List unread inbox messages
bash execute.sh '{"action":"list","maxResults":5}'

# Search by sender + subject
bash execute.sh '{"action":"search","q":"from:steve subject:report"}'

# Read a specific message
bash execute.sh '{"action":"read","id":"18f1a2b3c4d5e6f7"}'

# Send a message
bash execute.sh '{"action":"send","to":"user@example.com","subject":"Hello from Crewly","body":"This is a test email."}'
```

## Output

JSON object with `success: true` on success. See `SKILL.md` Actions section for
per-action schemas.

On error, JSON `{"success":false,"error":"..."}` on stdout, human-readable
message on stderr, and a non-zero exit code (1 = input/usage error, 2 = Gmail
API error).

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| `CREWLY_CRED_GMAIL_ACCESS_TOKEN is not set` | No credential bound | Bind a google-oauth credential to the `gmail` slot |
| `Gmail API returned status 401` | Token expired or scope insufficient | Re-authorize |
| `Missing required parameter: id` | Required param missing | Provide all required parameters |
| `Unknown action '<x>'` | Action not in the valid set | Use one of `list`, `read`, `search`, `send` |
