# Owner auth: callers are identified by credentials, not by a missing header (#999)

## Problem

Most owner-only routes decided "this is the owner" because the request had
**no `X-Agent-Session` header**. Every agent runs on the same machine, so an
agent could do anything the owner can by leaving the header out:

- answer its own decision cards;
- verify or accept its own tickets;
- raise its own token caps;
- trigger an upgrade or a restart;
- change connector sharing;
- send Gmail directly instead of drafting;
- approve its own approvals.

A second group trusted a self-set `X-Crewly-Caller: dashboard` header. A third
group had no caller check at all.

The fix cannot simply be "require the API token everywhere". The local
dashboard talks to the backend over loopback with no token, and it must keep
working with zero setup.

## Design

### 1. One classifier, five kinds of caller

`backend/src/middleware/caller-identity.middleware.ts` runs on every `/api`
request, after the API-token gate and the agent-origin check and before the
heartbeat middleware. It decides who the caller is from **credentials** and
stores the answer per request (a `WeakMap` keyed by the request object, so a
client cannot set it with a header).

| Kind | Credential | Notes |
|---|---|---|
| `agent:<session>` | A valid **agent badge** (`X-Agent-Badge`) | Always an agent, whatever other headers or cookies it sends. |
| `agent:<session>` (legacy) | `X-Agent-Session` with no valid badge | Migration window, one release. Logged as a warning, throttled per session. Never the owner. |
| `relay-owner` | The in-memory relay credential (`X-Crewly-Internal`) | Only `MobileApiRelayService` holds it. It carries the phone's and portal's calls, which the Cloud relay only delivers for the owner's own account. |
| `cloud` | The in-memory cloud credential (`X-Crewly-Internal`) | For Cloud-forwarded Slack envelopes posted to `/api/slack/interactivity`. |
| `owner` | The owner session cookie (plus CSRF on writes) **or** the owner API token | See §2. The raw API token from a process on this machine is checked against the process tree (§4). |
| `anonymous` | None of the above | Never the owner. |

Order of precedence, first match wins:
1. a valid agent badge;
2. any `X-Agent-Session` header;
3. the internal credential;
4. the owner session;
5. the owner API token;
6. anonymous.

Any sign that the caller is an agent wins over an owner credential. A
request with an invalid badge is never treated as the owner.

The process tree outranks the badge. Codex's shared app-server daemon ran
every agent's commands with the orchestrator's environment (2026-09-30). When
the agent-origin middleware proves from `X-Agent-Pid` that a skill shell
belongs to a different agent PTY, that session is used, not the badge's. The
correction travels in a `WeakMap`, not in a header the client could forge.

The classifier also normalises `X-Agent-Session` to the identified session.
Older code that reads the header therefore sees the authenticated identity.
The header is never **added**: `remote-browser --no-bind` drops it on purpose,
and the per-tab browser binding must keep seeing it absent.

### 2. Agent badge (the per-session agent token)

- `mintAgentBadge(session)` = `cab1.<base64url(session)>.<HMAC-SHA256>`. It is
  keyed by a secret that lives **only in the backend's memory**, generated at
  startup and never written to disk. Verification is stateless.
- The harness injects it at spawn time as **`CREWLY_AGENT_BADGE`**:
  - `buildAgentIdentityEnv` (PTY spawn and Step-2 recreation), the
    production path;
  - `CrewlyAgentExternalRuntimeService.buildChildEnv`.

  Not the legacy `TmuxService` paths. They are unused in production, and
  `TmuxCommandService.createSession` puts the environment on the
  `tmux new-session` command line, where `ps` shows it to every local
  process. It refuses secret names for that reason. A tmux-launched agent
  falls back to the legacy header path, so it is an agent but never the
  owner.
- The name deliberately avoids `TOKEN`, `KEY` and `SECRET`. Codex's default
  `shell_environment_policy` removes any variable whose name contains those
  words from the shells it runs, so a `CREWLY_AGENT_TOKEN` would never reach a
  Codex agent's skills. The value is still masked in session logs: it is in
  `SECRET_REDACTION_CONSTANTS.KNOWN_SECRET_ENV_NAMES`.
- Senders:
  - `api_call` and the skill heartbeat in `config/skills/_common/lib.sh` send
    `X-Agent-Badge` whenever `CREWLY_AGENT_BADGE` is set. Every skill that uses
    them gets it automatically.
  - Skills that call the backend with raw `curl` were updated one by one:
    intent tasks, the content-approval skill, the agent-status hook, and the
    curl templates in orchestrator skills.
  - `packages/crewly-agent` `CrewlyApiClient` sends it from the environment.
  - Backend services that call their own API on an agent's behalf use
    `internalAgentHeaders(session)`: workitem dispatch, TL auto-verify, the
    worktree notifier and the ticket assignee waker.
- After a backend restart the secret is new. The agents are relaunched by the
  restart, so they get new badges. A process that survives with an old badge
  falls back to its `X-Agent-Session` header, so it is still an agent and is
  still never the owner.

### 3. Owner session (dashboard)

- **Issuing.** The served UI sets an owner session cookie on page load: a
  middleware in front of the static files handles HTML navigations.
  `GET /api/auth/session` issues or refreshes it and returns the CSRF token.
  This is the path the Vite dev server and any already-open tab use.
- **Cookie.**
  - Name: `crewly_owner_<port>`, so instances on different ports of
    `localhost` don't collide; cookies ignore the port.
  - Flags: `HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age` 30 days, and
    `Secure` when the request is HTTPS.
  - Value: `<id>.<issuedAt>.<HMAC>`, keyed by the same in-memory secret.
- **CSRF.** The token is an HMAC of the session id. It is required as
  `X-Crewly-CSRF` on every write (`POST`, `PUT`, `PATCH`, `DELETE`) that relies
  on the cookie. A write with the cookie and no valid CSRF header is
  `anonymous`.
- **Who gets a session.**
  - A caller that already has an owner credential (session, API token or the
    relay credential).
  - A caller from this machine that carries no agent sign at all (no badge,
    no `X-Agent-Session`), **and** whose client process is not a descendant
    of the Crewly backend (§4). Agents are always spawned by the backend: PTY
    shells, crewly-agent children, and Codex daemons started from a PTY. The
    owner's browser, terminal, Vite dev server and Electron app never are.
  - Everyone else is refused: agents get 403, anonymous remote callers 401.
- **Frontend.**
  - `frontend/src/services/owner-session.service.ts` wraps `fetch` and installs
    an axios interceptor on the default instance; the frontend has no other
    axios instance. The bootstrap sequence in `main.tsx` installs these after
    the API-token interceptors.
  - Every same-origin `/api` write waits for the session bootstrap and carries
    `X-Crewly-CSRF`.
  - A `401 owner_auth_required` refreshes the session once and retries the
    request once. That covers a tab that stayed open across a backend restart.
  - The 401 deliberately carries no `WWW-Authenticate: Crewly-Token`, so the
    API-token prompt does not open.
- **Electron.** `desktop/` is only a setup wizard. It opens the dashboard in
  the system browser, which gets a session on page load like any other tab.
  The wizard calls no owner-only route.

### 4. Agents can't use owner secrets

| Secret | Readable by an agent shell? | What stops it being used |
|---|---|---|
| `~/.crewly/api-token` (0600, same OS user) | **Yes.** `cat` works; agents run as the owner's user. | When the token comes from **this machine** (loopback or any of the host's own interface addresses), the classifier finds the client process. It uses `lsof`, or `ss` on Linux, then reads one `ps` snapshot. The process is an agent's if any of these holds: <br>• it descends from the backend; <br>• it is on an agent PTY's terminal, which still catches a double-forked orphan; <br>• on Linux only, its environment holds `CREWLY_SESSION_NAME` or the badge. macOS does not expose another process's environment. <br>An agent's process does not become the owner by presenting the token. The verdict is cached per TCP socket, so a keep-alive dashboard or CLI pays for the lookup once. |
| `CREWLY_API_TOKEN` env | No. `PtySession.sanitizeEnv` already strips it. | `CrewlyAgentExternalRuntimeService.buildChildEnv` copied `process.env` wholesale; it now strips the variable too. |
| Owner session secret | No. It exists only in backend memory. | — |
| Relay and cloud internal credential | No. It exists only in backend memory. | — |
| Owner session cookie | Only through the owner's browser profile. | See residual risks. |
| Cloud token (`~/.crewly/cloud/…`) | **Yes.** | Not fixed here; see residual risks. |

The raw API token is no longer needed for normal local dashboard use. The
session replaces it. The token is still used by:
- remote and LAN dashboards (`crewly token --url`);
- the phone on the LAN;
- the relay;
- the CLI.

The CLI's local backend calls now send the owner API token automatically
(`cli/src/utils/owner-token-fetch.ts`, reading `CREWLY_API_TOKEN` or the
token file without generating one). `crewly onboard`, `crewly bundle`, harness
logins and `crewly desktop` therefore keep working against the now owner-only
routes. The same CLI run by an agent is refused by the process check.

**Env-only tokens.** A server whose token is pinned only in its service
environment (systemd on steamfun-ops) used to have no token file, so the
CLI in an ordinary shell had nothing to send. At startup the backend
mirrors the env token to `<CREWLY_HOME>/api-token` (mode 0600; this is
`mirrorEnvTokenToFile`):
- a missing file is written;
- a file holding a different value is rewritten, because the server only
  accepts the env token and a stale file can only produce 401s.

**Process lookup outcomes.** The lookup has three outcomes:

| Outcome | When | Result |
|---|---|---|
| `unknown` | The tool is missing (`ENOENT`) or the lookup timed out (3 s) | Fails open, logs a warning |
| `gone` | The lookup ran and found no client process | Fails closed: 401 |
| a verdict | The client process was found | `agent`, `not-agent` or `self` |

`gone` covers all of these:
- no matching socket;
- the process exited between `lsof` and `ps`;
- the peer already closed the socket. Node then clears `remoteAddress`, and
  an empty address is never treated as "remote".

An agent can write a request over a raw `/dev/tcp` socket and exit before
the lookup runs. That used to make it the owner (#1010 review). A test
reproduces it with a real `bash /dev/tcp` sender.

### 5. Owner-only routes

Every route listed in #999 now uses the classifier through one of these
helpers:
- `rejectNonOwner(req, res, agentBody)`: agents get the route's existing 403;
  anonymous callers get `401 { error: 'owner_auth_required' }`;
- the `requireOwner` middleware;
- `isOwnerCaller(req)`.

| Route class | Routes | Owner | Agent | Anonymous |
|---|---|---|---|---|
| Decisions | `decisions/:id/choose\|remind\|skip`, `skip-all` | ✓ | 403 | 401 |
| | `decisions/:id/cancel` | ✓ | asker / requester / orc only | 401 |
| Tickets | `tickets/:id/dismiss\|verify\|reject\|acceptance`, `PATCH tickets/:id`, `tickets/cleanup` | ✓ | 403 | 401 |
| | `requests/:id/open-items/:itemId/skip` | ✓ | 403 | 401 |
| Owner receipt | `owner-receipt/settings\|send` | ✓ | 403 | 401 |
| Harness | `harness/*` (install, orc, login flows, api-key) | ✓ | 403 | 401 |
| Bundles and onboarding | `bundles/apply`, `onboarding/*` | ✓ | 403 | 401 |
| System | `system/update-status\|upgrade\|restart`, `system/usage/caps\|boost`, `system/spend/*`, `system/runtime-terms/*` | ✓ | 403 | 401 |
| | `system/runtime-fallback` writes (settings, Claude accounts, smoke test) — previously no check | ✓ | 403 | 401 |
| Cloud device | `cloud/device/*` | ✓ | 403 | 401 |
| Connector sharing | `google\|microsoft-todo\|canva/sharing` | ✓ | 403 | 401 |
| | `google\|microsoft-todo\|canva` `default` and `disconnect` — previously no check | ✓ | 403 | 401 |
| | `PUT connectors/access/:id` — previously no check | ✓ | 403 | 401 |
| People and teams | `people/:id`; team member `dedicatedTo` | ✓ | 403 | 401 |
| | `teams/:id/lead` | ✓ | orc only | 401 |
| Browser | `browser/sessions/:id/input\|take-control\|release-control\|stop\|pending/:id` — four of these previously had no check | ✓ | 403 | 401 |
| Gmail | `google/gmail/held/:id` — previously no check | ✓ | 403 | 401 |
| | `google/gmail/send` | sends | drafts and holds | 401 (connector gate) |
| Approvals | `approvals/:id/approve\|reject` | ✓ | 403 | 403 |
| WhatsApp | `whatsapp/send` (inbox mode) | sends | 403 | 401 |
| | `whatsapp/drafts/:id/send` | sends | needs 「发 Wn」 | 401 |
| Chat | `chat/send` | stored as an owner message | stored as the agent's | 401 |
| Connector access | connector-gated routes | as the owner | as the agent's person, role allowlist | 401 |
| Project tickets | writes | owner rights | per-ticket rules | 401 |
| Task pool | verdicts / transitions (`resolveTransitionActor`) | owner | agent | agent without a session (unchanged) |
| Triggers and skill setup | `triggers`, `skill-setup/install` (`isOwnerDashboardRequest`) | owner | agent | internal (unchanged) |
| Team start | `teams/:id/members/:id/start` | gates skipped | gated | gated |
| OKR approvals and signal digests | `missions/:id/approve\|reject`, `signal-digests/:id/items/:n` (`requireOwnerToken`) | ✓ (session now accepted too) | 403 | 401 |
| Desktop remote | `PUT desktop/remote` (also loopback only), `desktop/remote/frame\|input` — previously no check | ✓ | 403 | 401 |
| Slack interactivity | Slack's signed `payload=` form | — | — | — (needs Slack's signing secret) |
| | Cloud-forwarded envelope | `cloud`, relay or owner credential | 401 | 401 |

`X-Crewly-Caller: dashboard` is no longer trusted anywhere.
`isOwnerDashboardRequest()` keeps its name for the callers that use it, but it
now means "the caller holds an owner credential". The dashboard still sends
the header, and `describeActor` no longer reads it.

**What "relay" allows.** The relay credential counts as the owner, because
the Cloud relay only pairs devices of the same Cloud account. The relay's
allowlist (`MOBILE_API_ALLOWLIST`) still limits what the phone can reach.

### 6. Rollout

- Machines auto-update. Backend, skills and frontend ship in one package, so
  they update together.
- **Migration window.** For one release, `X-Agent-Session` without a badge is
  still that agent, and the server logs a warning. This covers:
  - agents launched before the upgrade, which restart anyway;
  - shells whose runtime dropped the spawn environment. The chat-v2 and
    watchdog nudges that prefix `CREWLY_SESSION_NAME=` exist because of these.
  
  Removing this path is a follow-up. It needs a story for those shells first.
- **Dashboard.** A new tab gets the session on page load. Tabs that were
  already open are a different matter:
  - **Tab opened before the upgrade.** Its old bundle never asks for a
    session or sends CSRF, so **every** owner action in it gets 401 until
    the page is reloaded. Reads keep working.
    - So the owner knows what to do, a 401 to a browser with no valid
      session carries the plain instruction in `error`: "Reload this page —
      Crewly was updated." That is the text an old tab shows. The
      machine-readable reason stays in `code: owner_auth_required`. Scripts
      without browser headers keep `error: owner_auth_required`.
    - Old bundles cannot be told to reload: they have no handler for any
      server push.
  - **Tabs from this release on.** The backend stamps every `/api` response
    with the dashboard build it serves (`X-Crewly-Dashboard-Build`, the
    hashed entry script). It also sends `dashboard_build` on each socket.io
    connection. The dashboard has no app-wide socket, so the header is what
    reaches every tab.
    - A tab whose own entry differs shows "Crewly was updated. Reload this
      page to keep working." with a Reload button. A tab that is not in view
      reloads by itself.
    - Across a plain restart (same build), the new bundle refreshes its
      session on the first `owner_auth_required` and retries once.
- **Phone and portal.** They use the relay credential, so nothing changes for
  them. The phone over the LAN uses the API token from a non-local address,
  so nothing changes there either.
- **Slack.** Button answers arrive in-process (Socket Mode or the Cloud
  relay), or over HTTP signed with Slack's signing secret. Neither path
  depends on the caller being local.
- **CLI.** It sends the owner token to the local backend.

## Residual risks

1. **Same OS user.**
   - The process check raises the bar; it is not a boundary. A process that
     double-forks, calls `setsid` (leaving the agent PTY's terminal) and
     clears its environment looks like any other process of the user.
   - Agents can read `~/.crewly/api-token`, the Cloud token and the owner's
     browser profile. File permissions cannot stop a same-user process.
   - The API token is defused locally by the process-tree check. It still
     works from another machine, so an agent that exfiltrates it can act as
     the owner remotely.
   - With the Cloud token, an agent can post an `api_request` into the relay
     queue as the owner's account. It is then served as `relay-owner`, within
     `MOBILE_API_ALLOWLIST`.
   - An agent able to decrypt the browser's cookie store could replay the
     session cookie. It would also need the CSRF token for writes, but that
     is a derived HMAC it could fetch with the cookie.
   - Fixing these needs OS-level separation: agents running as a different
     user, or in a sandbox.
2. **Browser bridge.** An agent driving the owner's Chrome through the
   extension can run JavaScript in an open dashboard tab, which already holds
   the session. Blocking the dashboard origin in the bridge is a follow-up.
3. **Process lookup fails open only when it cannot run.** If `lsof`/`ss`/`ps`
   are missing or the lookup times out (3 s), a local API-token or page-load
   caller is treated as not an agent, with a once-per-10-minutes warning.
   This keeps the owner's dashboard working on unusual hosts; on macOS and
   normal Linux the tools are present. A lookup that ran and found no client
   process fails closed (§4).
4. **Backend memory.** On Linux with `ptrace` allowed, a same-user process can
   read another process's memory, which is where the session and badge
   secrets live.
5. **Legacy header window.** Until the window closes, an agent can still claim
   *another agent's* session with a bare `X-Agent-Session`. It can no longer
   claim to be the owner. Read-only routes that showed the owner's view to
   header-less callers still do.
6. **Settings reads.** `GET /api/settings` returns configured provider API
   keys to any local caller. Agents get those keys in their environment
   anyway. Not changed here.

## Out of scope — found during #999 (separate issue)

- **`POST /api/sessions` is an arbitrary terminal.** Any local caller can
  spawn a PTY with any command, working directory and environment.
  - The route also has an operator-precedence bug:
    `command || win32 ? 'powershell.exe' : '/bin/bash'` turns any explicit
    `command` into `powershell.exe`.
- **`PUT /api/settings` echoes unmasked keys.** The response returns the
  saved settings with provider API keys in full.
- **chat-v2 posts without the agent header become owner `user` rows.** These
  rows are then trusted as the owner's own words by:
  - the WhatsApp draft gate (`getRecentOwnerMessageContents`, 「发 Wn」);
  - the approval / owner-login evidence guard.

  An agent can therefore manufacture an "owner" confirmation through
  chat-v2. The fix belongs in chat-v2's sender attribution, which should use
  the caller-identity classifier.

## Tests

- `owner-auth.service.test.ts`: badge, session and CSRF mint and verify,
  tampering, expiry, and internal credentials.
- `peer-process.service.test.ts`:
  - parsing `lsof`/`ss` output;
  - the ancestry walk (self, child, grandchild, unrelated) and the terminal
    signal;
  - the per-socket cache and failing open;
  - a real run: a child `curl` of the test process is classified as an
    agent by ancestry, and the process itself as `self`.
- `caller-identity.middleware.test.ts`:
  - classification precedence;
  - CSRF on writes, and the cookie-only API token on writes;
  - legacy warnings;
  - the process-tree override;
  - header normalisation;
  - `rejectNonOwner` and `requireOwner`.
- `owner-session.controller.test.ts`: issuing on page load and on
  `GET /api/auth/session`, refusing agents and agent descendants, and the
  cookie flags.
- `owner-routes.integration.test.ts`: one real app with the real middleware
  stack. For a route from every class above, it checks that:
  - the owner session is allowed;
  - the agent badge is refused (403);
  - the legacy header is refused (403);
  - anonymous is refused (401);
  - the relay credential is allowed where the relay reaches the route.
- Skill end-to-end: `lib.sh` `api_call` against a stub server records
  `X-Agent-Badge`, and a real backend accepts an injected badge as that agent.
- Frontend: `owner-session.service.test.ts` checks the CSRF header on writes,
  no header on reads, bootstrap ordering, refresh and retry on
  `owner_auth_required`, and no header to other origins.
- Dev-server check, with no writes to the live backend on :8787. A second
  backend on its own port and `CREWLY_HOME` serves the built dashboard. The
  dashboard flows are exercised through a browser and the API:
  - decision cards;
  - tickets;
  - usage caps;
  - settings.

## Verified live (2026-10-03)

The checks ran against a dev backend on :8799 with its own `HOME` and `CREWLY_HOME`. Nothing was written to the live backend on :8787.

- **Owner credentials:**
  - The page load set `crewly_owner_8799` (HttpOnly, SameSite=Strict).
  - Cookie + CSRF: 200.
  - Cookie without CSRF, no credential, or the dashboard marker: 401.
  - Legacy agent header: 403.
  - API token from the owner's shell: 200.
- **A backend PTY:**
  - `curl` with the API token read from the file: 403 (ancestry).
  - The same `curl` double-forked into an orphan: 403 (terminal signal).
  - `GET /api/auth/session`: 403.
- **A real agent started through the members API.** Its PTY had `CREWLY_AGENT_BADGE` and no `CREWLY_API_TOKEN`.
  - The `heartbeat` and `ask-owner` skills worked; `ask-owner` was attributed to the agent.
  - `api_call` to an owner-only route: 403, with or without `CREWLY_SESSION_NAME`.
  - No legacy warnings were logged.
- **The built dashboard in headless Chromium.** These passed, and every write carried `X-Crewly-CSRF`:
  - answering a decision card;
  - Usage → Save caps;
  - Settings → People → add a person;
  - a ticket write past the gate;
  - a write after the cookies were cleared: the session was refreshed and the write retried.
