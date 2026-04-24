---
name: Credential Manager
description: "Manage workspace credentials (Google OAuth accounts, service API keys) that skills use to call third-party services on the user's behalf. Primary flow for remote users over Slack: start-google-oauth returns a link the user clicks on their device; they sign in and paste the resulting JSON back, then complete-google-oauth saves the credential. Supports multi-account."
version: 1.1.0
category: management
skillType: claude-skill
assignableRoles:
  - orchestrator
triggers:
  - add gmail account
  - add google account
  - add api key
  - list credentials
  - show credentials
  - what credentials
  - delete credential
  - revoke credential
  - connect google
  - connect gmail
  - read gmail
  - check unread emails
  - unread messages
  - my inbox
tags:
  - credentials
  - oauth
  - gmail
  - google
  - api-key
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Credential Manager

Manages the workspace's credential store used by skills. Supports Google OAuth
(multi-account) and API keys.

**Credential values are never returned** — only metadata (id, name, email,
scopes). The actual tokens stay encrypted on disk and are only exposed to
skills at execution time via per-slot env vars.

## Primary flow: Remote user via Slack

The user is on Slack and cannot run terminal commands. Use this flow:

### 1. Start — return a sign-in link

```bash
bash execute.sh '{"action":"start-google-oauth"}'
```

Returns:
```json
{
  "success": true,
  "authUrl": "https://accounts.google.com/o/oauth2/v2/auth?client_id=...&scope=...",
  "instructions": "Send authUrl to the user. They click it..."
}
```

**Send the `authUrl` to the user**. Tell them:
> Please click this link, sign in with the Google account you want to add,
> then copy the entire JSON block shown on the success page and paste it back here.

The URL opens on their device (phone, laptop, whatever). Google shows the
consent screen ("Google Workspace Extension for Gemini CLI wants to access...").
After they approve, they land on a page titled **"Success! Credentials Ready"**
with a JSON block like:

```json
{
  "refresh_token": "1//...",
  "scope": "...",
  "token_type": "Bearer",
  "access_token": "ya29...",
  "expiry_date": 1234567890123
}
```

### 2. Complete — save the credential

After the user pastes the JSON back, call:

```bash
bash execute.sh '{
  "action":"complete-google-oauth",
  "name":"info-steam-fun",
  "credentialsJson": {"refresh_token":"...","access_token":"...","scope":"...","token_type":"Bearer","expiry_date":...}
}'
```

Returns:
```json
{
  "success": true,
  "credential": {
    "id": "cred-abc123...",
    "name": "info-steam-fun",
    "type": "google-oauth",
    "provider": "google",
    "helper": "gemini-cli-workspace",
    "accountEmail": "info@steam-fun.com",
    "scopes": [...]
  }
}
```

### 3. Repeat for more accounts

Just call `start-google-oauth` → send new URL → `complete-google-oauth` again
with a different name. No extension state to clear (headless mode never
touches it).

---

## Developer flow (on-box only)

If you're running on the same machine as Crewly AND have the Gemini CLI
Workspace extension set up for interactive login, these still work:

### `import-google`

Import the extension's currently-active login:

```bash
bash execute.sh '{"action":"import-google","name":"info-steam-fun"}'
```

Precondition: user has run `GEMINI_CLI_WORKSPACE_FORCE_FILE_STORAGE=true gemini`
and completed sign-in, leaving tokens in the extension's file cache.

### `clear-gemini-cli`

Delete the extension's cached token file so the next local login captures
a fresh account:

```bash
bash execute.sh '{"action":"clear-gemini-cli"}'
```

---

## Other actions

### `list`

List credentials (filter optional).

```bash
bash execute.sh '{"action":"list"}'
bash execute.sh '{"action":"list","type":"google-oauth"}'
bash execute.sh '{"action":"list","provider":"gemini"}'
```

### `add-api-key`

```bash
bash execute.sh '{"action":"add-api-key","name":"gemini-main","provider":"gemini","value":"AIza..."}'
```

### `delete`

```bash
bash execute.sh '{"action":"delete","id":"cred-abc123..."}'
```

### `read-gmail`

Read unread emails from the named Google account:

```bash
bash execute.sh '{"action":"read-gmail","name":"info-steam-fun"}'
bash execute.sh '{"action":"read-gmail","name":"personal-gmail","maxResults":5}'
```

---

## Multi-account example (remote Slack user)

```
User: "Add info@steam-fun.com to Crewly"
Orchestrator:
  1. bash execute.sh '{"action":"start-google-oauth"}'
  2. Gets authUrl back.
  3. Replies in Slack:
     "Click this to sign in with info@steam-fun.com: <authUrl>
      After signing in, copy the JSON block from the 'Success!' page
      and paste it back here."

User: (clicks on phone, signs in, pastes JSON)
  {"refresh_token":"...","access_token":"...","scope":"...","token_type":"Bearer","expiry_date":...}

Orchestrator:
  1. bash execute.sh '{"action":"complete-google-oauth","name":"info-steam-fun","credentialsJson":<pasted JSON>}'
  2. Replies: "✓ Added info-steam-fun (info@steam-fun.com)."

User: "Now add my personal gmail"
Orchestrator:
  repeats start → URL → user pastes → complete, with name=personal-gmail.

User: "What's unread in info's inbox?"
Orchestrator:
  bash execute.sh '{"action":"read-gmail","name":"info-steam-fun"}'
  → returns summary of unread emails.
```

## Errors

- `name is required` / `credentialsJson is required` — missing fields in complete action
- `credentialsJson is not valid JSON` — user pasted something other than the JSON block
- `credentialsJson is missing access_token or refresh_token` — user pasted a partial JSON
- `No google-oauth credential found with name '...'` — `read-gmail` lookup failed; try `list`
- `Credential '...' is revoked` — the refresh token was revoked by the user or Google; re-run the OAuth flow
