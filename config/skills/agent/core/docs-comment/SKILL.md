---
name: Docs Comment
description: Handle feedback left as comments in a Google Doc — list comments and replies, reply, resolve, or add a comment (via the Google Workspace grant held by Crewly Cloud). Writes as the owner's Google account — say what you posted.
version: 1.0.0
category: productivity
skillType: claude-skill
assignableRoles:
  - orchestrator
  - team-leader
  - developer
  - operations
  - ops
  - sales
  - support
  - generalist
triggers:
  - comments in the doc
  - google doc comments
  - reply to the comment
  - resolve the comment
  - feedback in the doc
  - add a comment to the doc
tags:
  - google
  - docs
  - comments
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 60000
---

# Docs Comment

```bash
bash execute.sh list    --doc "https://docs.google.com/document/d/1AbC…/edit"
bash execute.sh list    --doc 1AbC… --include-resolved
bash execute.sh reply   --doc 1AbC… --comment AAAB… --text "Updated the intro, see paragraph 2."
bash execute.sh resolve --doc 1AbC… --comment AAAB… --text "Done in v2."
bash execute.sh resolve --doc 1AbC… --comment AAAB…
bash execute.sh add     --doc 1AbC… --text "Is this number from Q2?" --quote "grew 40%"
```

`--doc` takes a document id or its docs.google.com URL. `--account` picks a
connected Google account (see below).

## Working through feedback

1. `list` the open comments. Each one has the text it is about (`quote`),
   who wrote it and when, and any replies.
2. Make the change the comment asks for (for example with `docs-write`), or
   decide it needs the owner.
3. `resolve` the comment with a one-line note of what changed, or `reply`
   with a question if it is unclear. Do not resolve a comment you did not
   address.

Everything you post appears under the owner's Google name. Tell the owner
what you replied to or resolved.

## Output

`list`:

```json
{"success":true,"docId":"1AbC…","count":1,"truncated":false,"comments":[{"id":"AAAB…","author":"Steve","createdTime":"2026-10-03T09:12:00.000Z","content":"Too long","quote":"In this document we…","anchor":"kix.x1","resolved":false,"replies":[{"id":"AAAC…","author":"Ella","createdTime":"…","content":"Trimmed."}]}]}
```

Resolved comments are left out unless you pass `--include-resolved`.
`truncated: true` means the document has more than 500 comments and only the
first 500 were read.

`reply` / `resolve`:

```json
{"success":true,"action":"reply","docId":"1AbC…","commentId":"AAAB…","replyId":"AAAD…","content":"Updated the intro."}
```

`add`:

```json
{"success":true,"action":"add","docId":"1AbC…","commentId":"AAAE…","content":"Is this number from Q2?","quote":"grew 40%"}
```

## Comments you add are not anchored

Google Docs does not show a comment created through the API as attached to
text. `--quote` is sent to Google as the quoted text, but in the Docs UI the
comment **may appear as a general (unanchored) comment** on the whole
document. When the location matters, quote the passage in the comment text
too, for example `--text "On 'grew 40%': is this Q2?"`.

## Failures

`{"success":false,"reason":"reauth_required",…}` (exit 1): the Google grant
can read comments but not write them on this document. Reply, resolve and add
on a document Crewly did not create need Google Drive edit access, which
older connections do not include. Run `google-connect --product drive --channel <chat-channel-id>` to
post a one-tap card for the owner, and tell them in one line what you will do
once it is granted. Do not paste a link yourself.

`{"success":false,"reason":"not_connected","hint":"…"}` (exit 1): Google
Drive is not connected. Use `google-connect --product drive` the same way.

`{"success":false,"reason":"not_permitted",…}` (exit 1): this Google
connection belongs to someone else and is not shared with the person you are
working for. Say so; do not try another account.

`reason: "google_error"` with a 404 means the document id or comment id is
wrong, or the account cannot see the document.

## Choosing a Google account

Several Google accounts can be connected at once. Without `--account` the call uses the default one (the first you connected, or whichever you marked default on the Connections page). Name one explicitly when it matters:

```bash
bash execute.sh list --doc 1AbC… --account work@company.com
```

The account must be connected *for this product* — Google consent is per product (Gmail / Calendar / Drive), so an account connected only for Calendar cannot read Drive.
