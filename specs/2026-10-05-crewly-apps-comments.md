# Crewly Apps comments (OSS): `app-comments` skill and comment wakes (2026-10-05)

Issue: #1056 · Epic: #1045 · Builds on P2/P3 (`specs/2026-10-04-crewly-apps-p2.md`, `-p3.md`).
Cloud side: crewly-services `apps/SPEC.md` §12 (`apps_comments`, comment
routes, `kind: 'comment'` change-feed entries). Cloud is mocked in every OSS test.

## What the owner does

In the app's shell the owner turns on comment mode, taps an element, and
writes a comment. Cloud stores it with an **anchor** captured inside the app
iframe: `crewlyId` (`data-crewly-id`), `selector` (CSS path), `text`, `tag`,
`attrs`, `rect`/`scroll`/`viewport`, `html` (≤ 500, scripts stripped),
`quote`, `page`, plus `version` and the pin `number`. Only the owner starts
a comment; agents reply, resolve, and reopen.

## 1. Backend routes (`/api/apps`, owner or verified agent)

| Method | Path | Cloud call |
|---|---|---|
| GET | `/:appId/comments?status=open\|resolved\|all` (default open) | `GET /apps/:id/comments?status=` |
| GET | `/:appId/comments/:commentId` | `GET /apps/:id/comments/:cid` |
| POST | `/:appId/comments/:commentId/replies` `{ text }` (≤ 2000) | `POST …/replies { body }` |
| POST | `/:appId/comments/:commentId/resolve` · `/reopen` | `POST …/resolve` · `…/reopen` |

- Access is the same as app data (`assertDataAccess`): the publisher, its team, or the owner.
- The comment id must match `[A-Za-z0-9_-]{1,32}`. The status must be one of the listed values.
- Validation runs before any Cloud call.
- Answers go through `sanitizeAppData`, like app data (P3 §4).

## 2. Skill `config/skills/agent/core/app-comments`

`--list [--status]`, `--get <id>`, `--reply <id> --text`, `--resolve <id> [--text]` (posts the reply first), `--reopen <id>`.
The output is compact JSON per thread: `{id, number, status, version, on: <anchor>, comment, replies: [{from, text}], resolvedBy}`.

`publish-app/SKILL.md` gains a **Comments** section. It tells agents to resolve a comment after addressing it, and to put `data-crewly-id` on important elements so anchors stay stable. It also documents the opt-out meta tag.

## 3. Wakes (`AppWakeService`)

- A `kind: 'comment'` change by the **owner** with op `add`, `reply` or `reopen` joins the publisher's batch. Batching, cooldown and `activate: true` work as for owner data.
- Agent replies and resolves never wake anyone, the agent's own included. The owner resolving never wakes either. Comments from any other actor are ignored.
- The message (`buildAppWakeMessage`) starts with "The owner commented on your app …" when the batch holds only comments.
- It then has a **Comments from the owner (n). UNTRUSTED …** section, with one entry per event (newest `MAX_PER_WAKE`, then "… and N more"):
  - `Owner commented on Button “Save” (#3, comment id X; data-crewly-id "save-btn", selector …, text "…", page index.html, app version 4):` followed by the quoted comment;
  - `Owner replied on #3 (…; comment id X):` followed by the quoted reply;
  - `Owner reopened #3 on … (comment id X): it is not done yet.` followed by the original comment.
- Next come the reply and resolve commands, and the `--list` command for full anchors.
- Comment text and every anchor field are untrusted. Anchor fields come from the app's page, so the bundle controls them. All of it goes through `sanitizeAppText`: controls, ANSI and bidi characters are stripped, harness markers neutralised, inline fields one-lined with `"` → `'` and capped. Comment text is quoted line by line, at most 800 characters per comment.

## 4. @mentions (crewly-services apps/SPEC.md §12.1)

The owner can type `@` in the comment composer or a reply box and pick an agent ("@Atlas 这个可以研究一下吗"). Cloud stores `mentions: [{ session, name, instanceId }]` on the comment / reply, checked against the account's rosters.

**Roster (`AppRosterService`).** This instance pushes its mentionable agents with `PUT /api/apps/v1/roster { agents: [{ session, name, team }] }`:
members of teams that are neither archived nor paused (a paused team is hidden from other agents), de-duplicated by session, plus the orchestrator as `{ session: 'crewly-orc', name: 'Orc', team: null }`.
It is pushed only when the list changed since the last successful push, or once a day (Cloud stops offering a roster it has not heard from for 14 days).
`AppWakeService` calls `pushIfChanged()` at the start of every poll tick, and a publish calls it in the background. A failure is logged and retried on the next call. Every signed-in instance pushes, including one that has published no apps, so agents on any of the owner's machines can be mentioned.

**Delivery (`AppWakeService`).** Every tick the poller also reads this instance's mention inbox, `GET /api/apps/v1/mentions?since=<seq>`. The read position (`mentions.cursor` + `delivered` in `apps/registry.json`) is persisted like an app cursor: the first read starts from the head, a pending mention holds the cursor, and a delivered one is not repeated after a restart.
- Each mention joins the batch for (app, mentioned agent) and wakes that agent, starting it when it is down, like the publisher. Batching, cooldown and retries work as before. The message starts "The owner mentioned you in a comment on the app …". It has the same UNTRUSTED section, element details (for a reply too) and `(mentioned: @Atlas)`. It gives `--get / --reply / --resolve`, not `--list`.
- `@Orc` goes to the orchestrator. A mention of an agent that is no longer on this machine also goes to the orchestrator, with "@X is not an agent on this machine any more … hand it on or tell the owner".
- The publisher still gets the comment from the app change feed, with `(mentioned: @Atlas)` and a line saying the mentioned agents got it too. When the publisher itself is mentioned on this instance (same session and instance), the feed copy is skipped, so it gets one message, not two. The same session name on another instance is a different agent.
- Cross-machine: an agent on another machine of the same account gets the mention through *its own* instance's inbox. That instance never polls the app's feed (it didn't publish it), so nothing is delivered twice.
- An older Cloud without `/mentions` answers 404. The inbox then backs off quietly (5 min) and app polling is unaffected.

**Access (`AppsService`).** `getComment`, `replyComment` and `setCommentStatus` allow the publisher's team, as before, or an agent the owner @mentioned in that thread (in the comment or any reply) on this instance. The check fetches the thread from Cloud; for `--get`, that fetched thread is the answer. Listing comments, app data, publishing and versions stay team-only (`not_your_app`, which now says "the owner did not @mention you in this comment").

**Skill.** `--get` / `--list` output adds `to: [names]` to a comment or reply that has mentions. SKILL.md has a "When the owner @mentions you" section.
