# Agent credential isolation (first step of #1012 item 4)

Builds on `specs/2026-10-03-security-followups-1012.md` §4 ("same-user
isolation"). The owner approved the first step on 2026-10-04.

The work ships in two PRs:
- **PR A (#1044):** the runtime guard, detection, the owner-only routes, and
  the connector fixes that removed the reason for the workaround. It never
  changes a credential file.
- **PR B (later, off main after A):** sealing the credential files at rest.
  The first draft was review-blocked (NO-GO for live machines): file sealing
  can strand an owner who is away. The plan for it is in §PR B below; the
  draft lives on branch `feat/credential-vault-sealing`.

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
   for the owner, including `gmail.send`. She downloaded the file with it.
5. Asked to comment on the doc, she used the raw token again. The POST got
   403 (`drive.file` cannot write a file the app did not open). She moved to
   the browser.

`googleRequest` is not something Ruth wrote. It is the backend's own Google
client (`services/google/google-api.client.ts`). She found it while reading
the source.

**This bypasses per-person connector access (#968):** she acted with the
machine's Cloud identity. Agents run as the backend's OS user, so every
credential file under `~/.crewly` is readable.

**Owner action (not code):** the Cloud refresh token and a Google token are
in agy's transcript under
`~/.gemini/antigravity-cli/brain/2511b952-…/.system_generated/logs/`, and they
were sent to the Gemini API as context. Rotate with `crewly cloud logout` and
then `crewly cloud login`, and delete those transcript files.

## Inventory: bearer secrets under CREWLY_HOME

All of them are on the guard's list (`services/core/credential-files.ts`).

| File | Secret | Readers |
|---|---|---|
| `api-token` | owner API token | backend, CLI (`crewly token`, onboard, bundle), 2 scripts |
| `cloud/` (`config.json`) | Cloud `token`, `refreshToken`, `relayToken` | backend, CLI (`cloud`, `backup`, skill submit); crewly-agent `web_search` (removed in PR A) |
| `harness-credentials.json` | Claude OAuth, Anthropic/OpenAI/Gemini keys | backend, CLI `runtime-auth` |
| `settings.json` `apiKeys` | provider keys | backend, CLI (agents receive these keys in env by design) |
| `slack-credentials.json` | bot/app token, signing secret | backend |
| `slack-agent-identities.json` | one bot token per agent | backend |
| `slack-cloud-config.json` | workspace and agent bot tokens | backend |
| `telegram-credentials.json` | bot token | backend |
| `<platform>-credentials.json` (messenger route) | raw bot tokens | none found |
| `credentials/` (`master.key`, `*.enc`) | encrypted credential store and its key | backend |
| `whatsapp-auth/` | WhatsApp session | Baileys |
| `claude-accounts/` | Claude logins | Claude CLI |

Not secret: `device.json`, relay queue notices, `slack-instance.json`. The
owner session and badge secret live only in memory. `CREWLY_AGENT_BADGE`
is minted per agent and is meant for agents.

## PR A

### Owner-only routes

Two routes handed credentials to any local caller, agents included:

| Route | Returned | Now |
|---|---|---|
| `POST /api/cloud/mobile-pair` | Cloud access + refresh token | owner-only; the phone pairs with the API token from the LAN, which is an owner credential |
| `GET /api/workspace/token` | a raw Google token | owner-only |

### Layer 2: runtime guard

One script, `config/hooks/credential-guard/guard.sh <format> [paths-file]`,
is run through a generated per-format wrapper
(`<CREWLY_HOME>/runtime/credential-guard/hook-<format>.sh`). The paths file,
`runtime/credential-guard/paths`, lists the home and each guarded path in
absolute form. It is written at boot and at each launch.

**What the script judges (real paths only).**
- **Shell commands** (Bash, `run_shell_command`, agy `run_command`) are
  tokenised like a shell:
  - quotes and escapes are honoured;
  - `$(…)` and backticks are recursed into, so Ruth's
    `"Bearer $(jq -r .token ~/.crewly/cloud/config.json)"` is caught;
  - `~` is expanded at the start of a word and after `=`/`:`, as bash does,
    but not inside quotes;
  - `$HOME`, `${HOME}`, `$CREWLY_HOME` and `${CREWLY_HOME}` are expanded,
    except inside single quotes.

  A word is a candidate only when the **whole word** (or the value after
  `=`) is a path: absolute, or containing `/` and resolved against the
  call's cwd. That rules out three kinds of false positive:
  - a **bare word** (`cloud`, `credentials`, `settings.json`, `api-token`)
    never matches, whatever the cwd or a `cd`;
  - a **quoted sentence** that mentions a path (a commit message) is one
    word that is not a path;
  - a **grep pattern** with a quoted `~` is literal, as in a shell.
- **File tools:** only argument fields whose name says path, file or dir
  (`file_path`, `path`, `AbsolutePath`, …), resolved against the cwd.
  Content fields are never read, and write, replace, edit and create tools
  are not judged (agy `write_to_file` contents mentioning a path are fine).
- **Keychain:** `security find-generic-password | find-internet-password |
  export | -i` in a command that names `crewly`, and any
  `security dump-keychain`.

The matcher runs under `node`, as `report.sh` already does. On a block the
agent gets, in English: "Blocked: this reads Crewly's own credentials
(<rule>). Crewly credentials are not available to agents. Use the connector
skills instead (docs-read, docs-comment, drive-read, sheets-read,
gmail-search, ...) …".

**Fail-open everywhere.** Each wrapper allows the call when there is:
- no `CREWLY_SESSION_NAME` (the owner's own runtime; agy's hooks file is
  global);
- no guard script (Crewly uninstalled or moved);
- no node;
- no paths file;
- unparsable input.

The agy wrapper never passes the script's exit status through. It prints the
script's output only when it is a deny decision, and always exits 0. agy
reads a non-zero exit, and `{}`, as **deny**. Without this a missing script
(exit 127) would refuse every tool call in every agy session, the owner's
included.

| Runtime | Mechanism | Deny contract | Verified |
|---|---|---|---|
| Claude Code | PreToolUse group `Bash\|Read\|Grep\|Glob\|NotebookRead` plus `Read(//…)` deny rules, merged into the control-plane `--settings` file | exit 2, reason on stderr | unit tests |
| Codex | `codex --dangerously-bypass-hook-trust -c 'hooks.PreToolUse=[{matcher="Bash",…}]'`, added after the resume and `--no-daemon` rewrites. The flag is probed in `codex --help`; if it is missing, Codex launches unguarded with a WARN (an unknown flag would stop it starting) | exit 2 | research run against codex-cli 0.160 with a fake model: a `-c` hook is ignored without the trust flag, and blocks with it |
| Gemini CLI | `GEMINI_CLI_SYSTEM_SETTINGS_PATH=<file>` with a BeforeTool hook; the machine's own system settings are merged in | exit 2 | research run against 0.40.1 |
| Antigravity (agy), the incident runtime | entry `crewly-credential-guard` in agy's global `~/.gemini/config/hooks.json`; agy has no per-process hooks path | stdout `{"decision":"deny",…}`; an allowed call prints **nothing** | research run against agy 1.2.14 with Crewly's real flags: `view_file` and `run_command` both denied |
| crewly-agent (in-process) | `bash_exec`, `read_file`, `grep` and `glob` run the same script (Claude format) first | its own tool error | vitest with the real script |
| OpenCode | **none.** It has `permission` deny globs and `tool.execute.before` plugins; neither is wired yet (follow-up) | — | — |

**agy hook command.** agy runs the command through `sh` (verified on
1.2.14) and denies on any non-zero exit. The entry is therefore
`[ -f '<wrapper>' ] || exit 0; exec bash '<wrapper>'`, which allows when the
wrapper is gone (`~/.crewly` deleted). `test -f W && bash W` would deny, so
that form is not used.

**agy hooks file handling.**
- Every other entry is kept. The file's mode is kept.
- A symlinked `hooks.json` (dotfiles) is written **through** to its target
  and never replaced.
- A dangling link, or a file that is not a JSON object, is left alone, and
  agy runs unguarded with a WARN.
- The entry is **removed** when the kill switch is set (at boot and at each
  agy launch).
- If Crewly is uninstalled without that, the entry stays, but its wrapper
  fails open (see above).

`--dangerously-skip-permissions` overrides agy's `command(...)` deny rules,
so only a hook stops its shell. `read_file(...)` deny rules are not used,
because they would also bind the owner's own agy.

**Kill switch:** `CREWLY_CREDENTIAL_GUARD=0` in the backend's environment.
The guard's own directories (`runtime/credential-guard/` and
`config/hooks/credential-guard`) are on the control-plane write-deny list for
Claude Code.

#### What layer 2 stops and what it does not

| Stops | Does not stop |
|---|---|
| The incident's exact commands (`jq -r .token ~/.crewly/cloud/config.json` inside `$(…)`, `view_file …/cloud/config.json`) and their common variants: `$HOME`, `${HOME}`, `$CREWLY_HOME`, `//`, redirection, `--opt=~/…`, relative paths with a `/` | Paths built at runtime: `$(echo …)`, base64, globs like `~/.cr*ly`, other variables |
| `security find-generic-password … crewly…` | A bare relative name in the Crewly home (`cat api-token` with cwd `~/.crewly`), by design: bare words never match |
| | A script the agent writes and then runs. Interpreters reading a computed path |
| | OpenCode agents. Anything a same-user process can do outside a tool call |

Nothing in PR A changes the credential files, so an agent that gets past the
guard can still read them. PR B is the next layer.

### Layer 4: detection

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

### Layer 5: the cause

- **Binary downloads fixed.** `googleRequest` has `responseType: 'buffer'`,
  which reads `arrayBuffer()`, and `DriveService.readContent` uses it. A test
  sends bytes `0x80`–`0xFF` and gets them back exactly.
- **`docs-read` on an Office file** returns 400 `validation`. The message
  says to read it with `drive-read --id <id> --out <name>.docx`, and that
  `docs-comment` (#1042, Drive comments API) works on any Drive file for
  list, add, reply and resolve. It no longer says "retry later".
- **crewly-agent `web_search`** read the Cloud token itself. It now calls
  `POST /api/cloud/search` (owner, or an agent identified by its badge), and
  the backend calls Cloud with its own token.
- **Commenting:** `docs-comment` covers this now (#1042). Adding a comment
  on a file the Crewly app did not create still needs the full Drive scope;
  that skill reports it.
- **Still open (Cloud):** Cloud mints an all-product token when `product`
  is omitted. It should require `product`.

### Migration (PR A)

Nothing to migrate.
1. **Mac and the Air:** upgrade, build, and let the supervisor restart the
   backend. Check the launch logs:
   - "Credential guard: active" for each runtime;
   - for agy, `~/.gemini/config/hooks.json` gains `crewly-credential-guard`.
2. **steamfun-ops (Codex):** upgrade with npm and restart. The launch log
   says whether its Codex lists `--dangerously-bypass-hook-trust`; if not,
   Codex is unguarded until it is upgraded.
3. **Off switch:** `CREWLY_CREDENTIAL_GUARD=0`, then restart. This also
   removes the agy entry.

## PR B: sealing credential files at rest (plan)

**Goal:** an agent that gets past the guard (`cat`, `view_file`) still reads
no token. The draft is on branch `feat/credential-vault-sealing`.
- **Mechanism:** one vault key; AES-256-GCM for the secret fields; public
  fields stay in clear.
- **Key store:** the macOS login keychain through `security -i` on stdin,
  with a 5 s timeout and no dialogs; on Linux, a 0600 file outside
  `~/.crewly`.

### Review blockers PR B must address

1. **Rollback.** `CREWLY_SECRET_STORE=legacy` must check `legacy` *before*
   the cached key and clear the cache. Unsealing writes atomically (temp file
   then rename, with the mode kept).
2. **No read-modify-write on a locked or unreadable sealed file.** That
   covers `HarnessCredentialsStore.write`, the CLI `saveCloudCredentials`
   merge, the Slack identity and cloud-config saves, `mirrorEnvTokenToFile`,
   and every other writer that reads first. They must refuse (an error and
   an alert), never write a partial object over the sealed one.
3. **Never mint a key while sealed files exist.** If any listed file is
   sealed and no key can be read, key creation is refused. Each blob carries
   a key fingerprint (`v1.<fp8>.<iv>.<tag>.<data>`), so a wrong key is told
   apart from a corrupt file and is reported as such.
4. **Two-phase rollout.**
   - **B1:** reads both forms but always writes plain. It ships first and
     stays out long enough that every machine, including dev checkouts that
     switch branches and owners who downgrade, can read sealed files before
     any exist.
   - **B2:** turns sealing on.
5. **Key unavailable is loud.** While a sealed file cannot be opened:
   - retry with backoff;
   - alert the owner (once a day);
   - surface it in `/health` (`credentialVault: { state, since, reason }`).

   The API token never silently falls back to a temporary value that hides
   it.
6. **Backup.** `crewly backup` unseals only the listed credential paths, by
   streaming each one into the archive. No generic content sniffing of every
   file.
7. **Atomic unseal writes** (see 1) and atomic seal writes, with a
   verify-then-rename (already in the draft).

The draft's other design points carry over:
- the keychain ACL is not restricted to node (infeasible without dialogs;
  reasoning in the draft);
- Linux uses the `file` store (libsecret needs a desktop session; `keyctl`
  is readable by root and lost on reboot).

**Next step after B:** run agents as a separate OS user (#1012 §4 step 3).

## Tests (PR A)

- `guard.test.ts` (real script):
  - the incident commands in the Claude, Codex and agy formats;
  - 14 blocked variants;
  - the reviewer's false positives allowed: `cd ~/.crewly/teams && echo "check cloud status"`, `npm test -- credentials` with the cwd in the Crewly home, bare words, a commit message and a grep that mention the path, a single-quoted `~`, a URL;
  - agy `write_to_file` content not judged;
  - agy prints nothing when allowing;
  - the owner's runtime is never judged;
  - a missing paths file, and unparsable input;
  - the backend report carries the rule only.
- `credential-guard.service.test.ts`:
  - the paths file (absolute only);
  - **wrappers fail open**: a missing script for every format; no session; an agy script that crashes or prints `{}` becomes allow; a deny passes through;
  - Claude deny rules, Codex args (including resume), Gemini settings;
  - the agy hooks file: merge, remove, mode kept, symlink written through, dangling link left alone, non-object left alone.
- `credential-files.test.ts`: the inventory.
- `control-plane-guard.service.test.ts`: the credential group's order and rules.
- `runtime-agent.service.abstract.test.ts`: the Codex hook after resume, the Gemini variable, the agy entry.
- `credential-guard-alerts.test.ts`, `agent-hooks.controller.test.ts`: detection.
- `cloud.controller.test.ts`, `cloud.routes.test.ts`, `owner-routes.integration.test.ts`: `cloudSearch`; `mobile-pair` and `workspace/token` owner-only.
- `google-api.client.test.ts`, `drive.service.test.ts`, `docs.service.test.ts`: buffer, byte-exact `.docx`, the Office hint.
- crewly-agent (vitest): `credential-guard.test.ts`, `web-search.tool.test.ts`.
