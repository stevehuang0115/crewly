# Onboarding: harness detection, install and login (Phase 1)

Status: implemented on `feat/onboarding-p1-backend` (backend + CLI). The web
setup page is built separately against the contract below.

## Goals

- **Two front ends, one engine.** Setup can be done entirely from the
  terminal (`crewly onboard`, `crewly login`, `crewly harness`) or entirely
  from the web app. Both call the same backend code in
  `backend/src/services/harness/`.
- Setup covers: detect harnesses, install the chosen one, choose the
  orchestrator's harness, and log in.
- **The owner is not at the machine.** Agents do the legwork; the owner
  only taps on a phone, and only when unavoidable. Nothing relies on a local
  browser or a localhost callback. Login URLs and codes are always exposed
  through the API (and printed by the CLI). The same routes work through the
  Cloud relay (portal / phone app).
- Harnesses: Claude Code (`claude-code`), Codex (`codex-cli`), Gemini CLI
  (`gemini-cli`, detect only). The ids equal the existing `RuntimeType`
  values. The default is Claude Code. First-time setup installs only the
  orchestrator's harness.
- The only system tool required is jq. tmux is not needed, because sessions
  use node-pty.

## Components

| File | Role |
|---|---|
| `harness.types.ts` | Contract types (`HarnessStatus`, `LoginSession`, `InstallJob`, …) and type guards |
| `harness-registry.ts` | Definitions: display name, binary, npm package, version args, login methods (broker command or API key) |
| `harness-exec.utils.ts` | Harness PATH (`~/.crewly/npm-global/bin` first, `~/.local/bin` appended), npm PATH (adds Node's bin dir), shell-free `runCommand` (secrets via stdin) |
| `harness-status.service.ts` | Installed? (PATH lookup + `--version`), latest (`npm view <pkg> version`, cached 1 h, failures cached 5 min), login state |
| `harness-install.service.ts` | `npm install -g <pkg>@latest` as an async job with a log. On EACCES/EPERM it retries once with `--prefix <crewlyHome>/npm-global`. One job per harness at a time: a second start returns the running job. |
| `harness-credentials.store.ts` | `<crewlyHome>/harness-credentials.json`, mode 0600, holds the Claude OAuth token or the Anthropic key. `harnessEnvForAgents()` provides the agent env. |
| `claude-config.utils.ts` | After a Crewly login, sets `hasCompletedOnboarding` and pre-approves an API key (last 20 chars) in `~/.claude.json`, so agent PTYs never stop at Claude's first-run or "use this key?" screens |
| `login-rules.ts` | Normalization, plus a regex rule set per harness method |
| `login-broker.service.ts` | Runs the login command in a PTY, applies the rules, and runs the state machine. It is an EventEmitter. |
| `harness-api-key.service.ts` | API-key login: checks and stores the Anthropic key; Codex goes through `codex login --with-api-key` over stdin |
| `orc-harness.store.ts` | Orchestrator runtime (`teams/orchestrator/config.json` `runtimeType`) + `settings.general.defaultRuntime` |
| `harness.service.ts` | Facade used by REST and CLI; `getHarnessService()` backend singleton, `createHarnessService()` for the CLI |
| `controllers/harness/*` | REST at `/api/harness` |
| `cli/src/utils/harness-engine.ts` | CLI's access: in-process service; login driver = backend REST when running, else in-process |
| `cli/src/commands/harness-setup.ts` | Shared CLI steps (detect → choose → install → record → login) |
| `cli/src/commands/harness.ts` | `crewly harness`, `crewly login <claude\|codex>` |
| `cli/src/commands/onboard.ts` | Web-or-terminal choice, then the steps above, skills, template |

## REST contract (`/api/harness`)

Every response is `{ success: true, data }` or `{ success: false, error, code? }`.

| Method & path | Body | `data` |
|---|---|---|
| `GET /api/harness` | – | `{ harnesses: (HarnessStatus & { reloginPending })[], orcHarness: string \| null, systemTools: [{ id: 'jq', installed, installHint }] }`. `reloginPending` was added in Phase 2 (see below). |
| `POST /api/harness/:id/install` | – | `{ jobId }` |
| `GET /api/harness/install/:jobId` | – | `{ jobId, harnessId, state: 'running'\|'succeeded'\|'failed', log, usedUserPrefix }` |
| `PUT /api/harness/orc` | `{ harnessId }` | `{ orcHarness }` |
| `POST /api/harness/orc` | `{ harnessId }` | same as PUT. This twin exists because the relay carries only GET and POST. |
| `POST /api/harness/:id/login` | `{ method: 'subscription'\|'device' }` | `LoginSession` (the harness's live session, if one exists) |
| `GET /api/harness/login/:sessionId` | – | `LoginSession` |
| `POST /api/harness/login/:sessionId/input` | `{ text }` | `LoginSession` |
| `POST /api/harness/login/:sessionId/cancel` | – | `LoginSession` |
| `POST /api/harness/:id/api-key` | `{ key }` | `HarnessStatus` (the key is never echoed) |

```ts
HarnessStatus = { id, displayName, installed, version: string|null, latestVersion: string|null,
  updateAvailable, loginState: 'logged_in'|'logged_out'|'unknown', loginSource: string|null,
  loginMethods: [{ id: 'subscription'|'api_key'|'device', label, kind: 'broker'|'api_key' }] }
LoginSession = { id, harnessId, method, state, url, userCode, needsInput, message, screen, startedAt, updatedAt }
```

`orcHarness` is `null` until something records it (a fresh machine). `GET`
never creates the orchestrator file.

Error codes map to HTTP statuses as follows:

- `unknown_harness`, `not_found`, `job_not_found` → 404
- `unsupported_method`, `unsupported`, `invalid_key` → 400
- `not_installed`, `not_active` → 409
- `login_failed` → 422
- `spawn_failed` → 500

**Owner-only.** These routes refuse any request with an `X-Agent-Session`
header (403), mirroring the tickets controller:

- install
- `orc` (PUT and POST)
- every `/login` route, including the GET
- `api-key`

`GET /api/harness` and `GET /install/:jobId` stay readable.

**Relay (phone / portal).** `MobileApiRelayService` allowlists the following.
The relay presents the owner API token.

- `GET /harness*`
- `POST /harness/orc`
- `POST /harness/login/*`
- `POST /harness/<id>/install` and `POST /harness/<id>/login` for each of the
  three ids

`POST /harness/:id/api-key` is deliberately **not** relayed, because a key
would sit in the Cloud relay queue. API keys are entered on the machine
(CLI) or on the LAN dashboard.

## Login status detection

- **Claude Code** is checked in this order:
  1. A credential Crewly stores (`crewly-subscription` / `crewly-api-key`).
  2. The env var `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` (the name is
     reported as `env:<NAME>`).
  3. `$CLAUDE_CONFIG_DIR|~/.claude/.credentials.json`.
  4. On macOS, the keychain item `Claude Code-credentials`. The check is
     `security find-generic-password -s …` and tests existence only: no
     `-w` or `-g`, so the secret is never printed. Exit 44 means logged out;
     any other failure means `unknown`.
  5. An account in `~/.claude.json` alone reports `unknown`.
- **Codex:** `codex login status`. Exit 0 means logged in, with the source
  `chatgpt`, `api_key` or `codex`. A non-zero exit means logged out. If the
  command cannot run, the check falls back to `$CODEX_HOME/auth.json`.
- **Gemini CLI:** `~/.gemini/oauth_creds.json` or a Gemini key env var.
  Otherwise the state is `unknown`.

## Login broker

- **One engine, many consumers.** The REST API polls `get()`. The CLI polls
  or awaits `waitForCompletion()`. Phase 2 (Slack DM re-login) subscribes to
  the `update` and `finished` events. Events carry `LoginSession` snapshots,
  which never contain a secret.
- **Spawn.** The broker runs the method's command in a PTY:
  - 1000×50 columns, wide enough that URLs are not wrapped;
  - cwd is `$HOME`;
  - the env has the harness PATH;
  - `BROWSER=true` is set. Claude Code reads `BROWSER`, so it does not open a
    browser on the server.
  - `CREWLY_API_TOKEN` and the nested-Claude-session markers are removed.
- **State machine:**
  - `starting` → `awaiting_user` once a URL, code or input prompt is seen.
  - `input(text)` writes `text + '\r'` and moves to `verifying`. If the
    prompt appears again, the session goes back to `awaiting_user`, with the
    failure line as `message`.
  - Success → `succeeded`. A failure line with no new prompt, or an exit
    without success → `failed`.
  - After 15 minutes → `timed_out`. `cancel()` → `cancelled`.
  - A terminal state kills the PTY.
- There is only one live session per harness. `start` returns the live one.
  Finished sessions stay readable for 1 hour.
- **Exposed screen.**
  - `screen` is the last 2000 characters of normalized text, with secrets
    redacted:
    - `sk-ant-…`, `sk-…`, JWTs, GitHub/Slack tokens, Google keys;
    - every captured secret, including the per-line fragments of a wrapped
      secret.
  - After a token is captured, it is also removed from the raw buffer.
  - When no rule matches (no URL, code or prompt), `screen` is what a human
    reads. The CLI prints it after 20 s.

### Normalization (`normalizeTerminalOutput`)

1. Keep OSC 8 hyperlink targets as URL candidates, and drop other OSC
   sequences.
2. Treat `\r+\n` as one line break, and a lone `\r` as a line break.
3. Convert `CSI n C` (cursor forward) to n spaces. Convert `CSI n G` (cursor
   to column n) to spaces up to that column. Claude Code 2.1.282 places every
   word with `CSI n G` (`\x1b[2GPaste\x1b[8Gcode…`), which is why a naive
   ANSI strip loses the spaces.
4. Strip the remaining escape sequences and control characters, trim
   trailing spaces, and collapse runs of blank lines.
5. Build `spaceless`, a copy with all spaces removed. Prompt, success and
   failure patterns use `\s*` between words and are matched against both
   `text` and `spaceless`.

### Wrapped values and completeness (`extractWrappedRuns`)

- A URL that reaches the end of a line of at least 40 characters continues
  on the next line when that whole line is URL characters. This joins
  `…scope=user%3` + `Ainference&…`.
- A value is exposed only when it is complete, meaning output continues
  after it. This way a URL split across two PTY chunks is never shown
  half-way. On process exit (`final`), a value at the end of the buffer
  counts too.
- Tokens are never joined, because the PTY is wider than any token.

### Rules (from output captured 2026-09-25)

**Claude Code 2.1.282, `claude setup-token`** (`subscription`):

- **URL:** `^https://(…claude.com|claude.ai|anthropic.com)/…oauth/authorize?…`. The capture was
  `https://claude.com/cai/oauth/authorize?code=true&client_id=…&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=…&code_challenge_method=S256&state=…`,
  346 characters.
- **Input prompt:** `paste\s*code\s*here\s*if\s*prompted`. The prompt renders as
  `Pastecodehereifprompted>` when spaces are stripped.
- **Secret and success:** `sk-ant-oat01-[A-Za-z0-9_-]{20,}`. Printing the
  token is the success signal (`successRequiresSecret`). The token is stored
  as the Claude credential and exported to agents as
  `CLAUDE_CODE_OAUTH_TOKEN`. It is followed by "Store this token securely…",
  which is why the completeness rule holds.
- **Failures** (read only from the output after the last input):
  - `Invalid code. Please make sure the full code was copied`
  - `OAuth error`
  - `Login failed`
  - `Authentication failed`

**codex-cli 0.156.1, `codex login --device-auth`** (`device`):

- **URL:** `^https://auth.openai.com/codex/device`.
- **User code:** the token on the line after "one-time code", for example
  `WH2P-EO69V`.
- **Success:** "Successfully logged in", or exit 0. Either one is confirmed
  with `codex login status` before the session reports `succeeded`. Codex
  writes `$CODEX_HOME/auth.json` itself, so Crewly stores nothing for it.
- **Failures:**
  - `login failed/error`
  - `device code expired`
  - `authorization denied`
  - a line starting with `Error:`

**API keys:**

- **Anthropic:** must start with `sk-ant-`. The key is checked against
  `GET https://api.anthropic.com/v1/models`: a 401 or 403 rejects it, and a
  network error still saves a well-formed key. It is stored and exported as
  `ANTHROPIC_API_KEY`.
- **Codex:** `codex login --with-api-key`, with the key on stdin.
- Storing one Claude credential replaces the other.

## Agent environment

`AgentRegistrationService.buildAgentIdentityEnv()` is the single env builder
for every agent PTY. It covers the primary spawn, the Step-2 recreation and
the orchestrator session. It now starts with `harnessEnvForAgents()`:

- `PATH` with `<crewlyHome>/npm-global/bin` first;
- the stored `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`.

Sessions that already exist keep their env until they are recreated.

## CLI

- **How the CLI shares the engine.** The CLI imports the backend's harness
  modules directly, as `crewly backup` and `crewly token` already do. Status,
  install and the orc choice are files and child processes, so they run
  in-process with no backend. Login sessions are live PTYs:
  - When *this user's* backend is running (`/health` on `WEB_PORT` answers
    and its `homeId` equals the CLI's `getCrewlyHomeId()`, a short hash of
    the Crewly home path), the CLI starts the login in the backend over
    loopback REST. Loopback needs no token, so without the `homeId` check a
    CLI run by one Unix user would drive another user's backend on the same
    port (found on a shared server: a production Crewly running as root on
    8787). A backend that reports no `homeId` is not used. The session outlives the CLI
    and is the same one the web page and the phone see.
  - Otherwise the broker runs in-process.
- **`crewly onboard`**:
  - It first asks "Continue setup in the web app or here?". The default is
    the web app when a local desktop session exists (macOS/Windows, or Linux
    with a display, and not SSH or an agent shell); otherwise it is the
    terminal. `--web` and `--cli` skip the question.
  - Web mode: if Crewly is running, onboard opens `http://localhost:<port>/setup`.
    Otherwise it starts Crewly in the foreground, the way `crewly start`
    does, and opens the page once `/health` answers. The URL is always
    printed. Loopback needs no token.
  - Terminal mode runs these steps:
    1. jq check, harness table, choice of orc harness (default Claude Code),
       install/update of that harness only (with confirmation), and
       recording of the orc harness.
    2. Login. The URL and code are printed ("open on any device — your phone
       is fine"), the pasted code is read from the TTY, and API keys are
       read without echo.
    3. Skills. 4. Template. The team is created on the orc harness.
       5. Summary.
- **`--yes`** never prompts and opens no readline:
  - It uses the default harness (or `--harness`) and auto-installs.
  - For login:
    - A login is started in the running backend, the link is printed, and
      onboard returns `pending` so the owner can finish on the phone.
    - A device-code login (Codex) with no backend runs as a **detached
      background process** (`createDetachedLoginDriver`: own process group,
      output in `<crewlyHome>/logs/login-<harness>.log`). The CLI prints the
      link and code and returns `pending` right away; the harness saves the
      login by itself and exits when the code is used or expires (15 min).
      Waiting in-process would block an installer or agent for up to 15
      minutes, and its tool timeout would kill the login with it.
    - A login that needs a typed reply (Claude) with no backend is skipped.
      The note tells the owner to start Crewly and open Setup on the phone,
      or to run `crewly login claude`.
- **`crewly login <claude|codex>`** accepts `--method`, `--force` and
  `--yes`. **`crewly harness`** prints the status table.

## install.sh

`scripts/install.sh` passes `--harness <id>`, `--yes`, `--web` and `--cli`
through to `crewly onboard`. `--yes` runs even without a terminal. tmux is
not required.

When the global npm folder is not writable (a system Node on Linux, run as a
normal user), the script installs Crewly under `<crewlyHome>/npm-global`
(the harness fallback prefix) instead of suggesting `sudo`, puts its `bin` on
PATH for the rest of the run, and appends it to `~/.profile` plus the
shell's rc file once. `crewly upgrade` and `crewly start --auto-upgrade`
install into that prefix when the running copy lives there
(`cli/src/utils/self-install.ts`).

`web/public/install.sh` (crewlyai.com) is a copy and **must be synced by
hand**.

## Not in Phase 1

- Slack DM re-login. Built in Phase 2 (below).
- Gemini login.
- A route that fetches a harness's active session. Instead,
  `POST /:id/login` returns the live one.

## Phase 2: re-login over Slack

Status: implemented on `feat/onboarding-p2-slack-relogin` (backend only).

When a harness login expires, Crewly notices it by itself. It DMs the owner
on Slack with what to do. The owner finishes the login on the phone, and the
stuck agents restart and resume. Nobody touches the machine.

### Components

| File | Role |
|---|---|
| `services/harness/login-expiry-rules.ts` | Per-harness expiry patterns, next to `login-rules.ts` |
| `services/harness/harness-relogin.service.ts` | The coordinator: flows, DMs, reply routing, success and failure, status check |
| `services/agent/oauth-relogin-monitor.service.ts` | Existing PTY monitor. It now hands an expiry to the coordinator. |
| `services/slack/slack-relogin-dm.service.ts` | Owner DM through the master bot; recognises the owner's DM replies |
| `services/slack/slack-orchestrator-bridge.ts` | `setInboundInterceptor`: offers each inbound message to the interceptor before anything else |
| `services/agent/relogin-agent-resumer.service.ts` | Lists a harness's live sessions and restarts them with conversation resume |
| `index.ts` | Wiring; the status check starts at boot and stops at shutdown |

### Detection

`OAuthReloginMonitorService` already watched every agent PTY: live chunks
after a 30 s startup grace, plus a 30 s sweep of every session's screen. It
used to type `/login` into the stuck agent and send a per-agent notice. With
the coordinator wired, a match of `detectLoginExpiry(output, runtimeType)` is
reported instead, and the monitor then does neither for that session.
First-run sign-in screens with no expiry text keep the old per-agent notice.

Output is normalized with `normalizeTerminalOutput`. Each pattern is matched
against the text and against its spaceless copy.

**Claude Code 2.1.282.** The wording comes from the binary via `strings`:

- `Login expired · Please run /login`
- `OAuth token revoked · Please run /login`
- `Not logged in · Please run /login` (or `· Run /login`)
- `API Error: 401 … · Please run /login`
- `Session expired. Please run /login to sign in again.`
- The API's `OAuth token has expired` / `has been revoked` /
  `Invalid authentication credentials`, only together with
  `authentication_error`, `API Error` or `401`.

The UI messages must include Claude's `·` separator, so source code that
mentions "please run /login" does not match. The warning
`Your login expires in N days · run /login to renew` does not match either.

**Codex.** No native binary was available for `strings`, so these follow the
codex-rs wording:

- `access token could not be refreshed`
- `refresh token has expired / was already used / was revoked`
- `Provided authentication token is expired` or `"code":"token_expired"`
- `unexpected status 401 Unauthorized`

**Status check.** Every 10 min the coordinator checks the orc harness
(`teams/orchestrator/config.json`) with its own status command, the same one
`GET /api/harness` uses. `logged_out` counts as expired only if the harness
was seen logged in earlier, or if agents are running on it; a machine that
was never logged in is onboarding's job. Nobody's specific output matched,
so the stuck agents are every live session of that runtime.

### Flow (one per harness)

1. **Debounce.** There is at most one flow per harness. Later reports only
   add stuck sessions. After a failure, a new report restarts the flow (the
   re-reminder) at most once every **3 h**.
2. **Stored API key, used silently with no DM.**
   - Claude: if Crewly holds an Anthropic key, agents get `ANTHROPIC_API_KEY`
     when they are recreated, so the coordinator just restarts them.
   - Codex: a stored OpenAI key is re-applied with `codex login --with-api-key`.
   - If the harness expires again within 1 h, or the key is rejected, the
     phone login below is used instead.
3. **Broker login.** Claude uses `subscription` (`claude setup-token`); Codex
   uses `device`. `broker.start` returns the live session if one already
   exists, for example one the owner started on the web.
4. **DM** through `SlackReloginDmService`. It opens a DM with the owner (the
   user who installed the Slack app) through the master bot, and remembers
   that channel. If the owner is unknown, it uses the owner-notification path
   (`sendNotification`). Text is escaped for Slack (`&`, `<`, `>`), link
   previews are off, and the message is not mirrored to chat-v2.
   - **Codex:** sent once the URL **and** the one-time code are known. It
     names the harness and the waiting agents, and puts the link and the code
     on separate lines. It ends with "Finish the login on your phone and it
     continues by itself." Success is detected by the broker (`codex login
     status`).
   - **Claude:** the link, plus "reply to this DM with the code shown after
     you approve".
   - **Unrecognised screen:** if there is still no URL or code after 20 s, the
     DM carries the redacted tail of the screen (at most 1500 chars) and says
     the next reply will be typed into that terminal.
5. **Success.** The broker has already stored the credential. The flow then
   does the following:
   - Restarts the stuck sessions: the ones whose output matched, or every
     session of the runtime if that is unknown.
   - Team agents: runtime-exit monitoring is stopped, the PTY is killed, the
     conversation id is kept and `createAgentSession` runs again. This is the
     heartbeat-monitor path, and the agent resumes with `--resume` /
     `codex resume`.
   - The orchestrator restarts through `OrchestratorRestartService`.
   - Then it DMs "Done: <harness> is logged in again, N agents resumed." and
     lists any agent that could not be restarted.
   - For the next 10 min, reports for that harness are ignored, because
     resumed transcripts replay the old error. Screen-sweep reports for a
     resumed session stay ignored until that session's live output reports
     again.
   - A success in another session for the same harness also completes the
     flow, for example when the owner logged in from Setup.
6. **Failure or timeout.** One DM with the broker's message (redacted) and
   "Reply `relogin` (or `重新登录`) here to try again." A session cancelled
   elsewhere (web, shutdown) sends no DM.

### Owner DM replies

`SlackOrchestratorBridge.handleSlackMessage` first offers the message to its
interceptor, `createReloginReplyInterceptor`. This happens **before** the
`Received message` log line, file download, thread store, ticket intake and
orc routing. A consumed message goes nowhere else.

The interceptor considers a message only if all of these hold:

- it is text, with no files;
- it is in a `D…` channel;
- it has no `agentSession`, `authorAgentSession` or `handoffTo`;
- the channel is not an agent bot's DM;
- it comes from the owner, and in the DM the re-login went to (when known).

The coordinator's `handleOwnerReply` then consumes it only in these cases:

- `relogin`, `re-login` or `重新登录` (trimmed, case-insensitive), while a flow
  exists. Failed flows restart; otherwise running flows are cancelled
  quietly and restarted.
- **A Claude code.** The Claude session is `awaiting_user` with `needsInput`,
  its link was DM'd, and the reply looks like a code: one token, no spaces,
  16–512 chars, with surrounding backticks stripped. It is typed in with
  `broker.input()`. If the harness rejects it (the prompt returns with a
  message), one DM says so and asks for the code again. A code-shaped reply
  that arrives just after the session ended is still consumed.
- **An unrecognised screen.** Only a reply prefixed `输入 ` / `input ` (e.g. `输入 1`) is typed into the terminal, single-line and ≤ 512 chars after the prefix. A bare reply goes to the orc as usual — the owner's DM with the orc is the same channel, so taking any one-line reply would swallow normal messages.
  DMs are written in Chinese (the owner's language).

Anything else goes through the normal chat path. The code is never stored,
logged or echoed. The coordinator logs only harness and session ids, and DMs
are built from `LoginSession` snapshots, which never contain a token.

### Status

In `GET /api/harness`, each harness entry gains
`reloginPending: { harnessId, sessionId, startedAt } | null`. It is non-null
while a flow's broker session is running. Its `sessionId` works with
`GET /api/harness/login/:sessionId` and `POST …/input`, so the web page and
the phone app can finish the same login. The rest of the shape is unchanged.
The CLI's in-process service always reports `null`.

### Constants

`HARNESS_CONSTANTS.RELOGIN`:

- remind interval: 3 h
- status check: 10 min
- unrecognised-screen delay: 20 s
- post-success quiet: 10 min
- silent-key retry window: 1 h
- code length: 16–512
- retry keywords
- DM caps

### Not in Phase 2

- Telegram / WhatsApp DMs. Slack only.
- Gemini re-login. Gemini has no broker method, so the monitor keeps its old
  behaviour for it.
- Detecting an expired Claude login with the status check. It only sees
  whether a credential exists, not whether it has expired, so Claude expiry
  comes from agent output.

## Phase 3: first-run checklist and starter teams

Status: implemented on `feat/onboarding-p3-checklist` (templates, backend,
web, CLI).

Once the harness works, the owner is walked through four more steps, on the
web (`/setup`, the dashboard) or in `crewly onboard`:

1. **First team** from a starter.
2. **First task** ("派第一件事").
3. **Crewly Cloud.**
4. **Slack.**

Every step after the harness can be skipped. Every step can be finished from
a phone: through the web app on the LAN, or through the portal / phone app
over the relay.

### Starter templates

Starters are ordinary free templates in `config/templates/` that carry an
`onboarding` block:

```json
"onboarding": {
  "order": 1,
  "recommended": true,
  "label": "个人助理",
  "tagline": "…",
  "suggestions": ["…", "…", "…"]
}
```

| Starter | File | Members |
|---|---|---|
| Personal Assistant (recommended, `order` 1) | `personal-assistant-team.json` | Assistant (`generalist`, the lead: triage of email / calendar / WhatsApp inbox, morning briefing, drafts that are sent only after the owner confirms, errands and reminders) and Researcher (`researcher`) |
| Marketing (`order` 2) | `growth-marketing-team.json` (reused as-is) | Content Strategist, Content Writer, Distribution Specialist |
| Blank | none (`ONBOARDING_CONSTANTS.BLANK_STARTER`) | The orchestrator only, no team |

The member prompts are the members' `systemPrompt` strings in the template
JSON. `config/templates/templates.test.ts` keeps the starters simple:

- the top-level keys are only `id`, `name`, `description`, `members` and
  `onboarding`;
- each member has only `name`, `role` and `systemPrompt`;
- member names are ASCII, because session names are built from them;
- there are exactly one recommended starter, unique `order` values, and
  three suggestions per starter.

`TemplateService` carries `onboarding` through (`listOnboardingStarters()`,
ordered by `order`). The CLI's `listOnboardingStarters()` and
`getDefaultStarterTemplate()` do the same. `crewly onboard --yes` without
`--template` uses the recommended starter, and no longer takes the first
template by name.

### Checklist API (`/api/onboarding`)

The checklist router is mounted before the Cloud Portal onboarding-session
router that shares the prefix. Every response is `{ success, data }` or
`{ success: false, error, code? }`.

| Method & path | Body | `data` |
|---|---|---|
| `GET /checklist` | – | `{ steps: [{ id, done, detail }], doneCount, total, allDone, dismissed, dismissedAt }` |
| `POST /checklist/dismiss` | `{ dismissed?: boolean }` (default `true`) | checklist |
| `GET /starters` | – | `{ starters: [{ id, name, label, tagline, description, recommended, members, suggestions }] }`; Blank is last |
| `POST /starter-team` | `{ starterId }` | `{ starterId, team \| null, created }`. 201 when a team was created, 200 for Blank or an existing team |
| `POST /first-task` | `{ text, teamId? }` | `{ forwarded, queued, conversationId, teamId, sentAt, message }`. 201, or 503 when the orchestrator could not take it |

Error codes: `unknown_starter` and `unknown_team` → 404, `invalid_task` →
400.

**Owner-only.** Every POST refuses `X-Agent-Session` with 403, the same
check `/api/harness` uses. The GETs stay readable.

**Relay.** `MobileApiRelayService` allowlists `GET /onboarding/checklist`,
`GET /onboarding/starters`, `POST /onboarding/checklist/dismiss`,
`POST /onboarding/starter-team` and `POST /onboarding/first-task`. The
portal's onboarding sessions (`/onboarding/sessions`, `/provision`) and
`POST /cloud/connect` are not relayed.

### How each step's `done` is derived

The service is `services/onboarding/onboarding-checklist.service.ts`; its
real wiring is in `onboarding-checklist.factory.ts`.

| Step | `done` when | Source |
|---|---|---|
| `harness` | the orc harness is recorded, installed, and not `logged_out` (`unknown` counts as done, the same rule as the web setup redirect). A runtime outside the harness list counts as done | `teams/orchestrator/config.json` + the harness status probes (no `npm view`) |
| `team` | at least one team exists, **or** the owner chose Blank | `StorageService.getTeams()` + `blankChosenAt` |
| `first_task` | the owner has written to Crewly on any surface, **or** setup handed a first task to the orchestrator | chat-v2 `getRecentOwnerMessageContents(0, 1)`: `user` rows an agent did not write, so chat, Slack, WhatsApp and relay all count. Plus `firstTask.sentAt` |
| `cloud` | `CloudClientService.isConnected()` | live |
| `slack` | `getSlackService().isConnected()`, whether the app is Cloud-installed or self-hosted with env tokens | live |

A step whose source throws reads as not done, with `detail.error` set; the
rest of the checklist is still returned.

The only stored state is `<crewlyHome>/onboarding.json`, written atomically
with serialized updates:

- `dismissedAt`: the dashboard card was hidden;
- `blankChosenAt`: the owner chose Blank;
- `firstTask`: `{ sentAt, teamId, conversationId }`;
- `pendingFirstTask`: see below.

### Starter team

`POST /starter-team` does the following:

- It uses `TemplateService.createTeamFromTemplate`, named after the template.
- Every member runs on the orchestrator's harness, the only one first-time
  setup installs (Claude Code if none is recorded).
- Session names are `<template-id>-<member>-<id8>`.
- It is idempotent per template: a team whose `templateId` matches is
  returned instead of a second one. This covers double taps on a phone.

The CLI writes the team itself, to `<crewlyHome>/teams/<template-id>/config.json`:

- it honours `CREWLY_HOME`, which the old code ignored;
- it records `templateId`;
- it keeps an existing team instead of overwriting it, which the old code
  did on a second run.

### First task

The first task goes through the owner's normal chat path.
`POST /api/chat/send`'s body was extracted into
`sendChatMessageToOrchestrator()` (`controllers/chat/chat.controller.ts`), so
the task is:

- stored as a `user` message with metadata `source: onboarding_first_task`;
- run through ticket intake;
- enqueued for the orchestrator. The queue holds it while the orchestrator
  is offline.

The message starts with `[初始设置 · 第一件事]`. For a team it adds
"请交给团队「<name>」(team id: <id>) 来做；团队还没启动的话先启动它。", and
the owner's words follow on their own. The orchestrator routes the task to
the team, as it does any owner request.

`crewly onboard` sends the first task two ways:

- When this user's backend is running (checked by `homeId`), it posts to
  `POST /api/onboarding/first-task`.
- Otherwise it stores `pendingFirstTask`. The backend delivers it once the
  message queue processor starts, and clears it after a successful hand-off.

### Crewly Cloud from a phone

`/setup?step=cloud` offers two ways to connect.

**1. Google sign-in that comes back to this page (primary).** The button
opens:

```
https://api.crewlyai.com/api/cloud/google/start?redirect=<origin>/auth/callback?next=/setup?step=cloud
```

`<origin>` is whatever address the page was opened from: localhost, the LAN
address on a phone, or a tunnel. The Cloud auth service accepts any http(s)
callback (`isTrustedCallback`). It exchanges the code on the server and
redirects to the callback with `&token=…&refreshToken=…`. `AuthCallback`
then does the following:

- it posts both tokens to `/api/cloud/connect` on this backend;
- it follows `next`, but only for a same-origin path (`isSafeNextPath`),
  and carries `?error=` back.

`/auth/*` is excluded from API-token URL consumption, so the Cloud `token`
parameter is never mistaken for the API token. Nothing lands on a localhost
port of the machine.

The existing Settings → Cloud button goes through
`crewlyai.com/cloud/auth`, whose `isValidOssRedirect` accepts only
localhost. That is why setup does not use it.

**2. Paste (fallback).** Use this when the phone cannot be sent back to the
page's address. The page links to the checklist's `tokenPageSignInUrl`:

```
https://api.crewlyai.com/api/cloud/google/start?redirect=https://crewlyai.com/cloud/cli-token
```

That page shows the token and the refresh token, which the owner pastes into
two fields. The fields post to `POST /api/cloud/connect`. Without a refresh
token, the page warns that the login lasts about an hour.

Over the relay (portal / phone app), the instance is already connected to
Cloud, so the Cloud step is done.

### Slack

`/setup?step=slack` reuses the one-click install through Crewly Cloud,
`GET /api/slack/cloud/install-url`, which is also what Connections → Slack
uses:

- The Slack OAuth round-trip runs on Crewly Cloud, so it works from a phone.
- The return URL is `<origin>/setup?step=slack`.
- There the step calls `/api/slack/cloud/status?refresh=1` once, so a
  workspace that was just installed connects.
- Without Cloud, the step sends the owner to the Cloud step.
- "更多 Slack 设置" links to `/connections?platform=slack`.

### Web

`/setup` has these steps:

1. 编程助手
2. Orc
3. 登录
4. 团队
5. 第一件事
6. Cloud
7. Slack
8. 完成

- Steps 4–7 have 上一步 / 跳过, and 下一步 once the step is done.
- `?step=team|first_task|cloud|slack` opens the page at that step, and the
  harness overview is not waited for.
- On a phone, the step indicator is replaced by "第 n/8 步 · <label>".
- Opened at 第一件事 directly, the step targets the first existing team and
  uses its starter's suggestions (Blank's when there is no team).
- 完成 lists the five checklist steps with done marks.

The dashboard shows `GettingStartedCard` ("开始使用"):

- progress, and the five steps, each linking to `/setup?step=<id>`;
- a 继续 button;
- an X that hides the card. Hiding is stored on the backend, so the phone
  and the laptop agree.

The card disappears when every step is done or it is hidden.

The unused modal `OnboardingWizard` (template → review → cloud → launch) was
removed, together with its `Step*` components and types. Its cloud step used
the localhost-only sign-in, and `/setup` replaces it. `StepIndicator` stays.

### CLI

`crewly onboard` now has seven steps:

1. AI harness
2. Log in
3. Skills
4. First team
5. First task
6. Crewly Cloud & Slack
7. Done

**First team.** The step lists the starters, then Blank. Enter picks the
recommended one. When no starter templates are found, the old full template
list is shown instead.

**First task.** The three suggestions are listed. A number picks a
suggestion, typed text is used as it is, and Enter skips. `--task "<text>"`
sets the task; with `--yes`, no task is sent without it.

**Crewly Cloud & Slack.** This step never waits. If the running backend
reports a step as done, it prints ✓. Otherwise it prints:

- the Cloud sign-in link, which ends on the portal token page;
- the LAN setup links `http://<lan-ip>:<port>/setup?step=cloud|slack&token=<api token>`.
  The web app consumes the API token once.
- `crewly cloud login --no-browser` as the terminal alternative.

### Not in Phase 3

- Starting the new team's agents from setup. The orchestrator starts them
  when it takes the first task.
- A phone-app-native checklist screen. The routes are relayed; the app
  still has to render them.
- Relaying `GET /slack/cloud/install-url`. Its URL carries a Cloud JWT, so
  from the portal the Slack install stays the portal's own flow.
