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

When a Google skill answers `not_connected`, the owner has not granted that
product yet. Do **not** improvise an authorization link: the one this
instance can build carries a Cloud session token, and posting it into a
channel publishes a credential. It also expires within the hour, so the link
you paste is usually dead by the time anyone clicks it.

Run this instead. It posts a card with an **Add** button that only the
person who asked can see, backed by a single-use link.

```bash
bash execute.sh --product gmail --channel <chat-channel-id>
```

`--channel` is the id in the `[CHAT:…]` header of the message you are
answering.

After running it, say in one line that you have asked for access and what
you will do once it is granted. Do not repeat the link — there is no link
to repeat.
