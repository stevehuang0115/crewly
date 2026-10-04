# Crewly Apps P3 (OSS): signed open-link cards, link management, public-app requests, visitor wakes (2026-10-04)

Issue: #1048 · Epic: #1045 · Builds on P2 (`specs/2026-10-04-crewly-apps-p2.md`).
Cloud side: crewly-services `apps` service (open-links, visibility request /
make-private, the `visitor` actor in the change feed; crewly-services #33).
This document is the OSS side; Cloud is mocked in every OSS test.

> This file was re-created from PR #1054 and the code after the security
> review (it had not been committed: `specs/` is gitignored, so it is added
> with `git add -f`). §3 (visitor wakes), §4 (data sanitising) and §5 (Cloud
> contract changes from crewly-services #33) carry the review fixes.

## Why

P2's `--notify` card links to the plain `https://apps.crewlyai.com/<appId>`.
Slack's in-app browser has its own cookie jar, so the owner hits "Sign in
with Crewly" on every tap. P3 puts a signed one-tap open-link in the card,
lets agents manage those links, lets an agent **ask** the owner to make an
app public, and wakes the publisher for anonymous submissions on a public app.

## 1. Signed card (the backend mints it; agents never see it)

- `--notify`, `--share` and an agent's public request mint a fresh link
  (`POST <cloud>/apps/:id/open-links`, body `{}` or `{ ttlDays }`; Cloud's
  default is 7 days). The answer is checked (`usableMintedLink`): it must be
  exactly `https://apps.crewlyai.com/<appId>?k=<token>` with a `linkId`
  matching `[A-Za-z0-9_-]{1,64}`. Anything else counts as a failed mint.
- **Destination rule.** The signed card goes **only to the agent's DM with
  the owner** (`AppCardPoster.ownerDm` → `postToOwnerDm`), written straight
  into that conversation with no resolver and no fallback. The DM is the only
  place that is owner-only by construction: rooms, team channels and
  cross-machine shared rooms are mirrored to Slack channels whose human
  membership the OSS does not track.
- In three cases the card carries the **plain** URL and goes through
  `deliverReply` as in P2: the agent has no DM; the mint fails or returns an
  unusable link; the DM refuses the card (the minted link is revoked first).
- Agents get the plain URL, `card` (`signed` | `plain`), `cardPlace`
  (`owner-dm` | `conversation`), `linkId`, `linkExpiresAt`, and a soft
  `linkError` / `notifyError`. Never the signed URL. Redaction, belt and
  braces: the controller redacts responses and errors; `LoggerService`
  redacts every log line; the Slack thread/channel context and the chat-v2
  recent-turns context shown to agents are redacted; the DM post skips the
  run trace.
- An owner call (no agent session) posts the card as the app's recorded agent.

### Re-share and link management

| Method | Path | Does |
|---|---|---|
| POST | `/api/apps/:appId/share` `{ ttlDays? }` (1-30) | fresh link, card to the owner, no publish |
| GET | `/api/apps/:appId/links` | links without tokens (`linkId, active, uses, createdAt, expiresAt, lastUsedAt, revokedAt, createdBy`) |
| DELETE | `/api/apps/:appId/links/:linkId` | revoke one |
| DELETE | `/api/apps/:appId/links` | revoke all |

Same `ownerOrVerifiedAgent` gate and publisher-only rule as P2's management
routes. Skill: `publish-app --app <id> --share [--ttl-days N] | --links |
--revoke-link <id> | --revoke-links`.

## 2. Public apps — requested only

- `--public --public-read a,b --public-submit c [--public-note …]`, with
  `--app` or on a publish, calls `POST /api/apps/:appId/visibility-request`
  (`POST <cloud>/apps/:id/visibility-request`). Collection names use the P2
  regex, at most 20 per list, at least one collection overall; the note is at
  most 500 characters.
- Output: "Requested: the owner approves it by opening the app." The card
  gains a line telling the owner a request is pending.
- `--cancel-public` (`DELETE …/visibility-request`) and `--private`
  (`POST …/make-private`, instant) are always available.
- **There is no path that makes an app public.** A route test asserts none
  exists. Cloud changes visibility only from the owner's own session in the
  apps shell — and, since crewly-services #33, only after the owner
  **re-authenticates with Google** there (§5).
- **Names.** A public request (`--public` on a publish, or on `--app`) is
  refused by the OSS with 400 `validation` when the app name contains a word
  Cloud refuses at approval (§5). The check runs before the app is created or
  a version is uploaded, so a refused publish leaves nothing behind.

## 3. Visitor wakes

`actor.kind === 'visitor'` data changes (anonymous submissions on a public
app; a visitor can only add data — any other visitor change is ignored) are
told to the publisher with the same batch window and cooldown as the owner's
changes. They are listed apart under "Anonymous submissions from public
visitors (N)" with a strong UNTRUSTED label. Agent writes are still skipped,
and all P2 sanitising still applies. Two limits (security review, MEDIUM):

### 3a. A visitor never starts a stopped agent

- A batch for (app, publisher) that holds **only** visitor submissions is
  delivered with `activate: false`, and only while the publisher is running.
- If the publisher is stopped, the batch **stays pending** until it runs: it
  is re-checked every `VISITOR_WAKE.PENDING_RECHECK_MS` (60 s), without
  counting as a delivery failure (no retry backoff, no orchestrator notice).
  While it waits the persisted cursor stays before its first change (as for
  any pending batch), so a restart re-reads it rather than losing it.
- Why pending rather than a notice to the orchestrator: anyone on the
  internet can submit, so every route that turns a submission into an LLM
  turn is an amplification path; a pending batch costs nothing, and the
  publisher reads the submissions as soon as it runs (they are already in the
  app's data). The orchestrator only hears about visitors when the app has no
  recorded publisher (then it is the recipient, as in P2).
- An **owner** change joining the batch restores P2 behaviour: the batch is
  delivered with `activate: true` and may start the publisher, visitor
  submissions included.

### 3b. Daily cap on visitor-triggered wakes

- At most `VISITOR_WAKE.MAX_PER_DAY` (20) visitor-triggered wakes per app per
  UTC day. A delivered message counts when it contains visitor submissions
  (or is the skipped-notice below).
- Persisted per app in the registry as
  `visitorWakes: { day: 'YYYY-MM-DD', count, skipped }`, like `wakes`, so a
  restart does not reset it. A new UTC day resets `count`, not `skipped`.
- Past the cap, visitor submissions are **counted** (`skipped++`), not
  batched; their seqs are recorded as handled (`delivered`), so the cursor
  moves past them and a restart does not count them twice.
- The **next message delivered** for the app to the publisher (an owner
  change the same day, or a visitor wake the next day) states
  `Skipped: N anonymous visitor submission(s) were not sent to you, because
  this app reached its limit of 20 visitor wakes per UTC day. They are stored
  in the app.` Then `skipped` returns to 0.
- On a new UTC day with `skipped > 0` and nothing else pending, the poller
  opens a notice-only batch, so the agent hears about them even if no new
  submission arrives. It follows §3a (waits while the publisher is stopped).

## 4. App data returned to agents is sanitised (security review, HIGH)

`/api/apps/:appId/data…` (list / get / set / update / add / delete) answers
are passed through `sanitizeAppData` in `AppsService` **before** they leave
the backend, so no skill or caller can bypass it. Documents are written by
the owner, other agents or anonymous visitors, and an agent prints them into
its terminal, where the harness extractors (`[CHAT_RESPONSE]…[/CHAT_RESPONSE]`,
`[RESPONSE]`, fenced `response` blocks; `types/chat.types.ts`) and the PTY
would act on them.

- Every **string value and object key**, recursively, goes through
  `sanitizeAppDataString`: ANSI escapes, C0 controls except tab and newline,
  DEL, C1 controls and bidi / zero-width characters removed (CR and CRLF
  become a newline); P2's `neutralizeMarkers` applied (a `[` that opens a tag
  becomes `［`, runs of three or more backticks become `'`).
- Structure is kept: numbers, booleans, null, arrays and nesting are
  unchanged. Two keys that clean to the same text both survive (`a`, `a (2)`).
  `__proto__` stays a plain data key (`Object.fromEntries`). Nesting deeper
  than `DATA_SANITIZE.MAX_DEPTH` (32) becomes a note string.
- **Length.** Unlike P2's 500-character cap for wake text, data is not
  truncated in normal use: a single string is cut only past
  `DATA_SANITIZE.MAX_STRING_CHARS` (65,536 characters — far above anything a
  form field holds; P1 documents are ≤ 256 KB in total), with a visible
  `… (cut: N more characters not shown)`. It exists only to bound one
  pathological value.
- The result is a display copy; the stored document is unchanged.
  `app-data/SKILL.md` says so, warns against writing a read value straight
  back, and keeps saying the raw data is untrusted.

## 5. Cloud contract changes (crewly-services #33)

- **Approval needs a fresh Google sign-in.** Approving a public app requires
  the owner to re-authenticate with Google in the apps shell. A Crewly login
  or token is not enough. (Docs only on the OSS side.)
- **New versions pause public apps.** Publishing a new version of, or
  rolling back, a **public** app reverts it to private with a pending
  re-approval request; the owner re-approves in the shell.
  - `publish`: the app is read before the upload anyway; when it was
    `public`, the backend reads `GET /apps/:id` once more after the upload.
    If it is now `visibility: 'private'` with `publicRequest` set, the result
    has `publicPaused: true` and `publicPausedMessage`.
  - `rollback`: the app is read before the rollback; if it was public and the
    rollback answer (or, when that lacks `visibility`, a follow-up read) is
    private with a pending request, the same two fields are added.
  - The `publish-app` skill prints `"publicPaused": true` with the message
    (`publicPausedMessage` on a publish, `message` on a rollback) telling the
    agent the owner must re-approve.
- **Name words.** Public app names and owner display names may not contain
  `crewly`, `sign in`, `sign-in`, `login`, `log in`, `password`, `verify`,
  `account`, `security`, `support`; approval returns 400 `validation`
  otherwise. The OSS refuses `--public` early (§2) with
  `A public app's name may not contain "<word>" …`: single words match as
  case-insensitive substrings, `sign in` / `sign-in` / `log in` as whole words
  with a space, hyphen, underscore or nothing between. The owner's display
  name is not known to the OSS; the SKILL.md mentions it.

## Contract assumptions (OSS ↔ Cloud)

- New endpoints use P1's `{ success, data }` envelope and
  `{ success:false, error, code }` errors.
- `POST open-links` accepts `{}` (Cloud default 7 days).
- The token is in `k`; the URL is exactly
  `https://apps.crewlyai.com/<appId>?k=<token>`; the token has no whitespace
  and none of `()[]<>|`.
- `createdBy` may be a string or an actor object.
- `DELETE visibility-request` and `make-private` answer `{ visibility }`; the
  OSS tolerates other shapes.
- `GET /apps/:id` includes `visibility` and `publicRequest`.

## Tests

Jest, HTTP mocked, `--maxWorkers=2`: open-link helpers; apps service (cards,
share, links, public requests, name words, `publicPaused` on publish and
rollback, data sanitising on every data call); controller (gate, redaction,
visitor documents neutralised on the list and get routes through the real
service); wake service (visitor-only batch waits for a stopped publisher and
is delivered with `activate:false` once it runs; owner change restores
`activate:true`; daily cap, skipped count in the next message, next-day
notice, no double count after a restart); registry (`visitorWakes`
persisted, kept by `upsert`); wake message (skipped line). Skills:
`publish-app/execute.test.sh` (incl. `publicPaused`, refused name) and
`app-data/execute.test.sh`.
