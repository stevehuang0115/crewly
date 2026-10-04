# Security follow-ups to #1023 (#1024)

Builds on `specs/2026-10-03-owner-auth.md` and
`specs/2026-10-03-security-followups-1012.md`. It uses the same
caller-identity classifier:
- `owner`;
- `relay-owner`;
- `cloud`;
- `agent:<session>`, identified by one of:
  - `agent-badge`;
  - `process-tree`;
  - `legacy-header`;
- `anonymous`.

**No new environment variables and no new credentials.** Agents already get
`CREWLY_AGENT_BADGE` at launch, on steamfun-ops too, so the systemd drop-in
does not change.

## Definitions

A **verified agent** is a caller classified as an agent whose identity is
proven:
- by a valid badge (`via: agent-badge`); or
- by the process tree (`via: process-tree`): an agent PTY's process
  presented the owner token.

In both cases the session must also be known.

The legacy `X-Agent-Session` header alone is **not** proof, because any
local process can set it.

**A session header without a valid badge** comes from two kinds of shell:
- one that never got a badge, such as an old npm `crewly-agent`;
- one holding a badge minted by an earlier backend process. The badge secret
  is per-process `randomBytes`.

Such a call is verified when the process tree confirms it (#1024 review).
`classifyCaller` runs the same peer check it uses for the owner token:
1. it finds the client process on the other end of this connection, with
   `lsof` or `ss`;
2. it walks that process's ancestry;
3. it maps the result to a session through `liveSessionPids`, which now also
   includes each Crewly Agent child process.

When that session is the claimed one, the identity becomes
`via: process-tree`, noted as `session header confirmed by the process tree`.
Otherwise it stays `legacy-header`, unverified.

It deliberately does not trust `X-Agent-Pid`. That header is self-reported:
a local process can send a real agent shell's pid alongside a forged session
header. The agent-origin middleware still uses `X-Agent-Pid` to correct a
leaked session name, and the corrected session is what the socket check then
confirms. A lookup that cannot run (`unknown`) leaves the call unverified.
That fails closed for the gated routes and changes nothing elsewhere.

New helpers in `caller-identity.middleware.ts`:
- `isVerifiedAgent`;
- `rejectUnverifiedCaller` and its middleware form `ownerOrVerifiedAgent`.

These helpers allow the owner and the relay owner. They refuse:
- a legacy-header agent: 403 `agent_badge_required`;
- every other caller: 401 `owner_auth_required`.

| # | Item | Status |
|---|---|---|
| 1 | Anonymous callers can type into any agent through `/api/terminal/*` | Closed |
| 2 | Role writes are open | Closed |
| 3 | The key route gives any badge-holding agent any key, unlogged | Closed |
| 4 | Typing after a masked key's bullets is silently discarded | Closed (dashboard hint) |
| 5 | Skills run through `/api/skills/:id/execute` carry no badge | Closed |

## 1. `/api/terminal/:s` writes

### Problem

```
curl -X POST localhost:8787/api/terminal/crewly-orc/input -d '{"input":"…"}'
```

This types into the orchestrator's Claude Code, which runs with
skip-permissions. It is the same arbitrary execution that `POST /api/sessions`
gave before #1023.

### Fix

`terminal.routes.ts` puts `ownerOrVerifiedAgent` in front of these routes:
- `POST /terminal/:s/write`
- `POST /terminal/:s/deliver`
- `POST /terminal/:s/input`
- `POST /terminal/:s/key`
- `DELETE /terminal/:s`

| Caller | Result |
|---|---|
| Owner session (+ CSRF), owner API token from a non-agent process or a remote address, relay | Allowed |
| Agent with its badge (skills, `internalAgentHeaders`, the crewly-agent client) | Allowed |
| The owner token from an agent PTY's process with a known session | Allowed, as that agent |
| The owner token from an agent's process with an unknown session | 403 |
| `X-Agent-Session` with no badge, or a badge from an earlier backend, from a process the process tree places under that session's PTY or Crewly Agent child | Allowed, as that agent |
| Only `X-Agent-Session`, from any other process (forged) | 403 `agent_badge_required` |
| No credential, an invalid badge, `X-Crewly-Caller: dashboard`, the cloud credential | 401 |

These reads stay open:
- `GET /terminal/sessions`
- `GET /terminal/:s/exists`
- `GET /terminal/:s/output`
- `GET /terminal/:s/capture`

### Callers checked

**Backend services, in process.** These used HTTP with no credential. They
now call `deliverForcedMessage` (`services/messaging/forced-delivery.ts`),
which runs the route's forced path without the HTTP hop. The steps are:
0. **The session must exist locally.** That means a ready in-process runtime
   or a PTY; otherwise the answer is `not-found`, never `queued`.
   Unlike the HTTP route, there is intentionally no remote routing and no
   offline-member start, because both callers send local system notices;
1. restart-drain queue;
2. daily-token-cap queue;
3. in-process Crewly Agent `handleMessage`;
4. otherwise the guarded two-step PTY write.

Two services moved:
- **`runtime-exit-monitor.service.ts`**: the orchestrator failure notice.
- **`slack-orchestrator-bridge.ts`**: the direct-delivery fallback, used
  when no message queue is wired. Like the queue path, it records the
  inbound message in chat-v2 and calls `watchOwnerMessage` before
  delivering, so the unanswered-owner watchdog still covers it. A delivery
  that does not land is now reported ("Failed to reach agent") instead of
  being claimed as delivered.

Why in process rather than a pseudo-agent badge: a request that carries an
agent session makes the target "act for" the sender's person (#968,
`noteAgentToAgent`). A system notice, or a Slack message from someone else,
must not reset that to the owner.

**Backend services that already sent credentials.** No change:
- **`runtime-smoke-test.service.ts` (`LocalSmokeApi`)**: already sends the
  owner API token. The backend is calling itself, so the process check
  answers `self` and the caller is the owner. A test pins the header.
- **`internalAgentHeaders(SERVICE_NAME)`**, a badge:
  - `workitem-dispatch.subscriber.ts`, both `/write` calls;
  - `tl-auto-verify.service.ts`;
  - `workitem-worktree.subscriber.ts`.

**Skills.** All of these go through `api_call`
(`config/skills/_common/lib.sh`), which sends `X-Agent-Badge` from
`CREWLY_AGENT_BADGE` and `X-Agent-Session`:
- agent `send-message` (`/write`);
- `handoff-task` (`/write`, `/deliver`);
- team-leader `delegate-task` (`/deliver`);
- orchestrator `send-message`, `broadcast`, `broadcast-to-org` and
  `resume-session` (`/deliver`);
- `send-key` and `resume-session` (`/key`);
- `terminate-agent` (`DELETE`).

No skill calls these routes with a bare `curl`.

**Other callers:**
- **crewly-agent** (`packages/crewly-agent/src/runtime/api-client.ts`):
  sends `X-Agent-Badge` from `CREWLY_AGENT_BADGE`. The backend sets that
  variable in the child's environment (`buildChildEnv`).
- **Frontend:** only reads `GET /api/terminal/sessions`. Typing in the
  dashboard terminal goes over the WebSocket gateway.
- **CLI:** only reads `GET /api/terminal/sessions` (`crewly status`).
- **Phone and portal relay:** `MOBILE_API_ALLOWLIST` has no `/terminal`
  entry.
- **Slack, Telegram, WhatsApp, Google Chat and Cloud Talk bridges, and the
  cron scheduler:** in process; none calls these routes over HTTP.
- **MCP server:** removed in an earlier release.
- **Outside this repo:**
  - `desktop/packages/pro-backend` imports a crewly path that no longer
    exists, so it is dead code;
  - the standalone `crewly-agent` repo, published on npm as
    `crewly-agent@0.1.1`, sends only the legacy header. The backend does not
    spawn it: `resolveManagedBinary` runs the vendored
    `packages/crewly-agent`, which ships in the crewly tarball and sends the
    badge. Only an owner who set `runtimeCommands['crewly-agent']` to that
    old npm binary would see its terminal writes refused with 403
    `agent_badge_required`. The fix is to clear the override.
- **steamfun-ops:**
  - agents get badges at launch;
  - remote owner calls with the API token still count as the owner;
  - no environment variable changes.

## 2. Role writes

`role.controller.ts`: these routes become owner-only (`ownerOnly`), the same
way as the other settings writes:
- `POST /`
- `PUT /:id`
- `DELETE /:id`
- `POST /:id/skills`
- `DELETE /:id/skills`
- `POST /:id/set-default`
- `POST /:id/reset`

Agents get 403 `owner_only`; no credential gets 401.

These stay open:
- the reads;
- `POST /refresh`, which reloads from disk and changes nothing.

The only caller is the dashboard Roles page, through `axios` with the
owner-session interceptor. No skill, CLI, relay entry or crewly-agent tool
writes roles.

## 3. Key route scoping and logging

`GET /api/settings/api-key/:provider?skill=&runtime=`

**Owner.** Any provider. `?runtime=` and `?skill=` are honoured as given.

**Verified agent.** `decideAgentApiKeyAccess` in
`services/settings/api-key-access.service.ts` decides:

1. **The runtime is the agent's own.** It is looked up from the session, not
   from the query:
   - for the orchestrator, from `getOrchestratorStatus().runtimeType`;
   - for anyone else, from the team member's `runtimeType`;
   - in both cases after `effectiveRuntimeType`, which applies an active
     runtime fallback.

   A `?runtime=` naming a different runtime gets 403
   `api_key_runtime_mismatch`. The key is then resolved with the agent's
   runtime, so a per-runtime override applies to its own runtime only.
2. **With `?skill=<id>`**, all of these must hold:
   - the skill is installed (`<id>` or `skill-<id>`); otherwise 403
     `api_key_unknown_skill`;
   - its `assignableRoles` is empty or contains `*` or the caller's role;
     otherwise 403 `api_key_skill_not_for_role`;
   - it declares the provider's environment variable (`API_KEY_ENV_VARS`) in
     `requires` or `optionalSecrets`, in `skill.json` or the SKILL.md
     frontmatter; otherwise 403 `api_key_out_of_scope`.

   Examples:
   - `transcribe-audio` declares `OPENAI_API_KEY`, so it can read `openai`;
   - `screenshot-compare` declares `GEMINI_API_KEY`, so it can read
     `gemini`.
3. **Without a skill**, the provider must be one the agent's runtime itself
   consumes (`RUNTIME_KEY_PROVIDERS`). Otherwise the answer is 403
   `api_key_out_of_scope`. A session that is neither a team member nor the
   orchestrator has no runtime, so it can read keys only through a skill.

   | Runtime | Providers |
   |---|---|
   | claude-code | anthropic |
   | gemini-cli | gemini |
   | antigravity-cli | gemini |
   | codex-cli | openai |
   | opencode-cli | any (the model provider is configurable) |
   | crewly-agent | any (the model provider is configurable) |

**Logging.** `logApiKeyRead` logs every read at `info` and every refusal at
`warn`, under the `ApiKeyAccess` component. Each entry records:
- the provider;
- the caller kind and how it was identified (`via`);
- the session;
- the skill and runtime;
- the outcome: `served`, `refused` or `not-configured`;
- the refusal code.

It never logs the key.

Unchanged:

| Caller | Answer |
|---|---|
| Legacy header only | 403 `agent_badge_required` |
| No credential | 401 |
| Unknown provider | 400 |
| Provider with no key | 404 |

## 4. Masked key fields (dashboard)

The server keeps the stored key whenever a value starts with `••••` (#1012),
so typing after the bullets is discarded. When an API Keys field holds a
mask that differs from the one loaded, the tab now shows this under the
field: "This key is saved and hidden, so edits to it are not saved. Clear the
field, then paste the whole new key." It does this for global keys and for
runtime overrides.

## 5. Skills run through `POST /api/skills/:id/execute`

The route now passes `context.caller`, taken from the caller identity and
never from the request body:
- `{ kind: 'agent', session }` for a verified agent;
- `{ kind: 'owner' }` for the owner and the relay.

`SkillExecutorService.buildEnvironmentWithSecrets`:
- always drops any inherited `CREWLY_AGENT_BADGE` and `CREWLY_SESSION_NAME`.
- For an agent caller:
  - sets `CREWLY_SESSION_NAME`, and `CREWLY_AGENT_BADGE` (minted for that
    session). The badge is also a live secret, so it is redacted from the
    output. The script's `api_call` and its key lookup then act as that
    agent, scoped as in §3.
  - removes `CREWLY_API_TOKEN` and the Slack app secrets, as for the agent's
    PTY (`AGENT_ENV_DENYLIST`).
- The owner and unidentified callers get no badge. The owner credential is
  never placed in a child process's environment, so an owner-run skill
  cannot use the key route: it still uses environment keys.

## Tests

- **`owner-routes.integration.test.ts`**, through the real `/api` chain:
  - **Terminal writes:**
    - allowed: the owner, a badge, `internalAgentHeaders`, the owner token
      from `self`, and the owner token from an agent's process with a
      session;
    - 403: the legacy header, and an agent's process with no session;
    - 401: no credential, a forged badge, the dashboard marker and the cloud
      credential;
    - reads stay open.
  - **Role writes:** added to the owner-only matrix; reads stay open.
- **`settings.controller.test.ts`**, key route, real router:
  - runtime scope, skill scope, an undeclared provider, an unknown skill, a
    skill for another role;
  - a runtime mismatch, and the agent's own runtime override;
  - the owner unrestricted; legacy 403, anonymous and forged 401, 404 and
    400.
- **`caller-identity.middleware.test.ts`**, the legacy-header confirmation:
  - a valid ancestry passes;
  - an old or invalid badge with a valid ancestry passes;
  - a forged header from a non-agent process stays unverified, as does one
    from another agent's process, from an unknown session, or from a lookup
    that is `unknown`, `gone` or `remote`;
  - a valid badge triggers no lookup.

  The integration matrix covers the same cases on the terminal routes.
- **`in-process-runtime-registry.test.ts`:** Crewly Agent child pid →
  session.
- **`api-key-access.service.test.ts`:**
  - the decision table;
  - storage and skill-manifest lookups;
  - log entries carry no key.
- **`forced-delivery.test.ts`:**
  - a missing session is `not-found`, before the drain and cap gates;
  - the gate order (drain before the spend cap);
  - in-process and PTY delivery;
  - not-found, input-guard and failure results.
- **`runtime-exit-monitor.service.test.ts`:** the notice goes through
  `deliverForcedMessage` and makes no HTTP request.
- **`slack-orchestrator-bridge.test.ts`:** the fallback:
  - delivers in process with the Slack context header;
  - calls `watchOwnerMessage` before delivering;
  - reports a delivery that did not land.
- **`runtime-smoke-test.service.test.ts`:** `LocalSmokeApi` sends
  `X-Crewly-Token` on deliver, kill and exists.
- **`skill.controller.execute.test.ts`:**
  - an agent badge gives `caller: agent`, and the owner gives
    `caller: owner`;
  - the legacy header, or a body naming an agent, gives no caller.
- **`skill-executor.service.test.ts`:**
  - an agent caller gets its session and a valid badge, and the badge is a
    live secret;
  - its run gets no owner token and no Slack secrets;
  - nothing is inherited.
- **`ApiKeysTab.test.tsx`:**
  - an edited mask shows the hint;
  - an untouched mask and a real key show no hint.
