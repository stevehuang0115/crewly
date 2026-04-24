# Gmail Suite (v1.1.0)

Comprehensive Gmail management skill. Supports listing, reading, searching, and
sending emails plus label management and read/unread toggling — 9 actions in
total.

## Prerequisites

This skill requires a Google OAuth credential bound to the `gmail` slot with
the `https://www.googleapis.com/auth/gmail.modify` scope. `gmail.modify` is a
functional superset that covers read, send, and modify operations — one scope
unlocks all 9 actions.

## Usage

```bash
bash config/skills/agent/marketplace/gmail/execute.sh '{"action":"<one of: list|read|search|send|list-labels|add-label|remove-label|mark-as-read|mark-as-unread>", ...}'
```

## Action reference

| Action | Required params | Description |
|--------|-----------------|-------------|
| `list` | — | List messages matching `q`. Defaults to `is:unread in:inbox`, `maxResults=10`. |
| `search` | — | Alias for `list` (shares code). |
| `read` | `id` | Fetch full message by ID with decoded headers + body. |
| `send` | `to`, `subject`, `body` | Send a new email. Optional `cc`, `bcc`. |
| `list-labels` | — | List all labels on the account (system + user). |
| `add-label` | `id`, `labelId` or `labelIds` | Add labels to a message. |
| `remove-label` | `id`, `labelId` or `labelIds` | Remove labels from a message. |
| `mark-as-read` | `id` | Remove the system `UNREAD` label from a message. |
| `mark-as-unread` | `id` | Add the system `UNREAD` label to a message. |

## Examples

### Email operations

```bash
# 1. List unread inbox messages
bash execute.sh '{"action":"list","maxResults":5}'

# 2. Search by sender + subject
bash execute.sh '{"action":"search","q":"from:steve subject:report"}'

# 3. Read a specific message
bash execute.sh '{"action":"read","id":"18f1a2b3c4d5e6f7"}'

# 4. Send a message
bash execute.sh '{"action":"send","to":"user@example.com","subject":"Hello from Crewly","body":"This is a test email."}'

# 4a. Send with CC + BCC
bash execute.sh '{"action":"send","to":"a@b.com","subject":"Hi","body":"Hello","cc":"c@b.com","bcc":"d@b.com"}'
```

### Label management

```bash
# 5. List all labels (call this first to discover label IDs)
bash execute.sh '{"action":"list-labels"}'

# 6. Add a label to a message (string form)
bash execute.sh '{"action":"add-label","id":"18f1...","labelId":"Label_5"}'

# 6a. Add multiple labels (array form)
bash execute.sh '{"action":"add-label","id":"18f1...","labelIds":["Label_5","Label_7"]}'

# 7. Remove a label
bash execute.sh '{"action":"remove-label","id":"18f1...","labelId":"Label_5"}'
```

### Status management

```bash
# 8. Mark a message as read (removes UNREAD)
bash execute.sh '{"action":"mark-as-read","id":"18f1..."}'

# 9. Mark a message as unread (adds UNREAD)
bash execute.sh '{"action":"mark-as-unread","id":"18f1..."}'
```

## Output

JSON object with `success: true` on success. Specifics vary by action — see
`SKILL.md` Actions section for per-action schemas.

On error, JSON `{"success":false,"error":"..."}` on stdout, human-readable
message on stderr, and a non-zero exit code (1 = input/usage error, 2 = Gmail
API error).

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| `CREWLY_CRED_GMAIL_ACCESS_TOKEN is not set` | No credential bound | Bind a google-oauth credential to the `gmail` slot |
| `Gmail API returned status 401` | Token expired or scope insufficient | Re-authorize; ensure the credential has `gmail.modify` |
| `Missing required parameter: id` | Required param missing | Provide all required parameters for the chosen action |
| `Missing required parameter: labelId or labelIds` | Neither given for add/remove-label | Pass `labelId` (string) or `labelIds` (array) |
| `Unknown action '<x>'` | Action not in the valid set | Use one of the 9 valid action names (see table above) |
