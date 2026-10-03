# Changelog

User-visible changes. Newest first.

## Unreleased

### Added

- **The owner chooses the nightly receipt format (#856).** The calm receipt has never reached
  you: the nightly send has been off since 9/28. While it is off, Crewly now asks once, at the
  receipt time, on a card in your DM that shows a real sample of the last 24 h: **Turn on
  nightly** (this format) or **Keep per-ask format** (the one you approved on 9/28, which then
  gets built). Nothing is turned on unless you choose it; no answer in 3 days keeps it off.
- **Experiment cards (#986).** An optimisation ticket can now carry an experiment: a
  hypothesis ("change X → metric Y from a to b"), a Search Console or GA4 metric (via the
  seo-ops skill — e.g. organic clicks to a page, or inquiry-form submissions), and a window
  (default 14 days). When the ticket is done Crewly captures the baseline; when the window has
  settled it fetches the result, labels it worked / didn't / inconclusive (simple significance
  rules plus a minimum volume), resolves the agent's prediction, appends it to the wiki
  experiment log and posts it to you. Agents use the new `experiment-card` skill; seo-ops gains
  `metric` (one metric over a date range as JSON). Kill switch: `CREWLY_EXPERIMENTS=0`.
- **Daily signal digest (#987).** A team lead's new `signal-digest` skill turns a site's day into
  3–5 actions. `collect` reads GA4 (sessions, key events), Search Console (low-CTR top-3,
  near-miss 4–20, rising, cannibalisation, via seo-ops), the site's inbound mail (Gmail search)
  and broken sitemap pages / JS errors. It drops what the owner already chose Do on (90 days),
  skipped (30 days) or what the experiment log mentions, and drafts ranked actions
  (signal → proposal → expected effect → effort). `propose` posts **one Slack card with Do / Skip
  per action**; Do opens an `experiment` ticket in the site's project with an experiment card
  (#986) linked to it, so the baseline and the 14-day result are measured automatically, and
  tells the lead. Drafts an experiment card already covers are dropped too. API: `/api/signal-digests`. See
  `specs/2026-10-03-signal-digest.md`.

- **A subagent that does nothing is sent back to work (#852).** Crewly now registers a Claude
  Code `SubagentStart` / `SubagentStop` hook for its agents. At start, a subagent is told to do
  the work itself, report only to its parent, and never close WorkItems or message others. A
  subagent that stops without having made a single tool call (an idle or self-"delegating"
  fork) is sent back once with the reason. Turn off with `CREWLY_SUBAGENT_GUARD=0`.
  See `specs/2026-10-03-subagent-guard.md`.

### Fixed

- **A fresh Codex agent no longer adopts an older conversation from the same folder.** When
  learning a newly launched Codex agent's conversation id (used to resume it after a restart),
  Crewly now goes by when the rollout file was created, not when it was last written. Before,
  an older Codex conversation in the same folder that was still running looked "new", and its
  id could be recorded for the new agent. Filesystems that record no creation time still use
  the last write time.
- **Testing a DeepSeek API key in Settings works.** The "Test" button checked the key against
  nothing and always answered "Unknown provider: deepseek"; it now calls DeepSeek's
  OpenAI-compatible model list, like the OpenAI test.
- **The legacy chat API behaves as it did before the chat-v2 migration.** The chat sidebar
  gets live `conversation_updated` events again (new, renamed, archived conversations);
  `GET /api/chat/conversations` honours `includeArchived`, `search` and `channelType`;
  `GET /api/chat/messages` honours `senderType` / `contentType` / `after` / `before`;
  looking up a single message works; renaming, archiving or unarchiving an unknown
  conversation answers 404 instead of 500, and deleting one is a no-op.
- **Per-person access review fixes (#968), before Crewly Cloud enforces it (auth 1.10.x).**
  A post another agent wrote in Slack no longer makes the receiving agent act for that
  agent's bot, and bots are never added to People (existing bot rows are removed). Scheduled
  checks, scheduled messages, audits and other system events act for the owner instead of
  whoever spoke last. The owner is always `owner`: any Slack id known to be theirs (the
  Slack installer, `SLACK_OWNER_USER_ID` for Slack set up from env, or "Owner (me)" in
  Settings › People) maps to it. A dedicated agent no longer drops another agent's
  @-mention. Against an older Cloud, Connections shows "Requires a Cloud update" instead
  of failing. See `specs/per-person-access.md`.
- **Marketplace skills can ship files in subfolders (#800).** `crewly install` and the
  dashboard installer now create the parent folder of a nested file listed in a skill's
  `metadata.files` (e.g. `templates/LaunchVideo.tsx`) instead of failing the whole install
  with ENOENT. A listed path that would land outside the skill's folder (`../x`, an absolute
  path) is never written. The registry keeps listing only flat files until this release has
  been out long enough for older CLIs to age out.
- **An agent that dies in its first minute is no longer recorded as idle (#791).** An exit
  with no recognised cause within 60 s of start is stored as `startup_exit` instead of
  `idle_exit`, and every exit without a recognised cause logs "Runtime exited without a
  recognised cause" with the runtime, seconds since start and the cleaned terminal tail, so
  the next fresh-start reproduction shows the real reason. Agents stopped under memory
  pressure by idle detection are recorded as `idle_exit_pressure`, like the reconciler's.
- **Agents on a second Claude Code account now report their usage, so their token cap fires.**
  An agent running as `claude-code@<name>` writes its transcripts under that account's config
  dir, which the usage sync never read: it showed no usage and was never stopped. The sync, the
  orc's request roll-up and the fresh-conversation paths now search the account's dir and
  `~/.claude`. An agent that switched accounts during the day has each turn counted once.
- **Usage by work item no longer gives a stopped item all later usage.** A cancelled, re-queued
  or blocked item without a completion time was treated as open until now. Only running items
  are open; others end when their status changed (work items now record `statusChangedAt`) or
  get no span. Project attribution follows the same rule, so a never-started item no longer
  claims its agent's usage.
- **No new work for an agent over its daily token cap.** Auto-claim skips it, and the dispatcher
  neither writes to it nor counts a cap-queued brief as delivered. Identical messages waiting
  on an agent's queue are no longer stacked by reconciler redeliveries.
- **Resume works for an agent whose working directory is a symlink.** The resume check and the
  conversation handover now look for the transcript under the resolved path too.
- **An agent's recounted spend is no longer counted twice (#972).** The one-time recount of
  old transcript cursors set the cost but kept the old read position; when that position was
  past the end of the file, the next sync re-read the whole transcript and doubled the
  agent's spend (which could trip its spend cap early).
- **Usage by work item shows what each item spent.** Each token event now counts toward the
  work item its agent was running at that moment, instead of every open item getting the agent's
  whole total; each item appears once and idle usage shows as "(no work item)" (#953).
- **Spend cap now fires for agents whose working directory is a symlink (#938).** Claude Code
  files transcripts under the resolved path (on macOS `/tmp/proj` becomes `/private/tmp/proj`),
  so such agents reported $0 spend. Transcript lookup now tries the realpath slug first, then
  the raw one.
- **A "Daily token cap reached" card closes itself when the stop lifts without it.** Removing
  or raising the cap, turning the total cap off, or a boost from your DM / the API now
  withdraws that target's open card ("Closed — no longer needed …"), and a changed cap that
  still stops the agent replaces the old card instead of leaving two open. Answering the card
  works as before (#939).
- **A capped agent no longer starts a turn from an agent-to-agent message.** `POST
  /terminal/:s/write` in message mode (agent `send-message`, the WorkItem dispatcher, TL
  auto-verify), any `/write` to an in-process agent, `/deliver` with `force: true` and `POST
  /sessions/:name/write` in message mode now queue the message for an agent over its daily
  token cap, exactly like `/deliver`; it is delivered when the cap is boosted or resets. They
  answer `202 { queued: true, spendCapped: true, message: "[SPEND_CAP] …" }` (so does
  `/deliver` for any queued message, instead of `verified: true`), and `send-message` reports
  "not delivered yet, do not resend". Raw keystroke writes stay ungated (#937).
- **Agent messages to you reach the conversation they belong to — or the agent is told they
  didn't.** One harness resolver now decides where every agent→owner message goes (`reply`,
  `reply-chat`, `reply-channel`, `slack-post`, `attach-file`, file uploads, the `[DONE]`
  notice): the message / ticket / work item / decision it names, then ids it passed that
  really belong to it, then what the harness last prompted it about, then where its turn
  came from, then its DM with you. It never falls back to "the most recent conversation",
  "the latest thread" or a top-level post because a thread key named another channel. A
  `reply-chat` / `send-chat-response` message that cannot be delivered now fails with the
  command to run instead of being filed as status with `success: true` (TKT-187: a follow-up
  landed in an unrelated huddle); status reports (`report-status`, `complete-task`,
  `handoff-task`) are unaffected.
  `[FOLLOW-UP]` / `[DECISION]` prompts print `reply --ticket TKT-187 …` / `reply --decision
  D-12 …` instead of raw thread keys. "Working on it" placeholders stay up at turn end only for a
  message you are still owed an answer to (an "ok" still clears them); a promise closes only on a post that plausibly delivers it; Slack DM
  replies are no longer dropped when you last spoke on another surface long ago. See
  `specs/2026-10-02-harness-owned-routing.md`.
- **Replies on a ticket waiting for your review have three outcomes.** An approval (好 / 可以
  / OK / approve / ship it / 👍) accepts it; 打回 sends it back; anything else — a question,
  "where is it / send it again", "can you also…" — neither accepts nor reopens: the ticket
  stays in review, the agent gets your message to answer, and the usual reminder and
  auto-accept clock keep running.

### Added

- **People and per-person access to connections (#968).** Settings › People lists everyone who
  uses Crewly by Slack account (owner, members, guests). A connected Google, Canva or Microsoft
  account is now usable only for the person who connected it until it is shared with specific
  people or all members (Settings › Connections, "Belongs to" / "Usable by"); existing
  connections belong to the owner. Agents act for the person whose message they are working on,
  so asking an agent for someone else's calendar gets "Info's Google Calendar isn't shared with
  you". An agent can be set to work for one person ("Works for"); anyone else who @-mentions it
  gets a polite pointer to the team lead and no work starts. Needs Crewly Cloud auth 1.10.0.

- **Microsoft To Do task steps (#835).** `todo-add --steps "Eggs,Milk,Bread"` creates one
  task with three steps (Graph checklist items); `todo-update` adds, ticks, unticks and
  removes steps by title or id (`--add-steps`, `--check-steps`, `--uncheck-steps`,
  `--remove-steps`) without creating a new task; `todo-tasks` shows each task's steps. Calls
  without steps behave as before.

- **A second Claude Code account as a runtime fallback (#942).** When your Claude Code account
  runs out of usage, agents can move to another of your *own* Claude Code accounts on the same
  machine before falling back to other runtimes. Each account has its own config dir
  (`~/.crewly/claude-accounts/<name>`, passed as `CLAUDE_CONFIG_DIR`) and its own login — Crewly
  never switches accounts inside one login. Add one in Settings → Runtimes → Advanced → "More
  Claude Code accounts" or reply `login claude@<name>` in Slack: the sign-in link comes to your
  DM like the re-login flow (`login claude <name>` signs an existing account in again). Put `Claude Code (<name>)` in the fallback order (e.g.
  `claude-code → claude-code@work → crewly-agent → antigravity-cli`). Usage-limit detection, the
  switch-back probe and the owner notices work per account; an account whose login expires is
  marked signed out, its agents move on, and you are asked to sign it in again. Add only Claude Code
  accounts that you own. See
  `specs/2026-10-01-runtime-fallback.md`.

- **Decision cards: owner questions you answer with a tap.** An agent that needs you asks ONE
  question with 2–3 options, a default and a deadline (`ask-owner` skill, or
  `project-tickets ask-owner`). The agent that owns the work posts it from its own Slack bot,
  as a card with buttons, in the ticket's thread in the team channel (or a new thread).
  - **Answering:** tap a button, react (✅ default, ❌ "no", ⏰ tomorrow), reply in the thread,
    or use the Dashboard's new **Waiting on you** list.
  - **What happens on an answer:** the card updates to "✔ you chose …", the ticket log records
    it, and the agent gets the decision straight away.
  - **No answer by the deadline** (default: tomorrow 12:00): the default is applied. Sensitive
    asks (outside email, publishing, prod deploys, spending) are never applied: you are asked
    once more, then the question is parked.
  - **Removed:** the orchestrator's batched "Tickets waiting on you" DM. The evening digest links
    to the cards instead.
  - **Setup:** Cloud forwards button clicks (crewly-services #24). See
    `specs/2026-10-01-decision-cards.md`.

- **Project tickets — each project's own backlog, tracked in git.** One markdown file per
  ticket in `<project>/.crewly/tickets/` (frontmatter + Description / Acceptance criteria /
  Log). The project page's **Tasks** tab is now a board of these tickets (create, edit, move,
  assign). Members of the project's teams pick up `ready` tickets by themselves when idle;
  each pickup is one WorkItem, and the ticket moves to done when that WorkItem is verified.
  Agents use the new `project-tickets` skill (team leads also `assign-ticket`); the owner can
  ask the orchestrator to "put this in the backlog". API: `/api/project-tickets`.
  See `specs/2026-09-28-project-tickets.md`.
  - **Git:** when a project's `.gitignore` hides `.crewly/`, Crewly appends a small block that
    re-includes only `.crewly/tickets/` (existing lines are not changed).
  - **Old `.crewly/tasks/` files:** `crewly tickets migrate <projectPath>` shows what would be
    imported (unfinished open / in_progress files, as backlog tickets); add `--apply` to
    import. The originals are left untouched; re-running is safe.

### Changed — behavior change

- **Marking a WorkItem done now takes evidence (#873).** `complete-task`, `report-status
  --status done` and `POST /api/task-pool/complete/:id` accept an evidence block
  (`result.evidence`): artifacts (`--artifact <path>`, must exist, or an https URL), commands
  with their exit code (`--command "<cmd>" --exit-code N`), or a blocked step
  (`--blocked-step/--blocked-reason`). A missing artifact, a non-zero exit code or a malformed
  entry is refused with a 400 that names it; a blocked entry records the item as **blocked**,
  not done. Completing with no evidence still works this release but prints a warning; from
  the next release it is refused (set `CREWLY_EVIDENCE_MODE=enforce` to refuse it now).
  `verify-output` shows the evidence first and flags done items that have none.

- **Codex (GPT-5) and Gemini 2.5 usage is priced at their own list prices.** The cost table
  now has GPT-5 (incl. `gpt-5.1-codex-mini`, mini, nano) and Gemini 2.5 Pro / Flash rates, so
  these events no longer fall back to the Sonnet default, and a model listed by its exact id
  (e.g. `gemini-2.5-flash-preview-05-20`) keeps its own price over a family match. This also
  changes the USD figure the team budget gate (`maxUsdPerMonth`) reads for Codex / Gemini
  events; no team uses that limit today. The Usage page shows these as "Estimated cost (API
  prices)" beside tokens; caps stay in tokens.

- **Finished-task summaries no longer go into long-term memory (#833).** `complete-task`
  and `report-status status=done` used to save every summary as a project *decision* (and a
  "Task completed" learning), which crowded real decisions out of `recall`. The summary stays
  on the WorkItem and in `task-history.json`; the memory API also drops such text if an older
  skill still sends it. On the next session start, existing `[COMPLETED] Task completed by …`
  entries are moved out of `decisions.json` / `learnings.md` into
  `.crewly/knowledge/archive/`, and hidden (kept, marked superseded) in agent memory.
  Failed / blocked learnings are still recorded.

- **Agents answer where the work came from.** `reply` with no ids now follows the current
  work:
  - a message from you is answered in its thread;
  - ticket work goes to the ticket's thread;
  - scheduled or triggered work goes to the trigger's new `destination`, or else to a new
    top-level post in the team channel. Scheduled output no longer lands in an unrelated old
    thread.
  - `reply --new-thread "<title>"` starts a new topic.
- **Boot, restart, upgrade and disconnect notices are in English**, and so are the team
  channel's welcome and @-hint posts. Chinese commands are still accepted.
- **MCP `crewly_assign_task` now creates a real WorkItem** through the running backend and
  returns its `workItemId` (it used to return a made-up id and do nothing). It fails with a
  clear message when Crewly is not running.
- **Removed dead project routes and buttons:** `/api/projects/:id/tickets*` and
  `/ticket-templates*` (YAML tickets nobody wrote), and the project page's "Create task /
  Create milestone" and "build tasks" actions, which called endpoints that did not exist.

- **`GET /health` now requires the API token from non-loopback callers** (#825).
  Loopback (`localhost`, `127.0.0.1`, `::1`) is unchanged: same status, headers and body.
  A caller from another address without the token now gets `401` with the
  `WWW-Authenticate: Crewly-Token` challenge, the same as `/api`. It previously got
  `200` and the install's version and agent count.
  - **Who is affected:** self-hosters who monitor `/health` from another machine, and
    Docker installs checked from the host through the port mapping
    (`curl localhost:8787/health` on the host is not loopback inside the container).
  - **What to do:** send the token (`X-Crewly-Token`, `Authorization: Bearer`, or the
    `crewly_token` cookie), or set `CREWLY_PUBLIC_HEALTH=1` to keep `/health` open.
    Docker `HEALTHCHECK`s that run inside the container need no change.
  - **Why:** crewly-mobile picks its same-Wi-Fi (LAN) transport when `/health` answers
    200. Since 1.15.0 (9eb405b9) every `/api` call from that transport has needed a token the
    app does not have, so the app got stuck on 401s instead of using the Cloud relay.
    With this change it falls back to the relay.
