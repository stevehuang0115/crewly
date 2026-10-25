# Activity log: who did what, and when (crewly#881)

**Status**: slice 1 shipped 2026-10-25 (1.20.408). Later slices below.

## Problem

Crewly had live terminals, a usage page, run traces and an event bus, but no
permanent record attributing a change to an actor. When a member's model was
switched, a team deleted or a held email released, nothing answered "who did
this and when" after the fact. The security page aggregates approvals but is
read-only over other stores and knows nothing about config edits.

## What ships in slice 1

### Store

`<CREWLY_HOME>/activity-log/YYYY-MM.jsonl`: one file per month, one JSON entry
per line, append-only. Nothing here is rewritten, compacted or deleted by
Crewly (the disk janitor does not touch it either). Entry shape:

```json
{
  "id": "mh3k2q-7-x9a1",
  "ts": "2026-10-25T10:14:03.512Z",
  "actor": { "type": "owner", "via": "owner-session" },
  "action": "team.member.updated",
  "target": { "type": "member", "id": "member-…", "name": "Ella" },
  "before": { "modelId": "sonnet" },
  "after": { "modelId": "opus" },
  "requestId": "req-…",
  "workItemId": "wi-…",
  "note": "Send Monday"
}
```

- `actor.type` is `owner`, `agent` or `system`. HTTP callers are mapped from the
  caller-identity middleware: owner session / API token / relay / cloud → owner;
  agent badge, process tree or legacy header → agent (`id` = session); scheduler
  → system (`id` = `scheduler:<name>`); anonymous local calls → system
  (`id` = `anonymous`). `via` keeps the middleware's verdict for audits.
- `before` / `after` hold **only the fields that changed**, shallow. Keys that
  look like secrets (`token`, `secret`, `password`, `credential`, `api_key`,
  `authorization`, `private_key`) are written as `***`; strings are cut at 400
  characters.
- Writes are chained on one promise and never awaited by the caller. A failed
  write is logged as a WARN and never fails the action it describes.

Implementation: `backend/src/services/activity/activity-log.service.ts`
(`ActivityLogService`, `recordActivity`, `actorFromRequest`,
`summarizeChange`); constants in `ACTIVITY_LOG_CONSTANTS`.

### Writers

| Action | Where | Actor | before / after |
|---|---|---|---|
| `team.created` | `createTeam` | request | members, projectIds, parent, template |
| `team.updated` | `updateTeam` | request | changed shallow team fields (members excluded) |
| `team.deleted` | `deleteTeam` | request | members, projectIds |
| `team.archived` / `team.unarchived` | `archiveTeam` | request | — |
| `team.lead.changed` | `setTeamLeadHandler` | request | lead, memberId, mode |
| `team.member.added` | `addTeamMember` | request | team, role, runtime |
| `team.member.updated` | `updateTeamMember`, `updateTeamMemberRuntime` | request | changed member fields |
| `team.member.removed` | `deleteTeamMember` | request | team, role |
| `decision.asked` | `DecisionService.ask` / `askSystem` / `askPrebuilt` | asking agent, owner, or system | status, asker, kind, teamId |
| `decision.resolved` | answer by button / reaction / reply / thread / dashboard / voice | owner (`id` = Slack user id, `via` = how) | chosenKey, answeredVia; `note` = the answer in words |
| `decision.skipped` | owner skipped the card | owner | — |
| `decision.defaulted` | deadline applied the default | system (`via: deadline`) | chosenKey |
| `decision.expired` | deadline, no default | system (`via: deadline`) | — |

Decision lines carry the decision's `requestId` (from `requestRef`) and
`workItemId` when it has them. `DecisionService` takes the writer as an
optional dep (`recordActivity`), wired in `decision.wiring.ts`; tests inject a
spy.

### Reader

`GET /api/activity` — owner only (`requireOwner`), newest first.

| Query | Meaning |
|---|---|
| `actorType` | `owner` / `agent` / `system` |
| `actorId` | exact actor id (session, Slack user id, scheduler) |
| `action` | exact (`team.member.updated`) or dotted prefix (`team.`) |
| `targetType`, `targetId` | exact |
| `since`, `until` | ISO timestamp or `YYYY-MM-DD` (`until` a bare date = end of that day) |
| `limit` | default 100, max 1000 |

Response: `{ success, data: { count, limit, entries } }`. Bad filter → 400.

## Acceptance (slice 1)

For any member config change made through the API, or any owner decision,
`GET /api/activity?targetId=<id>` alone says who did it, when, and what
changed. Verified by `activity-log.service.test.ts`,
`activity.controller.test.ts`, the `team.controller.test.ts` case
"writes who changed which fields" and the `decision.service.test.ts` case
"writes asked and resolved lines".

## Not in slice 1 (follow-ups under #881)

- Other config writers: team pause, model tiers, charter, team move, settings,
  connector grants. Each is one `recordActivity` call at its save site.
- Budget stops (#853) and outbound sends (#876: Gmail release, Slack / app
  posts, WhatsApp drafts) as `budget.*` / `send.*` actions.
- A filterable page in the dashboard (Settings › Activity) and on the portal.
- Retention: the log is unbounded by design; a month file is ~1 KB per 5
  entries, so a year of a busy home is a few MB. Revisit if that changes.
