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
