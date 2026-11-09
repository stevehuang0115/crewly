# Chat message search: one search over every conversation

Status: shipped for OSS `/team-chat` (issue #1400, item 6). The Cloud portal and the phone follow through a relay RPC
(not yet added).

## Goal

A person managing dozens of agents through chat cannot remember which conversation a decision or a number was in.
`GET /api/chat/search` existed for the `search-chat` agent skill but no screen used it. The owner now searches message
text across every conversation from the chat's Find box, and lands in the right conversation at the matching messages.

## API

`GET /api/chat/search?q=<words>&channel=&from=&to=&limit=&session=` (chat-v2, `requireAuth`).

- Every whitespace-separated word must appear (case-insensitive substring; at most `CHAT_SEARCH_CONSTANTS.MAX_TERMS`).
- `channel` is a channel id or name (with or without `#`); `from` / `to` take a date (`2026-10-09`, a bare `to` date
  means the whole day) or a timestamp; `limit` is capped at `CHAT_SEARCH_CONSTANTS.MAX_LIMIT` (30).
- **Whose view**: an agent (badge) searches as itself and cannot widen the view with `session`. The owner names an
  agent with `session`, or **leaves it out to search every conversation on this machine** — the owner sees all
  channels anyway, so no membership scope applies (`MessageStore.searchAll`). An agent caller without a session is
  still refused (400).
- System rows are never returned. Hits are newest first:
  `{ id, time, channelId, channel, channelType, sender, senderType, text, threadId }`, `text` flattened and redacted,
  at most `SNIPPET_CHARS` characters.

## `@crewly/chat-ui`

`ChatApiClient.searchMessages?(query, opts?: ChatSearchOptions): Promise<ChatSearchHit[]>` — optional like the other
#1400 methods so older transports still satisfy the contract; the page checks before offering the search.
`HttpChatApiClient` calls the endpoint; `MockChatApiClient` searches its seeded messages.

## `/team-chat`

- The list's Find box (person or channel) gains a last row, **Search messages for “…”**, when the client can search.
- It opens `ChatSearchResults` in the conversation column: an editable query (Enter re-searches), a status line
  (`N messages match.`, `No messages match.`, the cap notice, or the server's error) and one row per hit — the
  conversation as the list names it (`#name` for channels and group chats; a `slack-*` hit says Orchestrator), the
  sender, the time, and the snippet with the words marked.
- Opening a hit opens that conversation (a Slack-bridged channel opens the Orchestrator conversation that merges it)
  with the in-conversation search preset to the same words, so the matching messages are what is shown; closing that
  search shows the whole conversation. Picking any conversation from the list drops the filter.
- Phones: the search takes the conversation pane; Back returns to the list.

## Work-item posts (CREW-877)

`reply --work-item` / `--new-thread` / `--ticket` post straight to Slack (`SlackAgentPostService`, chat mirror off), so
they used to have no chat row and could not be found; a lead read the empty result as "the reply failed" and posted the
answer again. `defaultWorkDestinationDeps().post` now files a row with `ChatV2Service.recordSlackOnlyAgentPost`:

- **Where:** the chat channel the Slack channel maps to (team room or agent DM); any other Slack channel is not recorded
  (the helper returns why). A threaded post goes under the thread root that has a row; with no root row it carries
  `slackThreadKey` only (never `slackThreadTs`, which would make it look like the root). A top-level post is its own root.
- **Who:** `sender_id` / `agent_session` = the posting agent, `direction` `out`, never the orchestrator, never an owner row.
- **Quiet:** the insert emits no `chat_message`. Everything that reacts to a row hangs off that event (dispatch to
  agents, the Slack mirrors that would post it again, the live gateway, owner-turn and delivery trackers), and the post
  is already in Slack.
- **No double rows:** a row is skipped when any row already carries that Slack `slackChannelId` + `slackTs`; the client id
  `slack-only:<channel>:<ts>` makes a retry a no-op.
- **Cloud:** synced like any agent row (`cloud_sync` 1, outbox trigger), so the owner's phone and Cloud history match Slack.
- **Failure:** best-effort; a failed record is logged and never fails the post.

## Not here

- Relay RPC + portal / phone UI (same `ChatSearchResults` once `relay-chat-client` gains `searchMessages`).
- Jumping to the exact message when it is older than the loaded page (the preset filter says "Load older messages to
  search further back").
- Date / channel filters in the UI (the endpoint has them).

## Tests

- `message.store.test.ts` — `searchAll` reaches every room, keeps the word / channel / limit filters, skips system rows.
- `chat-v2.service.test.ts`, `chat-v2.controller.test.ts` — owner without `session` searches everything; agent without
  a session is refused.
- `packages/chat-ui` — `client.test.ts` (wire), `mock-client.test.ts`.
- `frontend` — `ChatSearchResults.test.tsx`, `ChatConversationList.test.tsx` (Find row), `LiveTeamChatPage.test.tsx`
  (end to end: Find → results → open hit filtered → list pick drops the filter).
