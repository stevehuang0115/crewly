---
name: Google Connect
description: "Ask the owner to authorize a Google product (gmail / calendar / drive) by posting a one-click card in Slack. Use this when a Google skill fails with not_connected — never paste an authorization link yourself."
version: 1.0.0
category: productivity
skillType: claude-skill
triggers:
  - google not connected
  - needs google authorization
  - ask owner to connect gmail
  - ask owner to connect calendar
  - ask owner to connect drive
tags:
  - google
  - slack
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# Google Connect

When a Google skill answers `not_connected` or `reauth_required`, the owner has
to grant (or re-grant) a product. Do **not** improvise an authorization link:
never build one by hand and never paste one. Run this instead. It posts a card
with a button that only the person who asked can see; the button opens the
Crewly portal's Google page, so the link carries no credential and **never
expires**. The owner can tap it hours later, from a phone.

```bash
bash execute.sh --product gmail [--channel <chat-channel-id>] [--account me@example.com]
```

- `--channel` is the id in the `[CHAT:…]` or `[SLACK-THREAD:…]` header of the
  message you are answering. It is optional: without it, or if it cannot be
  resolved, the card goes where you are working with the owner, else their DM.
- Every call posts a fresh card. If the owner says the last card did not work,
  run it again (`--resend` is accepted to make that intent explicit).
- Never tell the owner to open Crewly settings or the Connections page — they
  are usually on a phone and cannot reach it. If they cannot find the card, the
  manual fallback is https://crewlyai.com/portal/integrations/google

After running it, say in one line that you have asked for access and what you
will do once it is granted. Do not repeat a link.
