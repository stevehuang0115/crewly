# Agent credential isolation (first step of #1012 item 4)

Builds on `specs/2026-10-03-security-followups-1012.md` §4 ("same-user
isolation"). The owner approved the first step on 2026-10-04.

## Incident (2026-10-04, owner's Mac)

Ruth (`biblestudy-ruth-2090d4cc`, runtime `antigravity-cli`) was asked whether
a sermon translation reads well. The file was a `.docx` kept in Drive.

1. `docs-read` failed: "The document must not be an Office file". The
   connector reported it as `google_error` with the hint "retry later".
2. `drive-read --out x.docx` "succeeded" with a corrupt zip.
   `DriveService.readContent` fetched `alt=media` as **text**: invalid UTF-8
   bytes became U+FFFD, and the `latin1` round trip turned each into `0xFD`.
   Every binary download was corrupt.
3. Ruth debugged that correctly, read `google-workspace-token.service.ts` in
   the live checkout and looked for a token. She opened
   `~/.crewly/cloud/config.json` with agy's `view_file`. That put the Cloud
   JWT and the refresh token into the model context and agy's transcript.
4. `curl -H "Bearer $(jq -r .token ~/.crewly/cloud/config.json)"
   …/api/cloud/google/workspace/token` returned an all-product Google token
   for the owner, including `gmail.send`. She downloaded the file directly
   with it.
5. Asked to comment on the doc, she used the raw token again. The comment
   POST got 403 (`drive.file` cannot write a file the app did not open), so
   she moved to the browser.

`googleRequest` is not something Ruth wrote. It is the backend's own Google
client (`services/google/google-api.client.ts`). She found it while reading
the source.

**This bypasses per-person connector access (#968):** Ruth acted with the
machine's Cloud identity. Agents run as the backend's OS user, so every
credential file under `~/.crewly` was readable.

**Owner action (not code):** the Cloud refresh token and a Google token are
in agy's transcript under
`~/.gemini/antigravity-cli/brain/2511b952-…/.system_generated/logs/`, and they
were sent to the Gemini API as context. Rotate with `crewly cloud logout` and
then `crewly cloud login`, and delete those transcript files. The Google
token expired at 02:03Z.

## Inventory: bearer secrets under CREWLY_HOME

| File | Secret | Readers | This PR |
|---|---|---|---|
| `api-token` | owner API token | backend, CLI (`crewly token`, onboard, bundle), 2 scripts | sealed |
| `cloud/config.json` | `token`, `refreshToken`, `relayToken` | backend, CLI (`cloud`, `backup`, skill submit), **crewly-agent `web_search`** | sealed; crewly-agent now searches through the backend |
| `harness-credentials.json` | Claude OAuth, Anthropic/OpenAI/Gemini keys | backend, CLI `runtime-auth` | sealed |
| `slack-credentials.json` | bot/app token, signing secret | backend | sealed |
| `slack-agent-identities.json` | one bot token per agent | backend | sealed |
| `slack-cloud-config.json` | workspace and agent bot tokens | backend | sealed |
| `telegram-credentials.json` | bot token | backend | sealed |
| `credentials/master.key` | key of the encrypted credential store | backend | sealed |
| `settings.json` `apiKeys` | provider keys | backend, CLI | guard only (agents receive these keys in env by design) |
| `<platform>-credentials.json` (messenger route) | raw bot tokens | none found | guard only |
| `whatsapp-auth/` | WhatsApp session | Baileys | guard only |
| `claude-accounts/` | Claude logins (`.credentials.json`) | Claude CLI | guard only |

Not secret: `device.json`, relay queue notices, `slack-instance.json`. The
owner session and badge secret live only in memory. `CREWLY_AGENT_BADGE`
is minted per agent and is meant for agents.

Two routes also handed credentials to any local caller:
- `POST /api/cloud/mobile-pair` returned the Cloud access and refresh tokens.
  It is now **owner-only**; the phone pairs with the API token from the LAN,
  which is an owner credential.
- `GET /api/workspace/token` returned a raw Google token. It is now
  **owner-only**.

## Layer 1: secrets out of plain files (credential vault)

**Design.** One random 32-byte key, the *vault key*, is kept in a secret
store. Each credential file keeps its non-secret fields in clear. Its secret
fields are sealed with AES-256-GCM:

- JSON: `{ cloudUrl, tier, connectedAt, "crewlySealed": "v1.<iv>.<tag>.<data>", "crewlySealedNote": "…not available to agents…" }`
- text/binary (`api-token`, `master.key`): `crewly-sealed:v1.<iv>.<tag>.<data>`

**Why one key and not one keychain item per secret.** Some files are large
and nested (one bot token per agent). Every keychain read is a subprocess,
and each one is a chance of a dialog.

| Store | Where | Default on |
|---|---|---|
| `keychain` | login keychain item `crewly:vault-key`, account = resolved CREWLY_HOME | macOS |
| `file` | `~/.local/share/crewly/secrets/<home id>/vault-key` (0600, dir 0700) or `CREWLY_SECRETS_DIR` | Linux and others |
| `legacy` | no key; plain files exactly as before | Jest; the owner's rollback |

`CREWLY_SECRET_STORE=keychain|file|legacy` pins the store.

**Keychain mechanics.**
- Writes go through `/usr/bin/security -i` with the command on **stdin**,
  so the value never appears in argv (`ps`). The value is base64 so the `-i`
  parser cannot split it.
- The key is created with `add-generic-password` **without `-U`**. If two
  processes race (CLI and backend), the second gets "already exists" and
  reads the first one's key. A key is only used after it reads back.
- Every call has a 5 s timeout. A timeout (a dialog on a locked keychain)
  latches the keychain off for the process. Crewly never waits on a dialog;
  sealing is off and files are read and written plain.
- A read *error* never creates a new key: a new key would orphan every
  sealed file.

**Migration (every boot, first thing in `start()`, idempotent).**
- Each plain file is sealed in place, then read back and compared. On any
  mismatch the original bytes are restored.
- A file that is not a JSON object is left alone.
- Nothing is ever deleted.
- **Rollback:** `CREWLY_SECRET_STORE=legacy` unseals every file back to
  plain, using the platform store's key.

**Readers and writers.** Every one of them, in the backend, the CLI and the
scripts, goes through `credential-vault.ts`:
- `readSecretText`/`readSecretBytes`/`readSecretJson`;
- `writeSecretBytes`/`writeSecretJson`;
- `openSealedJson`/`sealJsonForWrite`, for modules that keep their own
  atomic read and write (`safeReadJson`/`atomicWriteJson`).

Plain files keep reading the same way.

**API token specifics.**
- A sealed token file whose key cannot be read gives the backend an
  **ephemeral** token for that run (`source: 'ephemeral'`, ERROR log). The
  file is never overwritten, so a transient keychain problem cannot rotate
  the owner's token.
- `crewly token` refuses to print an ephemeral token.

**Backup.** `stageFile` unseals sealed files into the archive (the plain
form, as before this change), so a restore on another machine works. The
next boot there seals them with that machine's key.

### What layer 1 stops and what it does not

| Stops | Does not stop |
|---|---|
| `cat` / `jq` / `grep -r` / a file-viewer tool (agy `view_file`, Claude `Read`) on any listed file. The incident's exact step returns no `token`. | An agent that runs `security find-generic-password -s crewly:vault-key -w` itself (Mac) or reads the key file (Linux), then decrypts. Same OS user. |
| Secrets in backups, screenshots or pasted logs of `~/.crewly`. | `node -e` loading Crewly's own vault module from the install dir. |
| | Reading backend memory (`ptrace` on Linux), or calling loopback routes that are not owner-only. |

**Keychain ACL decision (asked for, not feasible).**
- An item created by `security` trusts `/usr/bin/security`. Our own reads
  go through `security`, so restricting the ACL to the node binary would
  need a native Security.framework binding in-process.
- Even then, `node -e` from an agent's shell is the same binary and passes
  the ACL.
- A node upgrade changes the binary's signature, which turns every read
  into an approval dialog: a hang for an owner who is away.
- A signed helper binary as the ACL target has the same problem: agents can
  run the helper too, unless it authenticates its caller, and that needs a
  separate OS user anyway.

So the ACL is left at the default. Layer 1 is "not where an agent looks"
plus "the narrow command to get the key is recognisable", which is what
layer 2 blocks.

## Layer 2: runtime guard

One script, `config/hooks/credential-guard/guard.sh <format> [paths-file]`,
attached as a pre-tool hook wherever the runtime has one.

**The paths file.** `<CREWLY_HOME>/runtime/credential-guard/paths` is
written at boot and at each launch. It lists, for every guarded path, three
forms:
- the absolute path;
- the `.crewly/<rel>` tail;
- the `<rel>` form, matched only when the call's cwd is inside CREWLY_HOME
  or the command `cd`s there.

**How the script decides.**
1. It reads every string in the tool's arguments.
2. It expands `~`, `$HOME`, `${HOME}`, `$CREWLY_HOME` and `${CREWLY_HOME}`.
3. It drops quotes and backslashes and collapses `//` and `/./`.
4. It matches each form followed by a path boundary.
5. It also refuses `security find-generic-password|find-internet-password|export|-i`
   when the call names `crewly`, and any `security dump-keychain`.

On a block it answers, in English: "Blocked: this touches Crewly's own
credentials (<rule>). Crewly credentials are not available to agents. Use the
connector skills instead (docs-read, drive-read, …) …".

**Only agent sessions are judged.** With no `CREWLY_SESSION_NAME` every call
is allowed. That matters for agy, whose hooks file is global and also serves
the owner's own `agy`.

| Runtime | Mechanism | Deny contract | Verified |
|---|---|---|---|
| Claude Code | PreToolUse group `Bash\|Read\|Grep\|Glob\|NotebookRead` plus `Read(//…)` deny rules, merged into the control-plane `--settings` file | exit 2, reason on stderr | unit tests; same contract as the existing control-plane hook |
| Codex (≥ a version that lists `--dangerously-bypass-hook-trust`) | `codex --dangerously-bypass-hook-trust -c 'hooks.PreToolUse=[{matcher="Bash",…}]'`, added after the resume and `--no-daemon` rewrites; probed in `codex --help`, skipped with a WARN otherwise | exit 2 | research run against codex-cli 0.160 with a fake model: a `-c` hook is ignored without the trust flag, and blocks with it |
| Gemini CLI | `GEMINI_CLI_SYSTEM_SETTINGS_PATH=<file>` with a BeforeTool hook; the machine's own system settings are merged in | exit 2 | research run against 0.40.1 |
| Antigravity (agy) — the incident runtime | entry `crewly-credential-guard` in `~/.gemini/config/hooks.json` (agy has no per-process hooks path); other entries are kept, and a file that is not a JSON object is left alone (agy then runs unguarded, with a WARN) | stdout `{"decision":"deny","reason":…}`; an allowed call prints **nothing** (agy reads `{}` as deny); a non-zero exit also blocks, so the script never exits non-zero for agy | research run against agy 1.2.14 with Crewly's real flags: `view_file` and `run_command` both denied |
| crewly-agent (in-process) | `bash_exec`, `read_file`, `grep` and `glob` run the same script (Claude format) before acting | its own tool error | vitest with the real script |
| OpenCode | **none.** It has `permission` deny globs and `tool.execute.before` plugins; neither is wired yet (follow-up) | — | — |

Notes on Antigravity: `--dangerously-skip-permissions` overrides agy's
`command(...)` deny rules, so only a hook stops its shell. `read_file(...)`
deny rules do still apply, but they are not used here because they would
also bind the owner's own agy.

**The guard's own files.** The wrappers and the paths file live under
`runtime/credential-guard/`. That directory is on the control-plane
write-deny list for Claude Code. Other runtimes can overwrite them; the
guard is a speed bump there.

**Kill switch.** `CREWLY_CREDENTIAL_GUARD=0` in the backend's environment.
For agy it also removes Crewly's hooks entry.

### What layer 2 stops and what it does not

| Stops | Does not stop |
|---|---|
| The incident's exact commands (`jq -r .token ~/.crewly/cloud/config.json`, `view_file …/cloud/config.json`) and their common variants. | Paths built at runtime: `$(echo …)`, base64, globs like `~/.cr*ly`, other variables. |
| `security find-generic-password … crewly:…`. | A script the agent writes and then runs. Interpreters reading the file by a computed path. |
| | OpenCode agents. |

## Layer 3: Linux (steamfun-ops, root systemd service)

There is no login keychain. Options considered:
- **libsecret:** needs a D-Bus session and an unlocked keyring; not
  available on a headless server.
- **`keyctl`:** the user keyring is readable by any root process (`keyctl
  print`) and does not survive a reboot, which would lose the Cloud login.

Chosen: the `file` store, `~/.local/share/crewly/secrets/<home id>/vault-key`,
outside `~/.crewly`. It is also on the guard's list.
- An agent running as root can still read it if it looks. This is
  obscurity plus the guard, nothing more.
- `CREWLY_API_TOKEN` stays in the systemd drop-in. Agents do not inherit it
  (`sanitizeEnv`).
- The token-file mirror now writes a sealed file, and `crewly token` over
  SSH (same HOME) opens it with the key file.
- Port 8787 keeps working with the same token.

**Next step (not in this PR).** Run agents as a separate OS user, as in
#1012 §4 step 3. On Linux, a `crewly-agent` user, or systemd `DynamicUser`
per agent, can be denied `/root` entirely. That is the real fix for both
platforms. It changes project ownership, git credentials, each runtime's
login state and how agents reach the Chrome bridge.

## Layer 4: detection

The guard POSTs `{"event":"CredentialAccessBlocked","rule":…,"runtime":…}`
to `/api/agent-hooks`, with the session and the badge. The command itself is
never sent.

`CredentialGuardAlertService`:
- logs a WARN for every block;
- tells the owner through the Slack owner-alert notifier **at most once per
  agent per 24 h**, with the attempt count since the last notice.

A forged report (the route takes a session header) costs at most one notice
per session name per day. When Slack is not connected, no notice is sent and
the day is not used up.

## Layer 5: the cause

- **Binary downloads fixed.** `googleRequest` has `responseType: 'buffer'`,
  which reads `arrayBuffer()`, and `DriveService.readContent` uses it. A test
  sends bytes `0x80`–`0xFF` and gets them back exactly.
- **`docs-read` on an Office file.** It now returns 400 `validation`:
  "This is an Office file (.docx) stored in Drive, not a Google Doc … use
  drive-read --out <name>.docx". It no longer says "retry later".
- **crewly-agent `web_search`** read the Cloud token itself. It now calls
  `POST /api/cloud/search` (owner, or an agent identified by its badge), and
  the backend calls Cloud with its own token.

**Still open (reported, not built).**
- No comment skill or route. Posting a comment on a file the app did not
  create also fails under the `drive.file` scope.
- Cloud mints an all-product token when `product` is omitted. Cloud should
  require it.
- `docs-read` could extract text from a `.docx` server-side.

## Migration on live machines

1. **Mac (owner) and the Air.**
   - Upgrade, then restart the backend through the supervisor (build first).
   - The first boot creates `crewly:vault-key` in the login keychain and
     seals the files. The log shows `Credential vault: migrated credential files`.
   - The backend runs from a Terminal login item, so the keychain is
     unlocked and no dialog is expected. If it is locked, the log says the
     files stay plain; restart after login.
   - Check: `crewly token` prints the same token as before, and
     `jq .token ~/.crewly/cloud/config.json` prints `null`.
   - Then rotate the Cloud login (incident).
2. **steamfun-ops.**
   - Upgrade with npm and restart the service.
   - The `file` store creates `/root/.local/share/crewly/secrets/<id>/vault-key`.
   - `crewly token` over SSH works. Remote access on 8787 is unchanged
     (token from the drop-in env).
   - Codex agents are guarded only if their Codex lists
     `--dangerously-bypass-hook-trust`; the launch log says which.
3. **Rollback anywhere.** Set `CREWLY_SECRET_STORE=legacy` and restart: files
   are unsealed back to plain. Then downgrade if needed. An older Crewly
   cannot read sealed files: it sees "not logged in", and Slack and Telegram
   do not start.

## Tests

- `secret-store.test.ts`: a fake `security`, so no real keychain. Covers:
  the value is never in argv; missing vs error; `onlyIfAbsent`; a timeout
  latches the keychain off; foreign values; the file store's modes; store
  selection.
- `credential-vault.test.ts`: seal and unseal; key creation, including the
  race and the locked keychain; JSON public fields; locked vs missing; plain
  passthrough; binary; backup export; the wrapper helpers.
- `credential-files.test.ts`: migration seals, verifies and is idempotent;
  no key leaves files plain and creates no key; a non-object is left alone;
  rollback; the inventory.
- `api-token.service.test.ts`: a sealed generated token; ephemeral on a
  locked key, file untouched; the env mirror sealed.
- `guard.test.ts` (real script): the incident commands in the Claude, Codex
  and agy formats; 12 blocked variants; relative paths in the home; the
  Read, Grep and Gemini `read_file` tools; allowed lookalikes; agy prints
  nothing when allowing; the owner's own agy is never judged; a missing
  paths file; the backend report (rule only, no command).
- `credential-guard.service.test.ts`: the paths file and wrappers; Claude
  deny rules; Codex args (including resume); Gemini settings; the agy hooks
  file (merge, remove, non-object).
- `control-plane-guard.service.test.ts`: the credential group goes after
  the control-plane group; no duplicate rules; its own dir is
  write-protected.
- `runtime-agent.service.abstract.test.ts`: Codex hook after resume; the
  Gemini settings variable; the agy hooks entry; the codex probe mocked, so
  no real `codex` runs.
- `credential-guard-alerts.test.ts`: once per agent per day, attempt counts,
  no Slack.
- `agent-hooks.controller.test.ts`: the block event (rule and runtime only).
- `cloud.controller.test.ts`: `cloudSearch` (401/403/503/200, token never
  returned); `mobilePair` owner-only.
- `owner-routes.integration.test.ts`: `mobile-pair` and `workspace/token`
  through the real middleware.
- Google: `google-api.client.test.ts` (buffer), `drive.service.test.ts`
  (byte-exact .docx), `docs.service.test.ts` (Office file).
- `backup-archive.service.test.ts`: sealed files are archived plain.
- crewly-agent (vitest): `credential-guard.test.ts` (real script),
  `web-search.tool.test.ts` (backend mode, no Authorization header).
