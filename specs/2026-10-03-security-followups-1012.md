# Security follow-ups to #999 / #1010 (#1012)

Builds on `specs/2026-10-03-owner-auth.md`. That spec added one classifier
that decides who is calling from credentials:
- `owner`;
- `relay-owner`;
- `cloud`;
- `agent:<session>`;
- `anonymous`.

It listed several holes as out of scope. This spec closes them with the
same classifier and the same helpers (`requireOwner`, `ownerOnly`,
`rejectNonOwner`, `getCallerIdentity`).

**No new environment variables and no new credentials.** The steamfun-ops
systemd drop-in therefore needs no change.

| # | Item | Status |
|---|---|---|
| 1 | `POST /api/sessions` opens an arbitrary local terminal | Partly closed: `/api/sessions/*` writes are owner-only; `/api/terminal/*` writes are still open to anonymous local callers (follow-up issue) |
| 2 | `PUT /api/settings` leaks and overwrites keys | Closed |
| 3 | Forged owner chat rows | Closed |
| 4 | Same-OS-user agent isolation | First step built: credential vault + runtime guard (`specs/2026-10-04-agent-credential-isolation.md`); separate OS user still owed |
| 5 | Extension can act in the dashboard tab | Design only; needs a `chrome-extension` change (§5) |

## 1. Terminal sessions

### Problem

`POST /api/sessions` spawned a PTY with any `command`, `args`, `cwd` and
`env` from the request body, and it had no caller check. Because `args` go
to `/bin/bash`, a body like `{"args":["-c","…"]}` runs anything.

`POST /api/sessions/:name/write` writes raw keystrokes into an existing
session. Together, the two routes let any local process open a shell or
type into the orchestrator's terminal.

There was also a precedence bug:

```ts
command || process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'
// parses as (command || isWin32) ? 'powershell.exe' : '/bin/bash'
```

Any explicit `command` therefore launched `powershell.exe`.

### Callers of `/api/sessions`

- **Harness:** spawns agent PTYs in process
  (`getSessionBackend().createSession`), not over HTTP.
- **MCP server:** these routes were written for it, and it no longer
  exists.
- **Dashboard:** reads `GET /api/sessions` for PTY status and calls
  `POST /sessions/previous/dismiss`.
- **`crewly status`:** reads `GET /api/sessions`.
- **Phone relay:** the allowlist (`MOBILE_API_ALLOWLIST`) has no
  `/sessions` entry.
- **Agents:** message each other through `/api/terminal/:s/*`, not these
  routes.

### Fix

- **Owner-only** (`ownerOnly` in `session.routes.ts`):
  - `POST /sessions`
  - `POST /sessions/:name/write`
  - `DELETE /sessions/:name`
  - `POST /sessions/:name/oauth-callback`

  Agents get 403. A caller with no credential gets 401
  `owner_auth_required`. The owner can already run a shell, so for the
  owner nothing is lost.
- **Default command:** now `command || DEFAULT_SHELL`.
- **Reads stay open:**
  - `GET /sessions`
  - `GET /sessions/:name`
  - `GET /sessions/:name/output`
  - `GET /sessions/previous`
  - `POST /sessions/previous/dismiss`

### Still open: `/api/terminal/:s/*` (follow-up issue)

These routes still accept anonymous local callers:
- `POST /api/terminal/:s/write`
- `POST /api/terminal/:s/deliver`
- `POST /api/terminal/:s/input`
- `POST /api/terminal/:s/key`
- `DELETE /api/terminal/:s`

They cannot simply become owner-only, because agents write into each
other's terminals by design: `send-message`, `handoff-task`,
`delegate-task`, the orchestrator's `send-message`, `broadcast`,
`send-key`, `resume-session` and `terminate-agent`.

What can be done is refusing **anonymous** callers. These routes would then
need an owner credential or an identified agent. That first requires moving
the in-process callers that send no credential onto
`internalAgentHeaders`, or onto a dedicated internal credential:
- `runtime-smoke-test.service.ts` (`/deliver`, `/output`, `DELETE`,
  `/exists`);
- `runtime-exit-monitor.service.ts` (`/deliver` to the orchestrator);
- `slack-orchestrator-bridge.ts` (`/deliver`).

Any caller outside the repo that sends no credential would also need
checking. The work overlaps the delivery changes in #1015, so it is tracked
separately.

## 2. Settings and provider API keys

### Problem

- **Leak.** `PUT /api/settings` returned the saved settings with every
  provider API key in full, to any caller: `PUT {}` printed them all.
  These routes did the same and had no caller check either:
  - `POST /reset`;
  - `POST /reset/:section`;
  - `POST /import`;
  - `POST /export`, which is the full file by design.
- **Overwrite.** `GET /api/settings` masks keys (`••••••••abcd`). The
  dashboard's API Keys tab loads that masked copy and saves the whole
  `apiKeys` object back. Saving any one key therefore replaced every other
  saved key with its mask: global keys, runtime overrides and skill
  overrides.
- **Broken skill fallback.** The `transcribe-audio` and
  `screenshot-compare` skills read their key from the masked `GET`. That
  fallback sent `••••••••abcd` to OpenAI or Gemini.

### Fix

- **Owner-only:**
  - `PUT /settings`
  - `POST /settings/reset`
  - `POST /settings/reset/:section`
  - `POST /settings/import`
  - `POST /settings/export`

  These stay open:
  - `GET /settings` (masked);
  - `POST /settings/validate`;
  - `POST /settings/test-api-key`, which tests a key the caller supplies
    and returns no stored key.
- **Masked responses.** Every settings response except `export` masks
  `apiKeys` (`maskedSettings`). `export` is the owner's own backup.
- **Masks are never saved.** `mergeSettings` runs every API-key update
  through `restoreMaskedApiKeys`. A value that `isMaskedApiKey` recognises
  (it starts with `••••`) keeps the stored key for that slot: global,
  runtime override or skill override. A mask with no stored key behind it
  is dropped. Real provider keys never start with `•`.
- **Key path for skills.**
  `GET /api/settings/api-key/:provider?skill=<id>&runtime=<runtime>`
  returns `{ provider, key }`. It resolves the key through the existing
  chain: skill override, then runtime override, then global, then the
  environment.

  | Caller | Answer |
  |---|---|
  | Owner (dashboard session, API token, relay) | 200 |
  | Agent identified by its badge, or by the process tree | 200 |
  | Agent with only the legacy `X-Agent-Session` header | 403 `agent_badge_required` (any local process can set that header) |
  | No credential | 401 `owner_auth_required` |
  | Unknown provider | 400 |
  | Provider with no key | 404 |

  Agents already receive these keys in their environment. The route does
  not widen who can read them; it closes reading them to everyone else.
- **Skills.**
  - `transcribe-audio` and `screenshot-compare` call the key route with
    `X-Agent-Badge` and `X-Agent-Session`.
  - An environment variable still wins.
  - A masked value is never used as a key.
  - Empty header arrays use `${arr[@]+"${arr[@]}"}`, because macOS ships
    bash 3.2.
- **Related `transcribe-audio` fix.** With the default `language=auto`,
  the OpenAI engine's empty `lang_args` array aborted under `set -u` on
  bash 3.2. It now uses the same guard.

### Callers checked

- **Dashboard Settings page:** axios through the owner-session interceptor
  (cookie + CSRF), so it is the owner. Saving the masked copy back now
  keeps the stored keys.
- **Phone and portal:** no `/settings` entry in the relay allowlist;
  unchanged.
- **CLI, crewly-agent, other skills, crewly-pro:** none write settings.

## 3. Forged owner chat rows

### Problem

`POST /api/chat/channels/:id/messages` decided "agent or owner" from the
raw `X-Agent-Session` header. A post without that header was stored as a
`user` row, the owner's own words. So was a post carrying only the badge.

`ChatV2Service.getRecentOwnerMessageContents` treats `user` rows as owner
evidence, and these consumers rely on it:
- the WhatsApp draft gate (「发 W12」, "send W12");
- the commitment-approval guard;
- owner-login evidence;
- skill-install confirmation.

An agent could therefore post 「发 W12」 or "approved" without its header and
then act on its own message.

### Fix

`principalFromRequest` takes the agent session from the caller-identity
classifier, not from the header. `rejectUnidentifiedChatWriter` runs in
front of every chat-v2 write:
- `POST /channels`
- `POST /channels/dm/ensure`
- `POST /channels/team/ensure`
- `POST /channels/huddle`
- `DELETE /channels/:id`
- `POST /channels/:id/messages`

| Caller | Result |
|---|---|
| Owner session (+ CSRF), owner API token, relay | Allowed; stored as the owner (`user` row) |
| Agent with a known session (badge, process tree, or legacy header during the migration window) | Allowed; stored as that agent: an `agent` row in its own channel, otherwise a `user` row tagged `authorAgentSession`, which owner evidence excludes |
| Agent process whose session is unknown (matched by ancestry only) | 403. Otherwise it would be stored as the owner |
| No credential, the cloud credential, the self-set `X-Crewly-Caller: dashboard` | 401 `owner_auth_required` (the dashboard refreshes its session and retries once) |

Reads keep their current behaviour.

The other surfaces write in process through platform-verified bridges,
not through this route, so they are unchanged:
- Slack events;
- the Cloud relay adapter;
- Telegram;
- Google Chat;
- WhatsApp;
- Cloud Talk.

### Callers checked

- **Dashboard team chat:** the `@crewly/chat-ui` client uses
  `window.fetch`, which the owner-session wrapper sends with CSRF. The
  client is built after bootstrap.
- **`reply-channel` skill:** `api_call` sends the badge and the session
  header.
- **Portal and phone chat:** the relay adapter calls `ChatV2Service` in
  process.
- **Phone on the LAN:** API token from a LAN address, so it is the owner.

## 4. Same-OS-user agent isolation (design, not implemented)

### Problem

Agents run as the owner's OS user. The process-tree check from #1010
raises the bar, but it is not a boundary:
- **Escaping the process tree.** These leave the agent's process tree and
  its PTY's terminal:
  - `setsid` plus a double fork;
  - launchd (`osascript`, `open`);
  - a hop through another local service.
- **Readable secrets.** Agents can read `~/.crewly/api-token`, the Cloud
  token and the owner's browser profile. File permissions do not stop a
  process running as the same user.
- **Remote use.** A stolen API token works from another machine, where no
  process check runs.
- **Memory.** On Linux with `ptrace` allowed, a same-user process can read
  backend memory, which holds the session and badge secrets.

### Design: three steps, each shippable alone

1. **Keep the owner token out of agents' reach.**
   - Store the API token in the OS keychain instead of
     `~/.crewly/api-token`: macOS Keychain, or libsecret on Linux desktops.
   - On macOS the item's access control list names the signed `crewly`
     CLI and backend binaries. An agent's
     `security find-generic-password` then prompts the owner instead of
     returning the token.
   - Headless Linux (steamfun-ops) keeps `CREWLY_API_TOKEN` in the systemd
     drop-in. Agent PTYs already do not inherit it (`sanitizeEnv`). The
     token-file mirror from #1010 becomes opt-in there.
   - The CLI reads the token from the keychain, then the env, then
     (legacy) the file.
2. **Make a stolen token useless off the machine.**
   - Accept the raw API token from a non-local address only when the owner
     opts in (`CREWLY_REMOTE_TOKEN=1`).
   - LAN phones and `crewly token --url` move to per-device credentials
     that the owner mints. They are revocable and listed in Settings.
   - **Rollout:** steamfun-ops uses the raw token remotely today, so the
     default stays on until it has a device credential. The switch is
     announced one release ahead.
3. **Run agents as a separate OS user, or in a sandbox.**
   - **macOS:** the installer creates a `crewly-agent` user. Agent PTYs are
     spawned through a scoped `sudo -u` rule or a launchd agent running as
     that user. Project directories are shared through a group.
   - **Linux:** the same separate user, or `bubblewrap` / systemd
     `DynamicUser` per agent.
   - File permissions then put the owner's home directory, keychain and
     browser profile out of reach. The process-tree check becomes a
     backstop.
   - This is the real fix and needs its own spec. Things it changes:
     - project file ownership;
     - git credentials;
     - the Claude and Codex login state each runtime keeps in the home
       directory;
     - how agents reach the Chrome extension bridge.

## 5. The browser extension in the dashboard tab (design; extension change)

### Problem

An agent driving the owner's Chrome through the extension can run
JavaScript (`executeJs`, CDP evaluate) or send input in any open tab. That
includes a Crewly dashboard tab, which already holds the owner session and
can read its CSRF token. That is an owner credential reachable by an
agent.

### Design

- **In the `chrome-extension` repo:** refuse every agent-driven action in
  a tab whose origin is a Crewly dashboard:
  - `executeJs` / evaluate;
  - click, type and key input;
  - navigate.

  Owner-initiated takeover input is not blocked.
- **Which origins.** The extension builds the list:
  - the backend origin it is paired with on the LAN or locally
    (`http://localhost:<port>`, `http://127.0.0.1:<port>`, and the LAN
    address);
  - any origin the backend reports.
- **Backend follow-up.** `GET /api/browser/dashboard-origins` returns the
  origins this backend serves the dashboard on. Opening a dashboard origin
  in an agent-driven tab is refused with a clear error to the agent.
- **Defence in depth on the backend.** `GET /api/auth/session` already
  refuses agent processes. A request from the extension's own context
  carries no owner cookie, because the cookie is `SameSite=Strict` and
  `HttpOnly`. So the remaining exposure is script running inside the page,
  which only the extension can stop.

## Tests

- `session.controller.test.ts`: the default-shell precedence fix.
- `session.routes.test.ts` (new): owner-only create, write, kill and
  oauth-callback (anonymous 401; agent with badge, legacy header and the
  dashboard marker refused); owner and relay allowed; reads open.
- `settings.controller.test.ts`: the real router behind the real
  classifier. It covers:
  - owner-only writes;
  - masked `PUT` and `import` responses;
  - the full export;
  - saving the masked copy back keeps the stored keys;
  - the key route: badge agent, owner and skill override allowed;
    legacy header 403; anonymous and an invalid badge 401; 404; 400.
- `settings.types.test.ts`: `isMaskedApiKey`, `restoreMaskedApiKeys`, and
  `mergeSettings` keeping stored keys.
- `chat-v2.controller.test.ts`: forged 「发 W12」 attempts never reach
  `getRecentOwnerMessageContents`:
  - anonymous: 401;
  - the dashboard marker: 401;
  - the cloud credential: 401;
  - badge-only: stored as the agent;
  - legacy header: stored as the agent;
  - process tree without a session: 403.

  The owner (session + CSRF) and the relay count as the owner; an agent in
  its own channel is an `agent` row; other writes are gated the same way;
  reads stay open.
- `owner-routes.integration.test.ts`: the new owner-only routes, the
  chat-v2 gate and the key route, through the real `/api` middleware
  chain.
- `transcribe-audio/execute.test.sh` and
  `screenshot-compare/execute.test.sh` (new). A fake `curl` checks that:
  - the key comes from the key route with the badge;
  - the masked `GET` is never read;
  - without a badge there is no key and no provider call;
  - an environment key still wins.

  Both pass under bash 3.2 and 5.
- `config/skills/registry.json` regenerated (the `transcribe-audio` size).
