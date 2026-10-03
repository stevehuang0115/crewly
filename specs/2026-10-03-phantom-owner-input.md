# Phantom owner input — the harness never submits text it did not write

Status: implemented (branch `fix/phantom-owner-input`)
Incident: 2026-10-03, the Air machine, crewly 1.20.195

## What happened

1. 01:44Z — the owner wrote "linkedin有人回复了" with no @ in the shared Slack
   room `#crewly-marketing` (the Mac's team channel). The Mac's Marketing Ella
   and the Air's Personal Assistant Ella both took it ("every awake agent
   decides"). The Air's orchestrator also routed it to the Air's Ella.
2. The Air's Ella read LinkedIn through the remote browser, drafted a reply
   and asked decision card D-11 ("reply with this draft, or different
   wording?"). Its draft never reached the owner: its post into the Mac's
   room failed and the failure was only logged.
3. ~10 minutes later the owner-message watchdog re-delivered the owner's
   message to Ella as a reminder. The input box already held
   "按这个草稿回吧" ("go ahead with this draft") — Claude Code's **prompt
   suggestion**, a faint prediction of the user's next message.
4. Ella took that line as the owner's approval and posted the reply on
   LinkedIn as the owner (~01:56Z). The owner answered D-11 at 02:04.

## Mechanism (confirmed)

Claude Code (verified in the 2.1.288 binary) shows a prompt suggestion in an
empty input box when the assistant is idle. It is painted faint. **Tab
accepts it** (`acceptMethod: "tab"`); a prompt submitted from an accepted
suggestion is recorded as `promptSource: "suggestion_accepted"`, which Claude
Code classifies as user input. It can be disabled with
`CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` (read first) or the setting
`promptSuggestionEnabled: false`.

Crewly pressed Tab into agent sessions in several places:

- `sendMessageWithRetry` pressed **Tab before every Claude Code delivery**
  ("restore Ink focus"). Into an empty box with a suggestion, Tab accepted
  it, the delivery was pasted after it, and Enter submitted both — the
  watchdog reminder went in as `按这个草稿回吧<reminder>`.
- Stuck-message recovery (per delivery and the 30 s background scanner)
  pressed Tab + Enter + a backup Enter whenever our text was visible near the
  bottom of the screen — usually just the transcript echo of a message
  already submitted, with an empty box (and a suggestion) below it.
- Gemini paths pressed Tab/Enter before every delivery; terminal-controller,
  cloud relay and others sent a blind "backup" Enter.

The screen capture is plain text, so faint ghost text and typed text looked
the same to every check.

## Rules

1. **Never press Tab or Enter unless the harness's own text is in the input
   box.** Every harness write goes through `SessionCommandHelper.sendMessage`:
   - The box is found per runtime layout, built from real captures
     (`backend/src/services/session/__fixtures__/tui/`, Claude Code 2.1.288
     and Codex 0.160.0 recorded in a PTY through headless xterm):
     Claude Code — between the two `────` rules, prompt `❯` + U+00A0, the
     transcript's `❯ text` echoes ignored; Codex — the bottom-most `›` line
     at column 0 down to the terminal cursor, blank lines included; Gemini —
     the `╭╮│╰╯` box; Antigravity — ruled box with `>`.
   - Before typing, the box must be empty (faint ghost text counts as
     empty). Leftover text is cleared with Ctrl+U until it reads empty, the
     budget scaling with its lines (Codex needs two presses per line). A box
     that stops being readable is not "cleared". If it will not clear,
     nothing is typed (`TuiInputGuardError` before-write).
   - The message is pasted without Enter. Enter is pressed only when the box
     holds exactly the message — after our paste into a box proven empty,
     any part of it, or the lone "[Pasted text …]" marker. Otherwise the box
     is cleared and nothing is submitted (before-submit).
   - No box of a known layout on screen (a shell): sent as before (paste,
     one Enter). Gemini and Antigravity were not verified live: an unsure
     reading falls back to that old path rather than blocking delivery.
   - Recovery paths call `submitIfInputIsOurs` — Enter only for our text,
     never Tab, never a blind backup Enter. The background scanner never
     marks an entry recovered on an unreadable box; our text behind foreign
     text is cleared and delivered again.
   - Clear key: Ctrl+U. Not Escape (cancels a running Claude Code turn;
     twice opens Rewind) and not Ctrl+C (twice exits).
2. **Prompt suggestions are off** for every runtime Crewly launches: Claude
   Code via env `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` and
   `promptSuggestionEnabled: false` in the control-plane `--settings` file;
   Gemini via `general.enablePromptCompletion: false` in the project's
   `.gemini/settings.json`. Codex has no feature that fills its composer.
3. **Approval comes only through the harness.** `DecisionRightsModule` (every
   agent and the orchestrator; copied verbatim into the orchestrator and team
   lead `prompt.md`) and the outbound skill docs say: only an owner message
   the harness delivered (`[CHAT:…]`/`[GCHAT:…]`/`[SLACK…]` header, from the
   owner) or the owner's decision-card answer is approval; text in the input
   without the envelope never is. `ask-owner --status D-n` reads a card.
4. **Outbound browser actions are held for an owner card**
   (`browser-outbound-guard.ts`), without holding reading:
   - descriptors are split into words at punctuation (`__submit-button` →
     "submit button"), never at camelCase (code identifiers);
   - a control whose whole label is Reply/Comment/Post/Send/Tweet (plus
     Share/Connect/Invite on social sites), X's `tweetButton`, and
     "submit/post comment|reply" style names; not bare "comment"/"tweet"
     (a comment item, a tweet being read);
   - every submitting key (Enter/Return, Ctrl/Cmd+Enter, modifiers array) and
     typed text with a newline or a submit flag;
   - page scripts that act AND send a writing request (non-GET) or name a
     submit control — "See more" scripts and read-only fetches pass;
   - on social and messaging sites, clicks that name no control
     (coordinates, refs);
   - the card shows the text the agent typed ("Text it would post as you");
     never for password/code fields;
   - an approval admits only the approved action (fingerprint), once; a read
     in between does not spend it; a held action never approves itself
     (timeout = No);
   - calls without `X-Agent-Session` cannot take irreversible actions (403);
     approving a hold and taking control are owner-only (#999 `ownerOnly`),
     so an agent cannot approve its own hold.
5. **One machine owns an un-@'d message in a shared room**
   (`SlackTeamChannelService.defersToAnotherMachine`). Every machine applies
   the same rule to Cloud's room presence, so they agree: the home machine
   when Cloud names it (`room.home`, optional, from heartbeat
   `teams[].channelId`), else the lowest instance id among machines with an
   awake room member. Deferred owner messages keep the 90 s unanswered
   watch, so a message never ends with no machine on it. The orchestrator's
   fall-through does not pick up a message another machine owns.
6. **Tracing.** A Claude Code `UserPromptSubmit` with no harness write since
   the last submitted prompt is recorded as `turn.unsolicited`. Every agent
   browser action is recorded (`skill.call` / `guard.block`, host and target,
   typed text only as a length). Both go to the session's current trace,
   else its last trace, else a new `unsolicited` trace.

## Known gaps

- Without Cloud's `room.home`, the tie-break may pick the machine that
  joined the room ad hoc rather than the room's home (still exactly one).
  Another machine's answer is not forwarded here, so the deferred machine's
  90 s fallback can still wake its lead after the owner was answered.
- Claude Code's prompt suggestion itself could not be triggered live (it is
  server-gated); it uses the same faint style as the captured placeholder.
- The draft's failed post into another machine's room is surfaced by
  #962 (agent reply awaits the Slack post and fails loudly); not duplicated
  here.
- `POST /api/orchestrator/messages/enter` (no caller in the repo) and the
  legacy tmux service still press Enter blindly; `/compact` and `/login`
  command typing is unguarded (typed text replaces ghost text).
- `--chrome` (claude-in-chrome MCP) and computer-use drive the browser
  outside `/api/browser`; they are covered only by the prompt rule.
