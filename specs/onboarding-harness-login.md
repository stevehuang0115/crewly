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
| `GET /api/harness` | – | `{ harnesses: HarnessStatus[], orcHarness: string \| null, systemTools: [{ id: 'jq', installed, installHint }] }` |
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
  - When the backend is running (`/health` on `WEB_PORT`), the CLI starts
    the login in the backend over loopback REST. The session outlives the CLI
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
    - A device-code login (Codex) with no backend runs in-process and waits
      for the phone with no prompts.
    - A login that needs a typed reply (Claude) with no backend is skipped.
      The note tells the owner to start Crewly and open Setup on the phone,
      or to run `crewly login claude`.
- **`crewly login <claude|codex>`** accepts `--method`, `--force` and
  `--yes`. **`crewly harness`** prints the status table.

## install.sh

`scripts/install.sh` passes `--harness <id>`, `--yes`, `--web` and `--cli`
through to `crewly onboard`. `--yes` runs even without a terminal. tmux is
not required.

`web/public/install.sh` (crewlyai.com) is a copy and **must be synced by
hand**.

## Not in Phase 1

- Slack DM re-login. The broker's events are ready for it.
- Gemini login.
- Codex re-login detection while agents run.
- A route that fetches a harness's active session. Instead,
  `POST /:id/login` returns the live one.
