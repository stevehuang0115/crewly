# docs-comment: handle Google Doc comments (2026-10-04)

## Why

The owner leaves feedback as comments inside Google Docs. Agents can read and
write documents (`docs-read` / `docs-write`) but cannot see or answer those
comments, so the feedback goes unhandled unless the owner repeats it in chat.

## What

A new agent core skill `config/skills/agent/core/docs-comment/`:

| Command | Does |
|---|---|
| `list --doc <id\|url> [--include-resolved]` | Comments and their replies: id, author, time, quoted text, anchor, resolved state |
| `reply --doc <id\|url> --comment <id> --text "…"` | Adds a reply |
| `resolve --doc <id\|url> --comment <id> [--text "…"]` | Adds a reply with `action: "resolve"` (optional message) — marks the comment resolved |
| `add --doc <id\|url> --text "…" [--quote "exact text"]` | Adds a comment; `--quote` becomes `quotedFileContent` |

Same shape as its siblings: `SKILL.md` (frontmatter is the manifest),
`execute.sh` (bash → `api_call` → JSON), `execute.test.sh` (Python HTTP stub).
`--account` picks a connected Google account, as in every Google skill.

### Backend (`/api/google`, behind `requireConnectorAccess('google-workspace')`)

| Route | Google call (Drive API v3, `fields=*`) |
|---|---|
| `GET  /docs/:id/comments?includeResolved=1` | `GET files/{id}/comments` (paged, deleted dropped, resolved dropped unless asked) |
| `POST /docs/:id/comments` `{ text, quote? }` | `POST files/{id}/comments` `{ content, quotedFileContent? }` |
| `POST /docs/:id/comments/:commentId/replies` `{ text }` | `POST files/{id}/comments/{cid}/replies` `{ content }` |
| `POST /docs/:id/comments/:commentId/resolve` `{ text? }` | `POST files/{id}/comments/{cid}/replies` `{ action: "resolve", content? }` |

New `DocsCommentsService` (`services/google/docs-comments.service.ts`), bound to
the `drive` product like Docs/Sheets/Slides. It goes through `googleRequest`,
so the token comes from the same per-person Cloud token path as `docs-read` /
`docs-write` (issue #968: the acting-for header, per-person token cache, and
Cloud's `not_permitted` refusal all apply unchanged).

Comments are written by the Google account that holds the grant, so they show
under the owner's name. `SKILL.md` tells the agent to say what it posted.

### Anchoring limitation

Google Docs does not show a comment created through the Drive API as anchored
to text, even with `quotedFileContent` (the anchor format Docs uses is not
public). `add --quote` sends the quote so it shows in the comment's metadata,
but in the Docs UI it may appear as a general, unanchored comment. `SKILL.md`
says this plainly and suggests quoting the passage in the comment text.

## Scopes

The `drive` product's grant today: `drive.readonly`, `drive.file`,
`documents.readonly` (crewly-services `auth/src/google-products.ts`).

| Call | Scopes Google accepts | Covered today? |
|---|---|---|
| `comments.list` | `drive`, `drive.file`, `drive.readonly`, … | Yes, any doc the owner can see |
| `comments.create`, `replies.create` (reply / resolve / add) | `drive`, `drive.file` | Only on files Crewly created (`drive.file`) |

So `list` works with no change. Writing to a comment on a doc the owner made
outside Crewly — the normal case — needs `https://www.googleapis.com/auth/drive`.
It is the narrowest scope that covers it (`documents` does not cover Drive
comments). It is in Google's restricted tier, as `drive.readonly` already is,
so verification needs do not change tier.

### Cloud change (crewly-services, separate PR)

`drive` becomes an **optional** scope of the `drive` product: requested on
every Drive connect, but not required for the product to count as granted.
Existing grants therefore keep working for reads; only comment writes on
foreign docs need the wider grant. Because consent uses
`include_granted_scopes`, reconnecting Drive widens the existing credential.

The Cloud does not proxy Google API calls — OSS fetches a short-lived token
from `/api/cloud/google/workspace/token` and calls Google directly — so there
is no endpoint allowlist to extend.

### Re-auth when the grant is narrow

When a write fails with 403/404, the token's scopes lack `…/auth/drive`, and
the document itself is readable (`files.get`), the service answers
`reauth_required` (403) and drops the cached token. The skill prints:

```json
{"success":false,"reason":"reauth_required","message":"Replying to or adding comments on this document needs Google Drive edit access, which this Google account has not granted yet.","hint":"Ask the owner to reconnect Google Drive: run the google-connect skill with --product drive. It posts a one-tap card in Slack; nothing to do on this machine."}
```

One tap on the phone (owner-away rule): the Slack card's single-use link goes
to Google consent and back; no localhost, browser-on-this-machine, or terminal
step. The next call fetches a fresh token with the new scope.

## Owner actions

1. Add `https://www.googleapis.com/auth/drive` to the OAuth consent screen
   (Data Access) of the Google Cloud project **before** deploying the auth
   change — requesting an undeclared scope fails the whole consent.
2. Deploy crewly-services auth; release crewly.
3. Tap the Drive card once when an agent asks.

## Tests

- `docs-comments.service.test.ts`: list paging/filters/mapping, reply, resolve
  with and without text, add with and without quote, `reauth_required` mapping
  (and pass-through when the scope is present or the doc is missing).
- `google.controller.test.ts` / `google.routes.test.ts`: the four routes.
- `google-workspace-token.service.test.ts`: `grantedScopes`.
- `docs-comment/execute.test.sh`: request paths/bodies per command, output
  JSON, `reauth_required` pass-through, argument validation.
- crewly-services `google-products.test.ts`: optional scope requested,
  not required for product coverage.
