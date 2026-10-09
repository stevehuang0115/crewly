# Drive mode — phase 1 (2026-10-08)

A hands-free voice conversation on the phone (Cloud Portal → Talk → **Drive mode**).
The owner hears everything waiting on them across agents, one item at a time,
answers by voice, interrupts at any moment, and says "next" / "continue".
Not only for driving: any time the owner cannot look at a screen.

## 1. Pieces

```
phone (portal Talk page)
  ├─ mic 16 kHz PCM ──► Gemini Live (wss, ephemeral token) ──► 24 kHz PCM audio ─► speaker
  │                      │ toolCall get_next_item / answer_item / …
  │◄─────────────────────┘
  └─ relay api_request ──► this machine: /api/briefing/*, /api/talk/live-token
```

- **Voice layer:** Gemini Live API, model `gemini-3.8-live` (stable, native
  audio, built-in VAD / barge-in). Override with `CREWLY_GEMINI_LIVE_MODEL`.
- **Key:** the Gemini API key Crewly already stores for Antigravity
  (`harness-credentials.json` → `antigravity.geminiApiKey`), else
  `GEMINI_API_KEY`. It never leaves the machine.
- **Token:** `POST https://generativelanguage.googleapis.com/v1alpha/auth_tokens`
  (`x-goog-api-key`), body `{ uses: 1, expireTime: +30 min, newSessionExpireTime: +1 min,
  bidiGenerateContentSetup: <setup>, fieldMask: <setup's fields> }`. The setup
  (model, audio output + voice, system instruction, the five briefing tools,
  input/output transcription) is locked by the token; `sessionResumption` is
  left open so a dropped session can resume. API version override:
  `CREWLY_GEMINI_LIVE_API_VERSION`. The page connects to
  `wss://…/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=<token>`.

## 2. Briefing queue (`/api/briefing`, owner only)

`GET /api/briefing` → `{ items, lookupsPending, hidden, generatedAt }`.

Sources (this machine):

| kind | what | answer goes to |
|---|---|---|
| `decision` | open / parked decision cards; a card whose "remind me" time came | DecisionService (`chooseFromDashboard` / new `answerInWords`, via `voice`) |
| `question` | a question from an agent's reply that never became a card (Request open item, has `chatRef`) | that conversation: an owner turn recorded like a Talk message (`source: cloud-talk`, `inputMode: voice`), ticket intake, dispatched |
| `review` | ticket in 待验收 | TicketReviewService: `accept` = verify, `send_back` + reason = reject |

Order: urgency (`high`: deadline < 2 h, parked, reminder due, answered lookup;
`normal`: other cards / questions, tickets auto-accepting within 6 h; `low`:
other tickets), then the longest wait. Each item has `summary` (one
speakable line, no URLs / markdown), `details` (plain text for follow-ups),
`options`, `sensitive`, `answerTarget`.

Actions (all `POST /api/briefing/:id/…`, id URL-encoded, e.g. `d%3AD-7`):

- `answer` `{ optionKey?, text?, confirm?, confirmToken? }`
- `skip` `{ dismiss? }` — "next": hidden 6 h, nothing settled. `dismiss: true`
  = "I don't care anymore" (card skipped / open item skipped; not for tickets).
- `later` `{ at? }` — hidden until `at` (≤ 30 days) or tomorrow 09:00 local;
  comes back first, flagged `reminder`. A card is also snoozed on Slack.
- `ask` `{ question }` — the follow-up goes to the waiting agent (questions:
  into the same conversation, verbatim; cards / tickets: the agent's DM with
  a one-line context). The item leaves the queue (`lookupsPending`) until the
  agent replies there, then returns first with `lookupAnswer`. Given up after 24 h.

State (hidden-until, pending lookup, answered-by-voice) lives in
`<CREWLY_HOME>/briefing-state.json` (0600) and is pruned when items disappear.
Answers are never logged or stored; the follow-up question is stored while
it is pending.

### Spoken confirmation

An item is sensitive when its card is `email` / `publish` / `deploy` /
`spend` / `browser_action` / `app_access`, or its text mentions deploy /
publish / delete / pay / send email / 部署 / 删除 / 付款 …. The first
`answer` returns `needs_confirmation` with a one-time token (3 min) and a
`confirmQuestion`; only a second call with the **same** answer,
`confirm: true` and the token acts. The system instruction tells the model to
ask "确认吗？" and wait for a clear yes; the API enforces it either way.

## 3. Voice token (`/api/talk/live-token`, owner only)

- `GET /status` → `{ hasKey, model }`
- `POST /` `{ language?: zh|en|es }` → `{ token, wsUrl, model, apiVersion, setup, expireTime, newSessionExpireTime, language }`
- No key → `409 no_gemini_key` ("Add a Gemini API key in Settings…").
  Google refusal → `502 google_rejected` (status word only); network → `502 unreachable`.

## 4. Relay

`MOBILE_API_ALLOWLIST`: `GET /briefing` (exact), `POST /briefing/:id/answer|skip|later|ask`
(suffix entries), `GET /talk/live-token/status` (exact), `POST /talk/live-token` (exact).

## 5. Portal (crewly-web)

Talk page → big **Drive mode** button → full-screen view: current item,
speaking / listening indicator, big Pause and End, minutes used. Mic via
`getUserMedia` (echo cancellation, noise suppression), 16 kHz PCM to Live;
24 kHz PCM playback, stopped at once on `serverContent.interrupted`; Wake
Lock; reconnect on drop (new token + resumption handle). Tool calls go to
the machine over the relay and the result goes back as `toolResponse`.

## 6. Not in phase 1

- Several machines in one briefing (phase 1 briefs one machine, picked on the page).
- Decisions answered by voice are not echoed into the Slack card thread as text (the card itself updates).
- Answers in a Slack-thread conversation are recorded in chat-v2 and dispatched, not posted to Slack as the owner.

## 7. Phase 2 — Drive mode as the owner's voice channel, hosted on Crewly Cloud (2026-10-08 evening)

The owner's first phone test: "smooth and fun", but (1) tiny sounds interrupted the
voice and (2) it read mostly stale decision cards. Owner direction: Drive mode is
his own conversation channel with the agents, run by a voice orchestrator, and it
must not depend on one Mac being reachable (that night the Mac's outbound
connections hung and the machine-hosted token could not be minted).

### 7.1 Voice
- VAD is locked into the token's setup (`realtimeInputConfig.automaticActivityDetection`):
  `START_SENSITIVITY_LOW`, `END_SENSITIVITY_LOW`, `prefixPaddingMs: 300`,
  `silenceDurationMs: 800`, `activityHandling: START_OF_ACTIVITY_INTERRUPTS`.
  Field mask: objects one level down, `tools` and `realtimeInputConfig` by
  their top-level key.
- The portal also gates barge-in: while the voice speaks, mic audio is held
  back unless its RMS stays above a level for ~250 ms (echo cancellation and
  noise suppression stay on).

### 7.2 Hosting
Crewly Cloud (Pro) hosts the session (crewly-services `auth/specs/2026-10-08-drive-mode-cloud.md`):
token minting with the Cloud key, targets from every machine's roster, routing,
the reply inbox, recall and the end. `/api/talk/live-token` on the machine stays
as a fallback with the same setup.

### 7.3 Machine side (this repo)
- `DriveAgentService` takes `talk_message {kind:'drive'}` pushes (ids only), and
  fetches every detail from Cloud with this machine's token:
  - `deliver`: the owner's words are recorded as an owner voice turn
    (`metadata.via: 'drive-mode'`) in the agent's DM, the team lead's DM (team
    target) or a thread of the team channel's room, and dispatched with a note:
    the owner is listening, answer with `reply --drive <session>`, short, no
    URLs, not in Slack.
  - `recall`: the agent's recent messages to the owner (DMs and the threads
    the owner is in, last 3 days), best match to the hint first.
  - `end`: each open conversation's agent is asked for ONE recap.
- `reply --drive <session> "<text>"` (`--interim`, `--recap`): recorded in the
  conversation (Drive rows are never mirrored to Slack) and sent to Cloud. A
  plain `reply` in a waiting Drive conversation is picked up too.
- Recap: posted where the conversation belongs (the agent's DM with the owner,
  or the channel, in Slack too); it closes the conversation — owner-message
  tracking stops, and open items: a recap that says "nothing pending" delivers
  the agent's open promises; one that names a next step is read like any reply.
  Spoken Drive answers open no items.
- Capability `drive_message` is advertised to Cloud while the handler runs.

### 7.4 Waiting items (on request only)
The briefing queue is read only when the owner asks. It lists live items
only: cards past their deadline (+24 h) or older than 7 days, near-duplicates
from the same asker, and cards / reply questions the owner already answered in
their conversation are left out.
