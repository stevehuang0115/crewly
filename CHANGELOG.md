# Changelog

User-visible changes. Newest first.

## Unreleased

### Added

- **A held reply comes with a Share / Keep private card (crewly#969).** When a reply drawing on someone's private data is moved to your DM with the agent, a card under it asks whether to post it in the room it was held from. Share posts it there as written, once, and logs the share; Keep private (the default after a day) leaves it in your DM. Saying "share it" in the DM still works.

### Fixed

- **`spawn-subagent` says when the provider is out of credit (crewly#1317).** Where the fallback service has marked the in-process runtime exhausted (DeepSeek's "Insufficient Balance", for example), the skill now refuses with `provider_exhausted` and the date instead of starting a helper that fails at its first model call with "No output generated"; a helper that does fail carries the worker's last stderr lines in `error`, and its log file (`<parent>__sub-<n>.log`) is written — a slash in the session name had sent it to a directory that does not exist.
- **The check-up App no longer shows "0 min" for a step that took seconds (crewly#1062).** A step or total under a minute reads "under a minute".

### Fixed

- **A remote MCP session's opening handshake no longer counts as a connector use (crewly#969).** Only a `tools/call` writes `connector.use.allowed` (named after the tool); `initialize` and `tools/list` at session start do not, so a restart no longer writes one line per agent.

### Added

- **`reply --share` posts a held private-sourced reply where it was meant to go (crewly#969).** When such a reply went to your DM instead of a room, say in that DM that it may be shared; the agent then re-sends it with `--share` and it lands in the room. The flag works only while your message in that DM is recent, and Settings › Activity records the share as `connector.private_output.shared`.
- **An agent's reply that draws on one person's data no longer lands in a shared room (crewly#969).** When an agent answers within 20 minutes of reading someone's connector grant and the answer would go to a room, channel thread or ticket thread, it goes to the agent's DM with the owner instead, opened with a line saying where it was held from and whose data it draws on; the owner can say "share it" there. Settings › Activity records it as `connector.private_output.redirected`. Replies to the owner DM, a Slack DM or another agent are unchanged, and so is an instance with no members.
- **Project memory written from a person's data stays with that person (crewly#969).** A pattern, decision or gotcha an agent remembers within 20 minutes of reading someone's connector grant is tagged with that person; memory recall for a session acting for anyone else leaves it out, while the owner and the person named still see it. Entries nobody's grant fed are unchanged. See `specs/per-person-access.md` → "Private-sourced project memory".
- **A wiki page written from someone's private grant is readable by that person and the owner only (crewly#969).** When an agent has read a connector (Google Workspace, Canva, Microsoft To Do, a remote MCP server) acting for a person in the last 20 minutes, the wiki pages it writes carry `visible_to_people` with that person; wiki query, memory recall and meeting search hide such pages from anyone else the asking agent acts for. The owner sees everything; the list only grows, so a later public append never reopens a page. See `specs/per-person-access.md` → "Private-sourced wiki pages".
- **The activity log now says who used which connection, acting for whom, and whether it was allowed (crewly#969).** Settings › Activity (filter `connector.use.`) gets `connector.use.refused` for every refusal — a role off the owner's allowlist (with the allowed roles) or Crewly Cloud refusing a grant that is not shared with the person the agent acts for (with who authorized it, where Cloud says) — on the Google Workspace, Canva and Microsoft To Do routes, the remote MCP proxy and Zoho drafts; and `connector.use.allowed` once per agent, connection and person per hour, so a run of Drive searches is one line, not fifty. The log is read-only for agents; the window is in memory and empty after a restart.
- **A check-up can be ended, with a receipt (crewly#1055).** The new `checkup-end` skill deletes everything the small-business check-up left on the machine — the ingested exports, the analysis with its list of people, the report and daily documents, the intake answers, the time log, the App page copy, and with `--exports <dir>` the raw CSV files the owner handed over — and writes `checkup-end-receipt.json` / `.md`: every file deleted with its kind and size, whether names were hashed at ingest, what was left alone (a stray file, a sub-folder, a symbolic link — only files the check-up skills are known to write are touched), and what is still to do: unpublish the App (`publish-app --app <id> --delete`) and revoke any access the owner handed over (Crewly stored none; the apps named in the intake are listed). `--dry-run` lists without deleting; a folder that does not look like a check-up is refused. The `small-business-checkup` Checkup Lead runs it after the seventh daily line or the owner's word. See `specs/2026-10-26-checkup-end-skill.md`.
- **Agents on every runtime can hand a bounded task to a short-lived helper (crewly#1317, slice 2b).** The new `spawn-subagent` skill runs one in-process helper for a Claude Code, Codex, Gemini or crewly-agent agent: `--task` (with its acceptance line), `--cwd` (where it may write; default the project), `--read-only`, `--max-steps` (default 30, cap 60), `--model`. The helper has read, grep, edit-under-cwd and `report_to_parent` only — it cannot message, delegate, schedule or spawn — and the call returns its report with `stoppedReason` (`done`, `did_nothing`, `steps_exhausted`, `incomplete`, `timeout`, `error`), the tools it used, the files it changed and its tokens, so a report with no tool calls reads as "did nothing". At most 3 helpers per agent at once; a helper cannot spawn helpers. Backed by `POST /api/subagents`. See `specs/2026-10-26-in-process-subagents.md`.

- **The small-business check-up has a team and a clock (crewly#1062, slice 3).** The free `small-business-checkup` team template runs the whole check-up: a Checkup Lead (intake App → exports or connectors → analysis → report → 7 daily lines), a Data Analyst (`ingest-exports`, `--hash-names` for children's data, `checkup-analyse`) and a Reviewer who checks the report against the data and the owner's answers before it is published; remove the Reviewer from the team and the review step is off. `checkup-report --log-step <intake|connect|analyse|report|daily> --start|--end` keeps a per-step time log (`timelog.json`); the report document carries the minutes per step and the total, and the App shows them under "How long it took", so the check-up is measured by how long it really takes.

- **The small-business check-up has its App (crewly#1062, slice 2).** The new `checkup-report` skill ships one Crewly App page the owner opens on their phone: **Your answers** (the five intake questions — apps, slowest weekly task, what they fear slipping through, apps per customer, which number to see first; saving tells the agent), **Report** (the number they asked for first, the top 3 breaks with count, estimate, formula, a few examples and what an agent could do, every break, what could not be checked, files, assumptions, and an "Ask about this report" button that reaches the agent) and **Daily** (one line a day for the 7 free days). `checkup-report --app-dir` copies the page into the project for `publish-app`; `--breaks …/breaks.json --business … --intake …` turns `checkup-analyse` output into the App's report document (examples only, never the whole list of people; counts only when the exports were hashed); `--daily "…"` writes a day's summary. See `specs/2026-10-26-checkup-report-app.md`.

- **Agents can find where a small business's apps disagree (crewly#1062, slice 1).** The new `checkup-analyse` skill reads what `ingest-exports` wrote, links the same person across every file (email, then phone, then name), follows inquiry → sign-up → payment → repeat and lists the breaks: inquiries with no sign-up or payment after them, sign-ups with no payment, payments from people on no roster, drop-outs, lapsed customers, overdue invoices, the same person keyed into two or more systems, and paying customers the mailing list does not have. Every break carries an hours/week and $/month estimate with its formula written out and marked as an estimate; the inputs (`hourlyValue`, `minutesPerFollowUp`, `winBackRate`, `lapsedDays`, …) can be changed with `--assume`. It writes `breaks.json` (every item) and `report.md` (top 3 with what an agent could do for each, every break, the files, the assumptions) and says which checks the data could not support. Hashed exports give the same counts with no name in the output. See `specs/2026-10-26-checkup-analyse-skill.md`.

- **Agents can load CSV exports from the tools a small business already uses (crewly#1061).** The new `ingest-exports` skill recognises Square (transactions, customers), QuickBooks Online (invoices, customers), Mailchimp, Jotform, Jackrabbit, Mindbody, Calendly and Stripe exports by their headers and writes every row in one common schema (contact / booking / payment / invoice) with the original columns kept, plus rows and date range per file. A CSV it does not recognise still loads, with a "could not map" note. `--hash-names` replaces names, emails and phone numbers (children's included) with short stable hashes so a check-up can count people without storing who they are. This is the fallback path of the small-business check-up (crewly#1055) for tools without an API. See `specs/2026-10-26-ingest-exports-skill.md`.

- **The eval runner keeps a "not yet" set (crewly#888, slice 4).** A task current models fail is marked `notYet: { since, reason }` in the registry: `run --all` leaves it out and says so, `run --not-yet` re-runs just those after a model change, `not-yet` lists them, and the diff report names any flagged task whose run now passes every check so its mark can come off. The set is empty until a recorded run shows a task failing on every runtime. See `eval/README.md`.

- **The eval runner has business tasks (crewly#888, slice 3).** Crewly's users run small businesses, so the benchmark set gains four tasks that are files in, files out: D1 bookkeeping (month summary from a bank export and category rules, uncategorized rows listed for the owner), D2 marketing (three social posts under a brand rule sheet), D3 customer intake (triage six inbox messages, book the free slots, draft the replies) and D4 payment reminders (one reminder per overdue unpaid invoice). Each has a checker outside the fixture (`eval/checks/<task>/check.mjs`) that recomputes the expected result and a reference solution the unit test runs through it. All four are labelled `inferred`: the pass conditions were written by us, not confirmed with a real bookkeeper, marketer or receptionist. See `eval/README.md`.

- **Code PRs can merge in crewly-web without GitHub CI (CREW-839, approved under D-911).** Extends the local-gate path (CREW-837) from blog posts to code, for crewly-web only (`"codePrs": true` in `config/hooks/destructive-git-guard/local-gates.json`; each repo is turned on by hand). A PR with non-content files now also needs a team leader's marker for the same head commit, written by the new `record-tl-verification --repo owner/name --pr N --summary "..."` skill. It refuses unless the caller is a team leader and not the session that ran the gate, and it needs a passing `record-local-gate` record at that head. The guard prints both sessions when it accepts. A new commit invalidates the record and the marker. Blog-only PRs keep their path (no marker), repos without `codePrs` and public repos are unchanged, and a check that really failed or a PR more than 5 commits behind still blocks. Both files are speed bumps, not boundaries.

- **A merge path for private repos whose CI can never run (CREW-837).** GitHub Actions is off for the private repos, so `destructive-git-guard` could never see green CI and their PRs could not merge. For a repo listed in `config/hooks/destructive-git-guard/local-gates.json` (today: crewly-web, blog posts `content/blog/**/*.md` only), `gh pr merge` is now accepted without CI when `record-local-gate --repo owner/name --pr N` has recorded a passing run (`npm ci`, `tsc`, `vitest`, `next build`) of the PR's exact head in a fresh clone, the record was made against the current base head, and no check really failed (a job GitHub never started because of billing counts as absent). Code PRs, other repos, a PR with any non-content file or rename, a failed or stale record, and a PR more than 5 commits behind stay blocked as before; each block says what is missing. The record is a file: a speed bump like the guard, not a boundary.

- **Claude sign-in no longer stores a token (CREW-759).** Anthropic's Claude Code terms say developers may not collect, store or pass on Claude.ai credentials; sign-in has to finish inside Claude Code. `login claude [name]` (Slack, the owner-login API, the TUI) now runs Claude Code's own `claude auth login`, relays the link and the one-time code as before, and Claude Code keeps the login itself. Crewly no longer runs `claude setup-token`, never reads a token off the screen, never saves `claude.oauthToken` / `claudeAccounts.*.oauthToken`, and never sets `CLAUDE_CODE_OAUTH_TOKEN` for new logins; accounts are told apart by `CLAUDE_CONFIG_DIR` only. "Signed in" is read from `claude auth status`. Nothing locks you out on upgrade: a token an older Crewly saved keeps working until you sign that account in again, and you get one message per machine naming the accounts to re-sign in. A saved token is deleted only after the account's new login passes a real Claude turn; then the Claude keys leave `harness-credentials.json`. There is no deadline for the transition. See `specs/onboarding-harness-login.md`.

- **Crewly now acts on stalled work instead of only measuring it (crewly#1363, crewly#1362).** On 2026-10-17 an agent promised a video "in about an hour", its sub-agent died in a restart and nothing happened for 16 hours; another said "已经开跑…预计 1 小时左右" for a render, was idle-stopped and nobody checked; a lead told you "Pia 在做了" with nothing assigned to Pia. A stall watcher (every 5 minutes) now follows three kinds of in-flight work, keyed to the agent's own estimate: **promises to you** (at 1.5× the estimate the agent is re-briefed once, with the last message before its promise so it does not wait for an approval it already had; at 3× its lead is told once; if the lead does not answer in the thread within 30 minutes you get one plain line, in your language, at most once a day per item), **claimed work** (no tool calls, posts or file changes for 30 minutes: the agent is nudged once with the cause — quota, a failed delivery, waiting on someone; a second silent window releases the claim so the work goes to the lead and then the orchestrator), and **background runs** an agent announced (recorded in `~/.crewly/in-flight-runs.json`; the agent is not idle-stopped or evicted until the run is due plus 30 minutes; the same ladder when no result lands in the thread). When an agent tells you a named teammate is doing something and no task or ticket for that teammate exists within 10 minutes, the agent is told once to delegate or correct the thread; you are never messaged for that. Every line to an agent is one line; one nudge per agent per 30 minutes; you are never the retry loop. The first day after this update is a dry run (log lines "Dry run: would …", nothing sent); `CREWLY_STALL_WATCHER_DRY_RUN=false` arms it at once, `CREWLY_STALL_WATCHER=false` switches it off. See `specs/2026-10-17-stall-watcher.md`.

- **The disk janitor now cleans up what agents leave behind, not only finished work (crewly#1354).** After a full-disk day the janitor was found keeping 21 worktrees with unmerged or uncommitted work, each with a full `node_modules` (2–3 GB), forever; 10 GB of agent conversation transcripts; 600 MB of `~/.crewly/tmp`; and uncapped logs. Now: a kept worktree nobody has touched for **3 days** (1 day when the disk is low, or once its task finished) loses its `node_modules` and build output (`.next`, `dist`, `.turbo`, `.cache`; never a folder git tracks, never source) and the team lead is told once; after **14 days** untouched its uncommitted changes and untracked files are saved as a patch under `~/.crewly/worktree-archive/<repo>/<name>-<date>.patch`, the branch is kept, the worktree is removed and the lead is told how to restore it. Conversations Crewly launched for agents (identified by Claude Code's `agentSetting` header or Crewly's own records — your own conversations are never touched) are pruned after **14 days**, keeping the current conversation of every live or remembered agent, in `~/.claude` and every Claude account folder. `~/.crewly/tmp` entries go after 7 days (Slack files 30, release build dirs 2, skill output 7), `logs/archive` is capped at 300 MB and `logs/sessions` at 100 MB (oldest first; live logs never). "Low disk" is now **max(15 GB, 8 % of the disk)** — a 1 TB Mac misbehaves long before 15 GB — and the once-a-day owner notice says what was freed by kind and that your own files, downloads and app caches are never touched. The first pass after this update only reports what it would delete (log lines marked "dry run, not yet armed"); deletes start the next day. New worktrees made for tasks now share each workspace package's `node_modules` from the main checkout when `package-lock.json` is unchanged, and agents are told to symlink instead of `npm install`. See `specs/2026-09-28-worktree-janitor.md`.

- **Every finished task leaves a work record (crewly#1349).** The vault log only held what agents chose to write down. Now, when a task finishes (verified, done, rejected, cancelled, failed) or sits blocked for more than a day, Crewly writes one `(record)` entry into the project's vault log (and the team's, when it has one): who asked for it and a short quote of the ask, who did it, what was done and what came out (PRs, commits, files, checks, messages posted), what went wrong on the way and whether it was fixed, who was pulled in (delegations and what came back, questions to teammates and whether they were answered, the reviewer), and how it ended (verified by you, verified by the lead, accepted because nobody objected, rejected, cancelled, blocked). Records come from the task itself, its ticket, its sub-tasks, the run trace and the agent's own transcript; no model calls, secrets masked, at most 2,500 characters each, and ticket ids never appear in the text you read. The weekly digest gains "Work done", "Errors and fixes" and "Collaboration" (who delegated to or helped whom, counted per pair), and an agent's registration briefing lists its last 5 records so it restarts knowing what it recently did and for whom. On first start the backend catches up on the last 7 days (200 per hour). Switch: `CREWLY_WORK_RECORDS=false`. See `specs/2026-10-17-work-records.md`.
- **Agents keep their conversations (crewly#1344).** Crewly reset member conversations far more often than Claude Code itself would: a `/clear` on every new task (137 in 48 h on one machine, some of 56k-token conversations), a fresh start at 150k, a cap at 200k, and always a fresh start after a switch between Claude Code accounts or a move between machines. Now: a new task only clears a conversation that is at least the fresh-start threshold and never one the owner is in (an owner thread active in the last 2 h); the fresh-start threshold is 400k and the idle cap 450k, both above Claude Code's own 350k auto-compact so compaction runs first (`CREWLY_MEMBER_FRESH_CONTEXT_TOKENS`, `CREWLY_MEMBER_CONTEXT_CAP_TOKENS` still override); a switch to another Claude Code account copies the transcript into that account's config dir and resumes it (and back on the revert); a team move carries each member's latest Claude Code conversation and resumes it on the destination, carries the Slack room's chat channel with its recent messages, repairs a Slack mapping whose chat channel is missing at start, and never drops a project the team lists (placeholder folder `…-NEEDS-PATH`, one DM to you). Handover files now keep 60 messages × 2,000 characters (~40k) plus one line per tool call and result. The Slack "thread so far" block always opens with the thread root, keeps 1,500 characters per message and 12,000 in all, and describes attachments. Churn: an agent idle under 5 minutes is never evicted for a slot, one the owner spoke to in the last 2 h is not evicted and waits 30 minutes before an idle stop. Owner-thread records older than 3 days, or whose agent left this machine, are dropped instead of being re-stamped "restarted" on every boot. See `specs/2026-10-17-agent-conversation-continuity.md`.
- **The wiki log is read, rotated and compiled; the ingest queue drains itself; agent memory refreshes daily (crewly#1345).** `llm-curated/log.md` had become write-only noise (one vault: 19 MB, 6k templated "task:done running→done" records, 3k duplicates) that search never read, `~/.crewly/wiki-queue` had 219 items pending for a month because its only consumer was the switched-off LLM bridge, and `memory.json` only moved on an explicit remember. Now: templated transitions are no longer written (they stay in the structured log) and identical appends are refused; recent log entries (30 days) are searchable through `wiki-query`, `recall` and the Wiki search, ranked below pages; a log over 2 MB or 2000 entries rotates into `llm-curated/log-archive/` (kept, never searched) with the last 30 days carried forward; once a day the week's entries are compiled into `llm-curated/digests/<week>.md`; pending queue items older than a day are filed into their vault log by the backend (100 per hour); each active agent's own recent entries are reflected into its `memory.json` and the project's gotchas/decisions; and registration adds `## Your Project Knowledge` (owner threads waiting on the agent, its lessons from 7 days, recently changed pages, the wiki index; ≤ 12k chars). No model calls, nothing deleted. Switches: `CREWLY_WIKI_MAINTENANCE=false`, `CREWLY_AGENT_MEMORY_REFRESH=false`. See `specs/2026-10-17-wiki-log-memory-hygiene.md` and `docs/guides/wiki-log-and-memory.md`.
- **Approve from a Crewly App, for real (crewly#1228).** An app can now ask you to approve one action with `crewly.decide(...)`. Crewly shows its own prompt above the app (the app's page cannot answer it), and your Approve or Decline reaches the app's agent as `[APP DECISION] The owner APPROVED "<action>"`, which counts as your approval for that action, once. You no longer have to say it again in Slack. Needs the Crewly Apps update (crewly-services #110).
- **Answers between agents come back.** When one agent hands work to another with a plain message and the other works on it for 2+ minutes, then ends its turn without writing back or posting anywhere, Crewly now passes its last words (from its own transcript, secrets masked) to the agent that asked, as `[ANSWER FROM <NAME>]`. On 2026-10-14 a teammate finished an owner's video replica, said "done" only in its own terminal, and nobody saw it for seven hours. Asks are kept in `~/.crewly/agent-asks.json` for 12 hours; a reply to the sender, a chat post, or a short read-and-let-go turn clears them quietly. `CREWLY_AGENT_ASK_RETURN=off` turns it off. See `specs/2026-10-14-agent-ask-return-path.md`.
- **macOS: Crewly comes back when Terminal goes away.** `crewly service install` now also installs a small launchd watchdog (`~/Library/LaunchAgents/com.crewly.watchdog.plist`, once a minute, low priority). When Crewly is down, no supervisor is running and you did not stop it, it re-opens `~/.crewly/crewly-start.command` in Terminal (so Terminal's Full Disk Access still applies). It relaunches at most 3 times in 15 minutes, then stops and sends you one Slack notice if the backend can still be reached. `crewly stop` and `crewly service stop` are respected (they write the shutdown marker, which `crewly start` clears); `crewly service pause` / `resume` switch the watchdog off and on. Log: `~/.crewly/logs/watchdog.log` (capped). `crewly service status` shows it. Run `crewly service install` once on an existing install to add it.
- **Team move: repositories without a remote.** A project whose git repository has no remote (or has commits the remote lacks, when "carry changes" is on and they do not fit as patches) no longer blocks a move: it travels in the encrypted package as a `git bundle` plus its uncommitted and untracked (not ignored) files, and the target rebuilds it in the relocated project folder and deletes the bundle. The check and preflight say "no remote — will be carried in the package (x GB)". Limits: 2 GB per repository and 3 GB per move for bundles (`CREWLY_TEAM_MOVE_BUNDLE_MAX_MB`, `CREWLY_TEAM_MOVE_BUNDLES_MAX_MB`); carried working-tree changes now default to 512 MB / 128 MB per file (`CREWLY_TEAM_MOVE_CARRY_MAX_MB`, `CREWLY_TEAM_MOVE_CARRY_FILE_MAX_MB`); project `.crewly` files are configurable too (`CREWLY_TEAM_MOVE_PROJECT_FILES_MAX_MB`, `CREWLY_TEAM_MOVE_PROJECT_FILE_MAX_MB`). Bundles are written, hashed, encrypted, uploaded (8 MB chunks, resumable) and unpacked as streams.
- **A new look: light and dark themes (design language v2, "Glass").** The dashboard now has a light
  theme (the default look: a soft sunset sky of blue, violet, rose and peach behind frosted white
  glass) and a dark theme (the same sky at night: deep indigo, easy on the eyes, never pure black).
  It follows your device by default; **Settings > General > Appearance** lets you pick System, Light
  or Dark, and remembers it in this browser. Cards, the sidebar, the phone tab bar, menus, dialogs
  and toasts are glass; step kinds (read, edit, run, find, browse, delegate, think) get their own
  colour and icon. Nothing moved or was removed: every page and action is where it was. See
  `specs/2026-10-12-design-language-v2-glass.md`.
- **Owner board, machine side (crewly#1247).** Crewly now builds a board of what your teams are doing and what got done, and sends it to Crewly Cloud every minute and within about 2 seconds of any change (nothing is sent when you are not signed in to Cloud; `CREWLY_BOARD_PUSH=0` turns it off). It holds: done today by result ("2 posts published"), what waits on you, what is stuck and on whom, spend, and one row per agent with its state, task and what it is doing right now (coding in a repo, browsing a site, running a command, writing, messaging, waiting on you). Only paths relative to the project, host and path of pages, command names (`git push`, never arguments) and channel names are sent; tokens, emails, phone numbers and query strings are removed. The same snapshot is at `GET /api/board`. The Claude Code status hook now also passes the tool's file path, command and URL (PreToolUse only, to the local backend, never stored raw).
- **Scheduled commands can message agents.** A command the backend starts from `scheduled-commands.json` now gets an in-memory credential (`CREWLY_SCHEDULER_CREDENTIAL`, plus `CREWLY_SCHEDULER_NAME`) that `send-message` sends on its own. It lets the command deliver a note to an agent and nothing else: the note arrives as `[scheduler:<name>] …`, never as the owner or an agent, and every owner-only route still answers 401. This is what lets the crewly-web release line reach Sam and Ella again (it had failed with `owner_auth_required` since the runner took the job over). See `docs/guides/scheduled-commands.md`.
- **Scheduled commands.** The backend can run a host command on an interval from `~/.crewly/scheduled-commands.json` (no file = off). Runs are detached, so a Crewly restart does not cut one off, and a run never starts while the previous one is alive. Entries can only be added by editing the file, never through the API. See `docs/guides/scheduled-commands.md`.
- **Your message reaches a busy agent mid-turn.** When a Claude Code agent is in the middle
  of a long turn, your message no longer waits for the turn to end: Crewly hands it to the agent
  right after its next tool call, framed as an owner message to answer now. It stays queued until
  the agent replies in that conversation; unanswered after 5 minutes it is shown once more, and
  if the agent still has not replied it is delivered as before when the turn ends (with a note
  not to answer twice). Only your messages, never other traffic. Off switch:
  `CREWLY_OWNER_MESSAGE_VIA_HOOK=off`. See `specs/2026-10-05-owner-message-via-hook.md`.
- **The owner chooses the nightly receipt format (#856).** The calm receipt has never reached
  you: the nightly send has been off since 9/28. While it is off, Crewly now asks once, at the
  receipt time, on a card in your DM that shows a real sample of the last 24 h: **Turn on
  nightly** (this format) or **Keep per-ask format** (the one you approved on 9/28, which then
  gets built). Nothing is turned on unless you choose it; no answer in 3 days keeps it off.
- **How autonomous was a run? Run timeline and autonomy metrics (#984).** Every traced run now
  has metrics computed from its events: where the time went (agents working, waiting on you,
  waiting on an agent, idle), your touches (answered, approved, sent back, corrected, manual),
  rework (send-backs, retries, failed verifications, subagent send-backs), stalls longer than
  30 minutes with their cause (runtime out of usage or signed out, a message not delivered,
  waiting on you, waiting on an agent, nobody pushing), how often Crewly had to step in (nudges,
  redeliveries, wakes, corrections, guard blocks, misroutes), tokens and cost by agent and model,
  and the outcome. A request's page has a new **Timeline** tab: a metrics strip, then the run as
  one list of turns, your actions and stalls (stalls highlighted with their cause; click a turn
  for its events). Tickets has a new **Experiments** tab; each card has the same Timeline. Team
  leads and the orchestrator read a run with the new `trace-read` skill (by trace, work item,
  ticket, request or experiment, or recent runs; size-bounded). Stall threshold:
  `CREWLY_TRACE_STALL_MINUTES`. API: `GET /api/traces/:id/metrics|timeline|summary`. See
  `specs/2026-10-03-autonomy-metrics.md`.
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

### Changed

- **"Where is it now?" for every request.** `GET /api/requests/:id/whereabouts` (or `TKT-n`) says who holds a request right now, doing what (working, queued, blocked, reviewing, waiting on another agent, waiting on you) and for how long, following plain-message hand-offs between agents (Ella → Pia → Dex). Agents get it with `trace-read --where TKT-12`, so "how is X going" gets a real answer; the request page shows it as a "Now:" line.
- **Accepting a review means saying what you checked (#1314).** A reviewer who accepts a teammate's work now records, per piece of the worker's evidence, what they did (opened the file, re-ran the command, looked at the page) and whether it passed. An accept with no such record, or with a failed check, is refused, and the work stays waiting for review. The record is kept on both the review and the reviewed work item (`reviewChecks`). Sending work back is unchanged. The review request now lists the worker's evidence numbered, and `verify-output` shows each entry's index.
- **Done needs evidence, now for real (#1312).** Completing a delegated task, project task or review without evidence (a file, a link, or a command with its exit code) is now refused with `evidence_required` and the task stays open; before, it was accepted with a warning, and 304 of 1081 completions since 2026-10-10 had none. `report-status` tells the agent which flags to add, and the in-process agent's `report_status` no longer hides the refusal. A review with a verdict, and harness bookkeeping (triage, replans, retros), need no evidence. `CREWLY_EVIDENCE_MODE=warn` brings back the old behaviour.
- **Done needs real files (#1313).** A completion's file evidence is now refused when the file is empty, or when it was last changed more than 5 minutes before the task was created (an earlier task's output or a placeholder). Files that pass are stored with their size and modification time, so the reviewer sees what was checked. Directories and http(s) links are checked as before.

### Fixed

- **Work the orchestrator did itself no longer waits on a review it cannot give.** When the orchestrator finished a delegated item and had no separate lead to review it, the review item was targeted at the orchestrator; the gate refused every attempt as self-review and the item was redelivered every 5 minutes (10/26). Such work now goes straight to the owner for review (the last step of the lead → orchestrator → owner chain) with the reason stated, instead of after the 24-hour review TTL; the orchestrator stays refused as its own reviewer.
- **A scheduled command's note to a stopped team member is queued, not lost (CREW-362).** The crewly-web release sends its FAILED / released lines to the lead through `send-message`. When that lead's session was stopped, the write answered 404 "Session not found" and the line reached nobody (10/8 and again 10/26 13:30Z), because only agent-to-agent messages were queued for a member who is down. A message from a scheduled command (the scheduler credential) to a configured team member who is down is now queued on that member's message queue (202, `waking: false`) and delivered when the agent next starts. It does not start the agent: a system notice is not a reason to. An unknown session still answers 404.
- **A brief that keeps failing to reach its agent now reaches a person (CREW-577).** After 3 failed redeliveries in a row of one queued WorkItem (for example the agent is over its token cap, out of usage, paused or its write fails), the target's team lead gets one review item naming the WorkItem, the agent and the reason (the orchestrator when the agent leads its own team). Redeliveries that wait on the agent's queue, or are held back because the agent was stopped for memory or the machine is offline, do not count. The retry already backed off; this adds the notice.
- `delegate-task --thread` now refuses, and lists the post, when another agent already answered the owner in that thread after the owner's last message (including posts made with `reply --work-item`); pass `--force-after-answer` to delegate anyway (CREW-878).
- **Cloud no longer drops out after a refresh-token renewal (regression in 1.20.372).** 1.20.372 started renewing the Cloud refresh token a week before it expires. On startup, the old token read from the config file was then written back over the new one, so Cloud rejected every refresh from about an hour later (`app-data` 409 "Invalid or expired token", app wake polling down). The client now remembers refresh tokens Cloud has replaced and never stores one again, whoever hands it over (startup restore, the connect endpoint, the Google sign-in endpoints); startup passes the client's current token; and the new token is saved to disk the moment it is received. If you were hit by this, run `crewly cloud login` once.
- **A lead's own delegation no longer reaches you as "your request" (crewly#1357).** When a team lead handed work to a member without saying which of your threads it answered, the work took whatever owner thread the lead was in — or had been in days ago — and the member's internal report ("script names, exit codes, file paths"), or Crewly's own "Ella finished: … Results: <PR link, codec, file sizes>" line, landed in that thread. Now a delegation is yours only when the lead names the place (`delegate-task --thread <key>` for a Slack thread, new `--conversation <id>` for the Crewly chat) and you asked there within the last 2 hours; otherwise the result goes back to the lead as an internal message and nothing is posted to you. When work you did ask for finishes and nobody tells you, Crewly nudges the agent once to write it in plain words, and only 30 minutes later posts one line itself, in your language, naming what was done and nothing else ("Ella 做完了排期里 5 张卡的文案和教程页的录屏，细节稍后补在这里。— 由 Crewly 代发"): no ids, links, file names, sizes or result dumps. See `specs/2026-10-04-tl-delegation.md` §1a.
- **A promise follow-up now uses the agent's own estimate, in Chinese too (crewly#1360).** "预计一小时左右", "两小时", "三十分钟", "半天", "一天", "一两个小时", "1.5 到 2 小时" and "40 到 60 分钟" (a range → its upper bound; 左右 / 大约 / 约 / 大概 change nothing) now date the follow-up instead of falling to the 24 h default. The estimate may sit in the sentence next to the promise, or in the agent's next post in the same thread within 10 minutes ("改完发你。" then "预计一小时左右。"), which moves the follow-up's due time. A promise that names no time at all, made live in your conversation, is now due in **4 hours**, not 24; the backfill of old history keeps 24 h.
- **After a restart, the handover says what the restart killed (crewly#1361).** A sub-agent (Claude Code Task / Agent tool) or a background or long-running command (a render, an encode, a build, `run_in_background`) that had not finished when Crewly restarted, or when a conversation was closed for size, died with it, but the handover carried the agent's last "still in progress" words and the resumed agent waited on it, in one case for 16 hours. The handover now opens with "## Interrupted by the restart" (what was running, that it is not running now, restart it or report it lost; at most 5 items, 200 characters each) and repeats them under "Open work".
- Boot restore no longer reads a healthy small machine as memory-tight: the free floor is capped at 20% of physical memory, and swap fill alone no longer holds agents back (macOS keeps a small swap file near full). The owner note names agents instead of session ids.

- **A restart no longer brings every agent back at once on a machine that is already swapping (crewly#1353).** On 2026-10-17 a 16 GB Mac froze (kernel watchdog panic) a minute after a Crewly restart: ten agents were relaunched back-to-back while memory was already tight, and the wiki, memory and work-record boot passes followed on fixed timers. Now the boot restore reads memory before every launch. When the machine is tight (pressure mode, swap at 80 % or more, or less than 3 GB free) only the agents you are waiting on come back, at most two at a time, each after the previous one has settled for 20 s and the reading has eased (an owner-waiting agent waits at most 10 minutes, then comes back anyway); every other agent is kept for later and returns as soon as memory eases, held for at most an hour, never dropped. Even on a calm machine launches are now 15 s apart. The three boot maintenance passes wait until the restore is over and the machine is calm (checked every 30 s, at most 30 minutes, then they run with a smaller batch: 50 work records instead of 200), and a vault log over 10 MB is rotated without being read whole. If agents were still held back 10 minutes after the restart you get one Slack line naming them. Tuning: `CREWLY_BOOT_PRESSURE_SWAP_PERCENT`, `CREWLY_BOOT_PRESSURE_MIN_FREE_MB`, `CREWLY_RESTORE_LAUNCH_SPACING_MS`. See `specs/2026-10-02-restart-busy-and-resume.md` §5.

- **Answering an agent's question on its card now settles the work.** When an agent finished something and asked "have a look, is it right?", answering on the decision card left the request waiting on you for up to 24 hours (only a typed reply in the thread counted). A card answer after the agent's answer now counts the same way; "打回" on the card still sends it back.
- **"Where is it now" no longer blames you for an agent's follow-up.** A request waiting on a follow-up an agent promised ("I'll send v2 tonight") showed "waiting on you". It now shows the agent that owes it and since when; it says "waiting on you" only when every owed item is a question to you.
- **Handing work on no longer closes the owner's request.** A reply like "@Pia please take this" was taken as the answer and the request closed in two minutes. Now a reply that @-mentions another agent is not the answer, and a request does not close while the agent who answered still has unanswered asks out to teammates.
- **Your messages no longer wait behind reminders when an agent is busy.** When an agent was
  mid-task, your message (or your answer on its decision card) joined the back of its queue and
  was handed over one per pause, oldest first — on 10-05 your answer to Atlas's card sat 7th, behind
  stale reminders, for ~18 minutes. Now your messages go to the front of the queue (in the order
  you sent them) and are never dropped except as an exact second copy; a queued colleague
  message or reminder is dropped once the agent has already answered in that thread, and a "promised work is ready"
  reminder is replaced by a newer one for the same ticket. A card answer the agent has not replied
  to is now followed up (a reminder to the agent, then a note to you) instead of going unwatched,
  and pending follow-ups survive a restart. Slack messages that arrive while Crewly is still
  starting are kept and delivered once routing is up, instead of being lost.

- **Security follow-ups to the owner-auth change (#1012).** Spec:
  `specs/2026-10-03-security-followups-1012.md`.
  - `POST /api/sessions` opened a terminal with any command for any local caller. It is now
    owner-only, and so are writing to, closing and answering the OAuth prompt of a session
    there. Agents still message each other through `/api/terminal`. A precedence bug that turned
    any explicit `command` into `powershell.exe` is fixed.
  - Settings: saving one API key on the API Keys tab replaced every other saved key with its
    mask (`••••••••abcd`). Masked values are no longer saved. Settings writes (save, reset,
    import, export) are owner-only, and their responses mask keys; `PUT {}` used to print every
    key. The `transcribe-audio` and `screenshot-compare` skills read their key from the new
    `GET /api/settings/api-key/:provider` with the agent badge, instead of the masked settings.
  - A chat post without an agent header was stored as your own words, which the WhatsApp
    「发 Wn」 gate and the approval guard trust. Chat writes now need your credential (dashboard,
    phone, API token) or an identified agent; agents are always stored as themselves.

- **An agent can no longer be "approved" by text the owner never sent (2026-10-03).** Claude
  Code's prompt suggestion — a faint prediction of the owner's next message — was accepted by
  the Tab Crewly pressed before every delivery and in its stuck-message recovery, and submitted
  as if the owner had typed it; an agent then posted on LinkedIn as the owner. Crewly now types
  only into an empty input box and presses Enter only when the box holds exactly its own text
  (never Tab, no blind backup Enter); prompt suggestions are switched off for Claude Code and
  Gemini; prompts say approval comes only from a harness-delivered owner message or a decision
  card (`ask-owner --status D-n`); posting on LinkedIn, X, Gmail web and other social or
  messaging sites (Post/Reply/Comment, Enter, Ctrl/Cmd+Enter, acting scripts, unnamed clicks) is
  held for an owner card that shows the text; a message the guard holds back is retried and the
  owner told if the agent's input stays blocked; unsolicited turns and every browser action are
  traced. See
  `specs/2026-10-03-phantom-owner-input.md`.
- **Chat shows the newest messages again, and "load older" reaches the whole history (#1000).**
  `GET /api/chat/messages` was returning the *oldest* messages of a conversation (and at most
  100 of them, whatever `limit` said), so long conversations opened at their beginning and
  scrolling up for older messages never got anywhere. It now returns the newest `limit`
  messages (default 200, max 1000) in chronological order; `before` returns the messages
  immediately preceding a timestamp or message id, `after` bounds the window from below, and
  `senderType` / `contentType` filters still fill a whole page. Message counts (`totalCount`,
  `hasMore`) with filters are accurate too.
- **Chat channel creation no longer misreports database conflicts as "agent already bound"
  (#1001).** Agents can hold any number of active chat channels, but `ChannelStore.create`
  still turned any UNIQUE error (e.g. a duplicate channel id) into a 409
  `agent_already_bound` whenever the agent had an active channel. The real constraint error
  is now surfaced, and the unreachable `agent_already_bound` code is removed from the backend.
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
