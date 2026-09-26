# Antigravity CLI (`agy`) runtime — Gemini API key only

Status: implemented on `feat/antigravity-runtime` (backend, CLI, web). Not
yet verified against a real Gemini API key (see "Unverified until a live
key test").

## Why

On 2026-06-18 Google shut Gemini CLI down for individual users (free and
AI Pro/Ultra) and replaced it with the closed-source **Antigravity CLI**,
binary `agy`. Crewly adds it as the runtime `antigravity-cli` and stops
offering Gemini CLI to new users.

### Policy: API key only

Google's policy prohibits third-party tools from using Antigravity (or
Gemini CLI) **product OAuth**. Crewly therefore never drives `agy` through a
user's Google account or subscription login. The only supported auth is a
**Gemini API key**. Concretely:

| Guard | Where |
|---|---|
| No broker / OAuth login method for the harness; `api_key` is the only one | `harness-registry.ts` |
| Launch refused without a key (`RuntimeStartupBlockedError` `api_key_required`) | `AntigravityRuntimeService.prepareLaunch` |
| `modelProvider: "gemini"` written to agy's settings before **every** launch; an unreadable / unwritable file blocks the launch (`settings_unreadable`) instead of letting agy fall back to an account | `utils/antigravity-settings.utils.ts`, `prepareLaunch` |
| An account sign-in screen, or a session that comes up without the `Gemini API key` header, is refused (`account_login_refused`) and agy is exited | `waitForRuntimeReady` |
| The OAuth relogin monitor never types `/login` into an agy session | `oauth-relogin-monitor.service.ts` |
| Harness status never counts an account login in agy's keyring as "logged in" | `harness-status.service.ts`, CLI `runtime-auth.ts` |
| Antigravity sign-in screens are **not** login-required patterns (the owner is never asked to sign in) | `LOGIN_REQUIRED_PATTERN_SETS` test |

## Sources

- Docs, read 2026-09-25: <https://antigravity.google/docs/cli/install/>,
  <https://antigravity.google/docs/cli/headless/>, plus `/cli/reference`,
  `/cli/modes`, `/cli/commands/resume`, `/cli/conversations`,
  `/cli/troubleshooting`, `/cli/gcli-migration`, `/cli/statusline`,
  `/permissions`.
- **agy 1.2.11 in a PTY**: installed with the official installer into a
  temp dir with a sandboxed `HOME`, run under node-pty + `@xterm/headless`
  (120×40) with `modelProvider: "gemini"` and a dummy `GEMINI_API_KEY`. None
  of the captured screens needs an account or a working key; a prompt sent
  with the dummy key produced the real `API_KEY_INVALID` error screen. agy's
  own log confirmed `ChainedAuth: authenticated via gemini_api_key`.
- **agy binary strings** for screens that cannot be shown without a model
  turn or an account login (approval dialogs, sign-in screens).

`ANTIGRAVITY_API_KEY` appears in neither the docs nor the binary, so Crewly
does not use it. `GOOGLE_API_KEY` and `.env` files are explicitly ignored by
agy (install docs, Troubleshooting).

## Auth

Per the install docs, API-key use needs **both**:

1. `"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json`
   ("gemini is the only accepted value"), and
2. `GEMINI_API_KEY` in the environment ("Only setting a GEMINI_API_KEY
   environment variable on its own has no effect").

With the provider set, agy "skips the sign-in screen", "never establishes
an account session", and shows `Gemini API key` in its header instead of an
email. If the provider is `gemini` but the key is missing, agy refuses to
start: `modelProvider is set to "gemini" in settings.json, but the
GEMINI_API_KEY environment variable is not set.` agy checks only that the
key is non-empty; a bad key surfaces on the first turn.

### Key storage and injection

- The owner saves the key in **Settings → Harness → Antigravity CLI** or with
  **`crewly login antigravity`** (`POST /api/harness/antigravity-cli/api-key`,
  owner-only, never relayed — like every API key).
- It is checked with `GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=1`
  with the key in the `x-goog-api-key` header (never in the URL). 400
  (`API_KEY_INVALID`), 401 and 403 reject; a network error or other status
  still saves a well-formed key (same rule as the Anthropic key).
- Stored in `<crewlyHome>/harness-credentials.json` (0600) as
  `antigravity.geminiApiKey`; then agy's settings are switched to the Gemini
  provider.
- `harnessEnvForAgents(env, runtimeType)` adds `GEMINI_API_KEY` and
  `AGY_CLI_DISABLE_AUTO_UPDATE=true` to the **spawn env of antigravity-cli
  sessions only** — never typed into the terminal, and never given to a
  Gemini CLI session (an unexpected `GEMINI_API_KEY` brings up Gemini CLI's
  "Existing API key detected" dialog for Google-login users).
- Key used at launch, in order: the saved Antigravity key; a Crewly settings
  Gemini key (antigravity-cli override, then global — exported the way
  other settings keys are); `GEMINI_API_KEY` in the backend's env. A saved
  Antigravity key is not overridden by a settings key.

### Settings file side effect

The settings file is agy's single, global user file; there is no documented
per-process override. Writing `modelProvider: "gemini"` therefore also
switches **the user's own interactive `agy`** to API-key mode: it will then
need `GEMINI_API_KEY` exported in their shell (or they remove
`modelProvider`, per the docs, to go back to account login — Crewly writes
it again at the next agent launch). The web form and CLI say so. Every other
key in the file is preserved; the file is written atomically with mode
0600, and never rewritten when it is not a JSON object.

## Install

`agy` has no npm package. The harness install spec is `script`:

- Fresh install: Crewly downloads **exactly**
  `https://antigravity.google/cli/install.sh` (https, no redirects, ≤256 KB,
  must start with `#!`), writes it to a private 0700 temp file and runs it
  with `bash` — the documented `curl -fsSL … | bash`. The script verifies
  the binary's SHA-512 against its manifest, puts `agy` in `~/.local/bin`
  (on the harness PATH) and runs `agy install` (PATH hint / shell profile).
- Already installed: the job runs `agy update`.
- Version: `agy --version` (`1.2.11`). There is no version feed on an
  official Google domain, so `latestVersion` is null and no "update
  available" badge is shown. agy self-updates when the user runs it; Crewly
  disables that inside agent sessions (`AGY_CLI_DISABLE_AUTO_UPDATE=true`)
  so a mid-task binary swap cannot restart the TUI.
- macOS and Linux only (the Windows installers are PowerShell / cmd).

## Launch

```
AGY_CLI_DISABLE_AUTO_UPDATE=true agy [--model <slug>] [--effort low|medium|high|max] \
  [--conversation=<id>] --add-dir='<crewlyHome>' --add-dir='<tmpdir>' \
  --dangerously-skip-permissions --mode=accept-edits
```

- `--dangerously-skip-permissions` approves tool calls (shell commands
  included); `--mode=accept-edits` approves file edits, which the docs
  govern separately from tool permissions.
- `--add-dir` adds the Crewly home (the init prompt file and skills live
  there) and the temp dir (skill artifacts) to agy's workspace; its file
  tools otherwise stay in the workspace. The orchestrator's project folders
  are added after start with `/add-dir <path>` (raw path — agy keeps quotes
  literally), and a project created while the orchestrator runs is added
  only when agy is idle.
- Claude-only launch arguments (`--agent`, a prompt file) are never passed:
  agy has its own, unrelated `--agent`.
- Before launch the agent's folder, the Crewly home and the temp dir are
  added to `trustedWorkspaces` (verified: a pre-trusted folder skips the
  trust screen; `--add-dir` raises no prompt).
- Instructions: `AGENTS.md` is provisioned (agy reads `GEMINI.md` and
  `AGENTS.md`, per the Gemini CLI migration guide). The registration prompt
  is delivered like Gemini's: "Read the file at <crewlyHome>/prompts/<session>-init.md …".
- Model slugs from `agy models` (e.g. `gemini-3.8-flash-high`,
  `gemini-3.1-pro-low`). The interactive TUI falls back to its default with
  a warning on an unknown slug.
- No MCP servers are configured for agy (same as Codex / OpenCode).

## Resume

agy resumes with `agy --conversation=<id>` (printed on every exit:
"Resume with -c (or command below): agy --conversation=<id>"); an unknown id
silently starts fresh. A conversation exists only once the first prompt
arrives, as `~/.gemini/antigravity-cli/conversations/<id>.db` (+
`brain/<id>/`), and `cache/last_conversations.json` maps the workspace path
to its newest id. After the kickoff Crewly polls (up to 5 min) for a new,
unclaimed `<id>.db`, preferring the one whose `brain/<id>/.system_generated/logs/*`
mention the agent's `<session>-init.md`, else the workspace's latest id.

## First run, trust, sign-in

| Screen | What Crewly does |
|---|---|
| "Welcome to Antigravity CLI!" / "Choose your color scheme:" | Fail fast, `first_run_setup` |
| "Terms of Service & Data Use" (data-use consent pre-ticked) | Fail fast, `first_run_setup` — Crewly never accepts Google's terms or the data-use consent for the user. Message: run `GEMINI_API_KEY=<key> agy` once, finish the screens, `/exit`. |
| "Do you trust the contents of this project?" / "> Yes, I trust this folder" | Normally skipped by pre-trusting; else Enter on the pre-selected "Yes" |
| Account sign-in ("Select login method:", "Other sign-in options", "You are currently not signed in.", "Waiting for authentication...", "Select Google Cloud sign-in method:") | Refuse, `account_login_refused`, exit agy |
| Missing key refusal | `api_key_required` |

## Detection patterns

Screen text of agy 1.2.11 (PTY capture unless noted):

| Signal | Pattern | Source |
|---|---|---|
| Idle, prompt empty (the prompt line for `isPromptLine`) | footer starts with `? for shortcuts` | capture |
| Empty prompt placeholder (accept-edits mode) | `> Accept-edits mode: file edits auto-approved (shift+tab to cycle)` | capture |
| Text typed, not submitted | footer blank; text between the last two full-width `─` rules | capture |
| Busy | `⣯  Generating...` (8-dot braille spinner) and footer `esc to cancel` | capture |
| Thinking | `Thinking...` | binary |
| Exit armed (first Ctrl+C / Ctrl+D) | `press ctrl+c again to exit` / `press ctrl+d again to exit` | capture |
| Clean exit | `Resume with -c (or command below):` then `agy --conversation=<id>` | capture |
| API-key session header | `Gemini API key` | capture + install docs |
| Bad key (first turn) | `⚠ agent executor error: … API key not valid … reason:API_KEY_INVALID` | capture |
| Unknown model | `⚠ Warning … model <x> is not recognized … Using "Gemini 3.1 Pro (Low)" instead.` | capture |
| Tool approval (should not appear with the launch flags) | `Run this command?`, `Accept this file edit?` | binary |
| Quota | `Quota exhausted`, `RESOURCE_EXHAUSTED` | binary |

Not-ready markers (veto the idle footer): `esc to cancel`, `generating...`,
the exit-armed hints, the approval dialogs, the trust / first-run / sign-in
screens. Readiness at startup: idle footer, the placeholder, or the busy
footer (a resumed conversation may be working already).

Matching notes: the default PTY is 80 columns, so markers are kept short
and also matched against the screen with line breaks removed; exit patterns
run on the raw (unwrapped) output stream.

## Delivery

- Detection is passive: Ctrl+C at the prompt arms exit and `/` opens the
  command menu, so there are no key probes.
- A message is "stuck" only while it is inside agy's prompt box — agy
  echoes every submitted message as `> text` above the box. Recovery is one
  Enter (text in the box); retries clear the box with Ctrl+U (verified).
  Never Tab (completes slash commands) and no stray Enter/Esc during a turn
  (the binary's spinner label reads "Generating... (Enter/Esc to cancel)").
  agy sessions are excluded from the generic stuck-message scanners.
- Bracketed-paste delivery of multi-line text with `$`, backticks and
  parentheses was verified to land intact and submit on `\r`.
- No compact command (agy compacts by itself; context use is not painted
  on screen), so the context-window monitor does nothing for it.
- Clean exits auto-restart idle agents (like Claude Code / Codex / OpenCode).

## Gemini CLI retired for new users

Gemini CLI keeps working for existing and enterprise users (runtime code
unchanged). It is not offered to new users:

- Harness list (`/setup`, Settings → Harness, `crewly onboard`, `crewly
  harness`): shown only when installed or the orchestrator's harness,
  labelled **"Gemini CLI (enterprise only)"**; the orc picker offers it only
  while it is the current choice. `HarnessStatus.retired` carries this.
- Team-member runtime pickers and the default-runtime setting: Antigravity
  CLI is offered; Gemini CLI only for a member / setting already on it,
  labelled "(enterprise only)".
- `crewly doctor` no longer suggests installing Gemini CLI.
- `--harness gemini` and typing `gemini` in the CLI menu are still accepted.

Team templates declare no `compatibleRuntimes`, so none needed changing.

## Unverified until a live key test

Everything below needs a real Gemini API key (and, for the first item, the
owner accepting agy's terms once):

1. A full agent turn: the registration kickoff is read and executed, skills
   run through `run_command`, and no approval dialog appears with
   `--dangerously-skip-permissions --mode=accept-edits`.
2. The busy→idle transitions over a long tool-using turn (only
   `Generating...` was observed; other spinner labels are from the binary).
3. That `--add-dir` gives the file tools access to `~/.crewly` and the temp
   dir.
4. Conversation-id discovery against real `brain/<id>` logs (their format
   was not observed: the dummy key produced no transcript).
5. Key validation against the live models endpoint (unit-tested only).
6. The official installer + `agy update` run by the install job on a clean
   machine (the installer itself was run by hand into a temp dir).
7. Behaviour when agy's account session exists in the keyring and the
   provider is gemini (docs and agy's log say the key wins; the header
   check refuses otherwise).

## Files

Backend: `services/agent/antigravity-runtime.service.ts`,
`utils/antigravity-settings.utils.ts`, `services/agent/runtime-session-recovery.ts`,
`services/agent/agent-registration.service.ts`, `services/agent/runtime-agent.service.abstract.ts`,
`services/agent/oauth-relogin-monitor.service.ts`, `services/agent/runtime-exit-monitor.service.ts`,
`services/agent/runtime-service.factory.ts`, `services/runtime-adapter.ts`,
`services/harness/{harness-registry,harness-install.service,harness-api-key.service,harness-credentials.store,harness-status.service,harness.types}.ts`,
`constants.ts` (`ANTIGRAVITY_CONSTANTS`, `RUNTIME_INPUT_READY_PATTERNS.ANTIGRAVITY_CLI`,
`HARNESS_CONSTANTS`), `utils/terminal-string-ops.ts`, `utils/runtime-model-flags.utils.ts`.
CLI: `commands/harness-setup.ts`, `commands/harness.ts`, `commands/doctor.ts`,
`utils/runtime-auth.ts`. Web: `utils/runtime-options.ts`,
`constants/harness.constants.ts`, harness components, runtime pickers.
