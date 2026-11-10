# Shared channels — the send side (crewly#1543 slice 5)

Status: implemented (branch `feat/1543-shared-send`; per-link norms, slice 6,
branch `feat/1543-shared-norms`). The receive side is
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
- After the trial only `internal` messages are held, and only for the hold
  reasons the link's norm does not allow (see Norms).
- A held message is a `shared_send` owner card (`askPrebuilt`, held-action
  kind: no snooze or skip), English like `private_share`: question
  `Send Orc's message to <company>? "<excerpt>"`, Send / Don't send, default
  Don't send, deadline 24 h. The same link + text with an open card reuses it.
- No decision service → `cannot_hold` (nothing is sent).
- Settled: Send posts with the client id fixed at hold time (a retry is a Cloud
  duplicate, not a second message) and counts toward the trial; Don't send,
  no answer or skip tell the orchestrator it was not sent; a cancelled card
  says nothing.

## Norms (slice 6)

Owner's model: simple information goes freely; internal information needs his
approval unless a norm he set up in advance for that link allows it.

Store: `~/.crewly/shared-channel-norms.json`, `linkId` →
`{ norm, allow[], updatedAt }` (`SharedChannelNormsStore`, mode 0600). A
corrupt file reads as no norms (stricter, never looser).

- `norm`: the owner's free text, "what this partner may be told" (at most
  2000 characters).
- `allow`: kinds of content that go without a card once the trial is over.

| Allowance | Classifier codes it covers |
|---|---|
| `money` | `money` |
| `file_names` | `file_path` |
| `contact_details` | `email`, `phone` (the label says "our staff's"; the classifier cannot tell whose, so the norm text should say) |
| `internal_links` | `internal_url` |
| `internal_refs` | `internal_ref` |
| `wiki_notes` | `wiki_memory` |
| `code_blocks` | `code_block` |
| `long_messages` | `long_text` |

Never allowed by any norm (`NEVER_ALLOWED_CODES`): the refusals `secret`,
`children_data`, `private_person_data`, and the holds that guard private data
`children_mention`, `id_number`, `owner_connector`, `confidential`. A PUT that
names one of them is a 400.

Classifier integration (`SharedChannelSendService.sendFromAgent`): the
verdict's findings are split by the link's allowances. Refusals still refuse.
After the trial, a message whose every finding is allowed is sent; the
`shared_channel.message.sent` entry carries `allowedByNorm: [codes]`, and the
agent's note names what the norm allowed. During the trial it is held as
`trialOnly` whatever the norm says. A held card lists only the reasons the
norm does not cover, plus a line naming what the norm already allows.

"Send, always allow": when every remaining hold reason can be allowed, the
card has a third option (`send_allow`, between Send and Don't send). It sends
like Send, counts toward the trial, adds those allowances to the link
(`SharedSendSubject.allowOnSend`) and logs `shared_channel.norm.updated` with
the card's actor. `yesKey` stays Send, so a typed "yes" never widens the norm.

The orchestrator sees the norm:
- in the `[EXTERNAL]` header of each woken message ("Share only what the owner
  allows. The owner's norm for X: "..." It may be sent without his approval:
  money. ..."; with no norm: "share only simple information");
- in `post-shared-channel --list` (`norm`, `allow` per link).

Owner edits: `GET/PUT /api/shared-channels/:linkId/norms` (owner only; agents
403, no credential 401). PUT takes `{ norm?, allow? }`; fields left out are
kept. The answer carries the allowance catalogue for the editor. Team Chat
shows a one-line summary with "Edit norm" above an active external channel's
composer (`SharedChannelNormsPanel`).

## Activity

`shared_channel.message.sent|held|refused|declined` and
`shared_channel.norm.updated` (before / after of `norm` and `allow`; from the
REST route or a card), target `shared_channel:<linkId>`.

## Framing

The `[EXTERNAL]` header the orchestrator receives names the command to answer:
`post-shared-channel --link L --reply-to M --message "..."`, and says that new
links and possibly internal messages wait for the owner while secrets and
children's data are refused.
