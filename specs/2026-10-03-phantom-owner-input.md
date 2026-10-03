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
   box, and never wipe text the harness cannot prove is its own.** Every
   harness write to an agent goes through `SessionCommandHelper.sendMessage`:
   - The box is found per runtime layout, built from real captures
     (`backend/src/services/session/__fixtures__/tui/`: Claude Code 2.1.288,
     Codex 0.160.0 and Gemini 0.40.1 recorded in a PTY through headless
     xterm): Claude Code — between the two `────` rules, prompt `❯` +
     U+00A0, transcript echoes ignored; Codex — the bottom-most `›` line at
     column 0 down to the terminal cursor, blank lines included; Gemini
     0.40.1 — between a `▄▄▄` and a `▀▀▀` line, its solid-grey
     `Type your message or @path/to/file` read as empty. Antigravity's ruled
     box and the older Gemini `╭│╰` box were not verified live.
   - Before typing, the box must be readable and empty (faint ghost text
     counts as empty). An exact copy of this very message (an earlier
     attempt) is cleared; anything else — someone's half-typed text, an
     unreadable screen such as an API-key dialog — is left untouched and
     nothing is typed.
   - The message is pasted without Enter. Enter is pressed only when the box
     holds exactly the message — right after our paste into a box proven
     empty, also any visible part of it or the lone "[Pasted text …]"
     marker. Otherwise nothing is submitted and nothing is cleared.
   - A refusal never drops the message: agent delivery puts it back on the
     agent's queue (`[INPUT_NOT_OURS]`); `InputBlockedRetryService` retries it
     on a timer while the agent is idle (15 s → 2 min backoff) and, after
     5 min or 5 refusals, tells the owner once — in the chat the message came
     from and through the orchestrator (the owner directly over Slack when
     the orchestrator itself is blocked). The notice says what kind of
     content blocks the box ("N characters of text not written by Crewly",
     "an unreadable screen") — never the text, which may be a password or a
     code. Nothing expires silently: the queue reports its 6 h age-out, its
     50-message cap, and messages whose sends kept failing or throwing
     (re-queued up to 5 attempts first); a runtime exit keeps the queue
     instead of clearing it. An agent stopped on purpose (Stop, stop-team,
     the stop-member API) is not relaunched by the queued-message wake-up:
     its queue is held until someone starts it. When the orchestrator itself
     is the blocked agent, the notice goes to the owner over Slack and, if
     Slack is not set up or the notice was not sent, into the orchestrator's
     own chat.
   - A long paste collapses to a marker ("[Pasted text #1 +29 lines]",
     "[Pasted Content 1449 chars]"). The exact marker seen right after the
     harness's own paste is recorded per session and counts as ours later,
     for whatever message is sent next, so a lost Enter is recovered: after
     every delivery the box is checked and, if our marker is still there,
     Enter is pressed once and the box re-checked (a fast-reply or
     weak-signal check had reported such deliveries as sent); the next
     delivery submits a leftover marker of ours before typing. The record
     cannot outlive our paste (an owner paste can produce the same marker —
     Claude Code's counter restarts at #1, Codex's marker is only a length):
     it is written only by `sendMessageWithRetry`'s delivery (the one path
     that checks the box afterwards), trusted for at most 2 minutes, and
     dropped on any readable box that does not show it, after our one Enter
     on it (submitted or stuck), and when the session is created or killed or
     a runtime is (re)launched in it (`sendShellLine`). Live repro
     through `sendMessageToAgent` on Claude Code 2.1.288 and Codex 0.160.0
     with the first Enter dropped: M1 submitted by the check, M2 delivered
     after it, each answered exactly once.
   - The background scanner never re-sends a message whose delivery was
     confirmed or that is already queued.
   - Clearing (only our own text): Ctrl+U then Backspace, re-reading after
     each pair, one pair per line plus a margin — verified live on all three
     runtimes (Ctrl+U alone stalls on Gemini's first empty line). Never Escape
     (cancels a running Claude Code turn; twice opens Rewind), never Ctrl+C.
   - Recovery calls `submitIfInputIsOurs` — Enter only for our text (an exact
     copy; a marker or a fragment is not proof later), never on an unreadable
     box. The background scanner never marks an entry recovered on an
     unreadable box; our text behind someone else's is left in place and the
     message re-queued, the entry marked recovered only once delivery has it.
   - Shell command lines typed before a runtime starts use `sendShellLine`
     (a shell has no input box). Gemini's blind "dismiss" Enters before
     `/directory add` are gone; a stuck command is submitted only when the box
     holds it.
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
   - the site is read from the tab's current URL (`getTabs`, bound tab), not
     the last navigate — the agent may have clicked its way there or work in
     a tab the owner opened;
   - submit controls by whole label (Send/Submit/Post/Reply/Comment/Tweet/
     Publish/Repost; Share/Connect/Invite on social sites) or by words in
     their selectors (split at punctuation, never camelCase): `…__submit-…`,
     `tweetButton`, `send-button`; pay/delete/confirm/sign;
   - every submitting key and newline-terminated typing;
   - scripts: a form submit (`requestSubmit()`, `form.submit()`) anywhere; a
     request that is not provably GET (`fetch` with any options argument —
     `method` may come from a variable — `sendBeacon`, a POST XHR); a click
     whose target's selector or label names a submit control. Words are read
     only in the selectors a script looks up, never in identifiers or text it
     writes (`x.send()` and a draft saying "Agree." are not controls);
   - on social and mail sites: clicks that name no control (coordinates,
     refs), and — once the agent has typed, script-written or pasted
     (Cmd/Ctrl+V) a draft there — every acting click, script, submit,
     request, or Space/Enter on a focused control in that site and tab until
     the owner approves (the Post button behind `#ember345`, Gmail's
     `div.T-I.J-J5-Ji.aoO`, `buttons[7].click()`). A search query (searchbox,
     type=search, role=searchbox, a name of q/query/search like Gmail's
     `input[name="q"]`, a combobox input — but not a contenteditable or
     textarea combobox, which is a compose box) is not a draft; the draft
     belongs to the page (host + path + hash) and tab it was typed on and
     ends when the tab moves to another page. With no bound tab, the site is
     read from the active tab in Crewly's own tab group (known from
     startup), never the owner's tab;
   - reading is not held: a tweet, a comment item, "See more" (including
     Reddit's `shreddit-post`), a read-only fetch or XHR;
   - the card shows the text the agent typed ("Text it would post as you");
     never for password/code fields;
   - an approval admits only the approved action (fingerprint), once; a read
     in between does not spend it; a held action never approves itself
     (timeout = No);
   - calls without `X-Agent-Session` cannot take irreversible actions (403);
     approving a hold and taking control are owner-only (#999 `ownerOnly`).
5. **Shared rooms** (two machines' "Ella"s both answering one un-@'d owner
   message): moved to a separate PR (see `specs/2026-10-03-shared-room-owner.md`
   there) together with crewly-services#29; room behaviour here is as on main.
6. **Tracing.** A Claude Code `UserPromptSubmit` with no harness write since
   the last submitted prompt is recorded as `turn.unsolicited`. Every agent
   browser action is recorded (`skill.call` / `guard.block`, host and target,
   typed text only as a length). Both go to the session's current trace,
   else its last trace, else a new `unsolicited` trace.

## Known gaps

- Claude Code's prompt suggestion itself could not be triggered live (it is
  server-gated); it uses the same faint style as the captured placeholder.
- Antigravity's input box was not verified live; an unreadable box means the
  message waits on the queue rather than being typed.
- The draft rule relies on the agent typing through `/api/browser`
  (`type`/`fill`/`insertText` or a script that writes text). `--chrome`
  (claude-in-chrome MCP) and computer-use bypass `/api/browser`; only the
  prompt rule covers them.
- The silent failure of a post into another machine's room is #962.
- `POST /api/orchestrator/messages/enter` (no caller) and the legacy tmux
  service still press Enter blindly.
