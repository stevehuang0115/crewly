# Per-person access (issue #968)

Status: shipped in 1.20.193 (inert until Crewly Cloud auth 1.10.x); fixes from
the post-merge review in this revision (section "Review fixes").

## Goal

A connector grant (Google, Canva, Microsoft) belongs to the person who
connected it. An agent working for someone else cannot use it unless it is
shared. Agents can be dedicated to one person.

## Pieces

- **People directory** (`people.json`, `services/people/people-directory.service.ts`):
  the humans who use this instance, keyed by Slack user id, with a role
  (`owner` / `member` / `guest`).
- **Acting-for** (`acting-for.json`, `services/people/acting-for.service.ts`):
  the person each agent session is working for right now. Set by the backend
  from what it delivered, never from anything an agent sends.
- **Credential requests** carry `X-Crewly-Acting-For` / `-Role`; Cloud decides.
- **Grant sharing**: `owner` (only the person who connected it), `people`
  (named people), `members` (every member, not guests). Owner edits it on the
  Connections page.
- **Dedicated agents** (`dedicatedTo`): anyone else gets a polite decline;
  messages from other agents are never declined.

## The owner's identity

The owner has one id everywhere: the literal `owner`.

- OSS always sends and stores `owner` for the instance owner (acting-for
  records, `X-Crewly-Acting-For`, `authorizedBy` of grants it connects, the
  owner row of the People list).
- Any Slack id known to be the owner maps to `owner`:
  1. the Slack installer (Cloud workspace config `installedBy`, which is also
     the Cloud account's Slack identity);
  2. `SLACK_OWNER_USER_ID` (comma-separated) for installs whose Slack
     credentials come from env and have no installer;
  3. a Slack id the owner marked as their own in Settings › People
     ("Owner (me)"), stored in `people.json` `ownerSlackUserIds`.
- `people.json` never keeps a member row for an owner Slack id; the owner row
  lists the known Slack ids (`slackUserIds`) for display.
- Cloud accepts both spellings: it adds the account's Slack installers to the
  request's person, so `owner` matches a grant authorized by the owner's
  Slack id, and a request for the owner's Slack id is the owner even when an
  older install called it a member.

## Who a turn acts for

| Turn | Acts for |
|---|---|
| Human Slack message (DM, channel, thread) | that human (owner's Slack id → `owner`) |
| Dashboard / terminal / owner's own channels | `owner` |
| Message an agent wrote (Slack post by an agent bot, chat-v2 row with `authorAgentSession` / `remoteAgentSession`, agent→agent deliver/write) | the authoring agent's person; unchanged when the author has no record here (e.g. an agent on another machine) |
| Scheduler check (`system_event` from the scheduler, direct scheduled delivery), scheduled messages, auditor runs, any other `system_event` without an authoring agent | `owner` (source `system`) |
| `system_event` that relays an agent's status (`sourceMetadata.authorAgentSession`) | the reporting agent's person |
| Work-item claim | the work item's `actingFor` |
| Mid-task nudges (context-window, runtime fallback, restart resume, spend-cap flush) | unchanged — they continue the current turn |

Bots are never people: `recordHumanMessage` ignores a known bot user id (the
master bot, any agent bot), `noteSeen` never adds one, and bot rows already
in `people.json` are removed when the file is loaded.

## Dedicated agents

`refuseDelivery` (chat-v2 dispatcher) and the Slack routers treat a message
as agent-authored when it carries `authorAgentSession` or
`remoteAgentSession`; those are never declined.

## Cloud rule (auth 1.10.x)

- Authorizer (either owner spelling counts as the owner) may use the grant.
- Otherwise `sharing`: `members` → owner and members; `people` → named;
  `owner` → nobody else.
- Grants from before per-person access (no ownership fields) keep today's
  behaviour: backfilled as `authorizedBy: 'owner'`, `sharing: members`
  (idempotent, count logged). New grants start owner-only.

## Older Cloud

Against auth 1.9.0 the status has no `authorizedBy`/`sharing` and `POST
…/sharing` is a 404 with no error code. The backend answers that 404 as
`501 cloud_update_required`; the Connections control shows "Requires a Cloud
update" and is disabled.

## Deploy order

1. Crewly release with the review fixes.
2. Auth 1.10.x.

## Review fixes (2026-10-02)

1. Bot actor recorded as a person — fixed per the tables above.
2. Backfill — legacy grants shared with all members.
3. Scheduled/system turns act for the owner.
4. Owner identity unified on `owner` (OSS + Cloud).
5. Dedicated agents no longer drop agent @-mentions.
6. "Usable by" against auth 1.9.0 shows "Requires a Cloud update".

## Audit log of connector use (#969, 2026-10-26)

The owner can answer "who used which grant, acting for whom, when, and was it allowed" from Settings › Activity (filter `connector.use.`). Two actions, written by `backend/src/services/connector/connector-use-audit.service.ts` through the activity log (#881):

- `connector.use.refused` — written every time. `after.reason` is `role_not_allowed` (the role gate in `requireConnectorAccess`, the remote MCP proxy, the Zoho draft route; `after.allowedRoles` lists the owner's allowlist) or `grant_not_shared` (Crewly Cloud answered `not_permitted` for the person the call acts for; Google carries `after.authorizedBy` and the product in `after.what`). The actor is the agent the role decision was made for (`caller.session`), the person in `after.actingFor` / `after.actingForRole` comes from the acting-for context.
- `connector.use.allowed` — one Drive search is one call, so an allowed use is written once per actor, connection and person per hour (`ACTIVITY_LOG_CONSTANTS.USE_ALLOWED_WINDOW_MS`); the note says further uses in that hour are not logged. The in-memory window map is capped at `USE_KEYS_MAX` keys (oldest dropped) and is empty after a restart. The remote MCP proxy and Zoho draft log allowed uses without a person (they do not run under the acting-for context).

Not covered yet (still open on #969): tagging memory and wiki writes with the person they came from, and the audience check on sharing them.

## Private-sourced wiki pages (#969, 2026-10-26)

What an agent reads through a person's grant is that person's data. A wiki page written from it is readable by that person and the owner only, whatever the vault's role `visibility` says.

- **Tracker** (`services/people/private-source.service.ts`): the connector role gate notes every allowed use as `(session, person, connector, at)`. A use counts for `PEOPLE_CONSTANTS.PRIVATE_SOURCE_WINDOW_MS` (20 min) — the backend has no turn boundary, so the window stands in for one. In memory; empty after a restart; at most `PRIVATE_SOURCE_SESSIONS_MAX` sessions.
- **Tagging** (`WikiIngestService.writePage`): a page write whose `callerSession` read for anyone inside the window gets frontmatter `visible_to_people: [<person ids>]`, unioned with the page's existing list and with an explicit `visibleToPeople` on the request. The list only grows: a later append from a public source never reopens the page. `log.md` entries have no frontmatter and are not tagged.
- **Reading** (`isVisibleTo(fm, viewerRole, viewerPerson)`): a page with `visible_to_people` is hidden from any `viewerPerson` not on the list; `undefined` (the owner's dashboard, an unknown session) and `owner` read everything; the role list still applies to a listed person. `viewerPerson` comes from `viewerPersonOf(session)` = the session's acting-for person (`owner` → undefined) on `POST /api/wiki/query`, memory recall's BM25 wiki search, and the meeting wiki search. The dashboard's own search routes carry no viewer and show everything to the owner.
- **Owner-only instance**: every turn acts for `owner`, so pages get `visible_to_people: [owner]` and every reader is the owner — no visible change until a member appears.

Not covered: recall from another machine.

## Private-sourced replies: the audience check (#969, 2026-10-26)

A reply an agent writes shortly after reading someone's grant draws on that person's data, so it does not go where other people read.

- **Where** (`services/orc/reply-audience.ts`, called from `deliverReply` after the destination resolver and before any post): when the private-source tracker has people other than `owner` for the session and the resolved destination is a shared place, the reply is moved to the agent's owner DM (`source: 'owner-dm'`), opened with `_Held from #room: this draws on Alice's data, which only you and they may see. Say "share it" and I will post it there._`. With no owner DM the reply is held and the agent gets the reason and what to do (`held: true`, never a silent drop).
- **Shared place**: a chat-v2 conversation that is not a `dm` (or unknown to chat-v2) and mirrors no Slack DM; a Slack channel thread, ticket thread or new top-level post. **Private**: the owner DM, a Slack DM, an internal message to another agent (`kind: 'agent'`).
- **Audit**: `connector.private_output.redirected` (target = the owner DM) or `connector.private_output.held`, both with `after.people` and `after.heldFrom`, under Settings › Activity filter `connector.private_output.`.
- **Owner-only instance**: the tracker only ever holds `owner`, so nothing changes. The deps are optional (`ReplyDeliveryDeps.audience`); tests without them see the old behaviour.
- **Sharing** (`reply --share`, `DeliverReplyInput.share`): the owner's word in the agent's DM is the approval. When the owner wrote in that DM within `TURN_TRIGGER_CONSTANTS.OWNER_ANSWER_WINDOW_MS` (`ownerAskedRecently`), a reply sent with `--share` skips the check, posts to the shared place and is logged as `connector.private_output.shared` (`after.people`, `after.sharedTo`). Without a recent owner message `--share` is ignored (warn) and the reply is redirected as usual. The redirected delivery carries `heldFrom`; `POST /api/chat/reply` returns it with a `note` telling the agent to re-run the reply with `--share` once the owner says so.
- Not covered: a decision card in the room itself (the owner answers in the DM instead), and a colleague re-posting an internal message it received.

## Private-sourced project memory (#969, 2026-10-26)

The same rule for the project memory files outside the wiki (`memory/` patterns, decisions, gotchas).

- **Tagging** (`MemoryService.rememberForProject`): a project-scope `remember` whose session read for anyone inside the tracker window writes the entry with `visibleToPeople: [<person ids>]`. On a dedup hit the existing entry's list is unioned with the new one (`mergePeople`); a later public write of the same entry never clears it. Relationships carry no tag (component names, no agent attribution).
- **Reading** (`ProjectMemoryService.searchAll(projectPath, query, { person })`): an entry with `visibleToPeople` is hidden from any `person` not on the list (`personMayView`); the owner (no `person`, or `owner`) sees everything. Memory recall passes `viewerPersonOf(agentId)`. `generateProjectContext` (the session-start context block) and the raw `getPatterns`/`getDecisions`/`getGotchas` readers are unfiltered: they serve the agent's own project, not a cross-person query.

