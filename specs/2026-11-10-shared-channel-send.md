# Shared channels — the send side (crewly#1543 slice 5)

Status: implemented (branch `feat/1543-shared-send`). The receive side is
slice 4; the Cloud contract is `services/auth/src/shared-channels/*`
(`POST /api/cloud/shared-channels/:linkId/messages`, machine token, client
message id, 8000 characters, 30 messages per minute per link).

## Who sends

| Sender | Path | Checks |
|---|---|---|
| Owner | Team Chat composer → `POST /api/chat/channels/external-<link>/messages` | none: his own words go straight out |
| Orchestrator | `post-shared-channel` skill → `POST /api/shared-channels/:linkId/messages` | classifier + trial hold |
| Any other agent | — | refused (`not_allowed`, 403) |

`ChatV2Service.sendMessage` still refuses external channels (WS, relay and
portal posts included). The chat-v2 HTTP controller routes the owner's post
before it reaches the service (`prepareExternalPost`: owner only, link not
revoked, a thread reply maps to the Cloud id it answers).

Every sent message is filed locally with `recordExternalMessageRow`
(`direction: 'sent'`, `clientMessageId: external:<cloud id>`), so the next
history fetch dedupes it. The owner's rows are named `Owner`, the
orchestrator's `Orc`; both stay `agent` rows (never an owner turn).

## Classifier (`shared-channel-classifier.ts`)

Deterministic and conservative. Verdicts:

- **refused** (cannot be approved): a secret or token shape (the secret
  redactor, secret URL params, a 32+ character mixed token); children's data
  (a child word next to personal details, age, grade, health); another
  person's private data read this turn (#969 tracker, any person but the
  owner).
- **internal** (held): the owner's own connector data read this turn, file
  paths, emails, phone numbers, id numbers, money amounts, internal links
  (localhost, private IPs, `.local`/`.lan`/`.internal`, Crewly app hosts),
  ticket ids / session names / UUIDs, wiki or memory wording, "confidential",
  code blocks, text over 1500 characters, a child mentioned without details.
- **plain**: none of the above.

## Hold

- Trial: until the owner has approved 10 agent messages on a link
  (`~/.crewly/shared-channel-trial.json`), every agent message is held.
  Owner posts do not count.
- After the trial only `internal` messages are held.
- A held message is a `shared_send` owner card (`askPrebuilt`, held-action
  kind: no snooze or skip), English like `private_share`: question
  `Send Orc's message to <company>? "<excerpt>"`, Send / Don't send, default
  Don't send, deadline 24 h. The same link + text with an open card reuses it.
- No decision service → `cannot_hold` (nothing is sent).
- Settled: Send posts with the client id fixed at hold time (a retry is a Cloud
  duplicate, not a second message) and counts toward the trial; Don't send,
  no answer or skip tell the orchestrator it was not sent; a cancelled card
  says nothing.

## Activity

`shared_channel.message.sent|held|refused|declined`, target
`shared_channel:<linkId>`.

## Framing

The `[EXTERNAL]` header the orchestrator receives names the command to answer:
`post-shared-channel --link L --reply-to M --message "..."`, and says that new
links and possibly internal messages wait for the owner while secrets and
children's data are refused.
