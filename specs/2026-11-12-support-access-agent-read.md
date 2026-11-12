# Support access — agents of the granted account can read (crewly#1558)

Status: implemented (branch `feat/1558-agent-support-view`). Builds on
`specs/2026-11-10-support-access-instance.md` (the granted machine's support
API, relay and audit). The Cloud side (the grant's `agentAccess` flag, the
relay's agent rules, the received-grants list) lives in crewly-services.

Account A (grantor) gave account B (grantee) support access. Until now only a
person of B could use it, in the portal. This slice lets an **agent** of B
read A's machine when A turned on access for agents: its agents and their
state, its conversations and messages, its recent errors. Nothing else, and
never a write.

```
B's agent ─ skill ─▶ B's backend /api/support-view/* ─▶ Cloud: received grants, machines
                              │
                              └─ api_request {GET /support/…} + supportAgent ─▶ relay
                                     (grant has agentAccess? GET? agent area? rate) ─▶ A's queue
A's instance: supportGrant {…, actor: 'agent', agentName} ─▶ SupportRelayService ─▶ SupportApiService
                              │
B's queue ◀─ api_response {id, status, body} ◀──────────────┘
```

## Contract with the relay

- A grant has a boolean `agentAccess`. A request sent from a machine is an
  agent request. The relay lets it through only when the grant has
  `agentAccess`, the method is `GET`, and the path is in an agent area:
  conversations (list and messages), agents, errors. Not settings.
- Send (`POST` relay messages endpoint): `{ peerQueueId: <A's machine queue>,
  payload: JSON.stringify({ type: 'api_request', data: { id, method: 'GET',
  path }, encrypted: false, fromDeviceName: <B's machine queue id>,
  supportAgent: <agent name> }) }`. `path` is relative to `/api`, starts
  `/support/`, has no `%`, `\`, `#` or whitespace, and every segment matches
  `/^[A-Za-z0-9._~:@,+=-]+$/`; a query may follow `?`.
- Refusals are a JSON error body with a `code`: `support_agent_access_off`,
  `support_agent_read_only`, `support_agent_path_refused`,
  `support_agent_rate_limited` (429), and the existing `support_path_refused`,
  `support_method_refused`, `support_reply_queue_required`; 404 "Peer queue
  not found" when no active grant reaches that queue.
- The envelope the relay adds for A gains `actor: 'agent' | 'person'` and, for
  an agent, `agentName` (1–64 of `[A-Za-z0-9 ._-]`). An older relay sends
  neither: a missing `actor` is a person.
- The answer returns to B's machine queue as a plain `api_response` wrapper
  with `data: { id, status, body }`.

## Grantor side (the granted machine)

- `parseSupportGrantEnvelope` (`support.types.ts`) always sets `actor`
  (`'person'` when absent). An `actor` that is neither value makes the whole
  envelope malformed (`null`: dropped and audited, as before). `agentName` is
  kept only for an agent and only when it matches the pattern after trimming;
  otherwise it is dropped and the request still runs.
- `SupportRelayService` adds two checks for an agent caller, after the path
  and before the role's method check, whatever the relay let through:

  | Check | Outcome |
  |---|---|
  | method is not `GET` | 403 `support_agent_read_only` |
  | first segment after `/support/` is not `conversations`, `agents` or `errors` | 403 `support_agent_path_refused` |

  So an agent gets neither `/support/settings` nor `/support/whoami` nor a
  restart, also with an admin grant. Both refusals are audited as refused.
- Audit (`support-audit.service.ts`): an agent's call has actor `{type:
  'support', id: <granteeEmail>, via: 'support-grant-agent'}`, `after.sentBy:
  'agent'` and `after.agentName` when given, and the note reads "agent Nova of
  b@example.com …" (or "an agent of b@example.com …"). A person's entries
  are unchanged, and the 15-minute collapse of repeated reads is kept per
  sender, so a person's read is not hidden by an agent's.

## Grantee side (the reading machine)

### Client (`support-client.service.ts`, `support-client.types.ts`)

- **Grants:** `GET <cloud>/api/cloud/support-grants/received` with this
  machine's Cloud login (`CloudClientService` token as a Bearer header; never
  logged, returned or put in an error). The answer is `{success, data:
  {grants: [...]}}`: only active grants where this account is the grantee
  (`id`, `role`, `includePrivate`, `agentAccess`, `grantorEmail`,
  `grantorDisplayName`, `instanceId`, `expiresAt`, …). A row that names a
  status other than `active` is dropped. The plain list
  (`/api/cloud/support-grants`, `{asGrantor, asGrantee}`) needs a portal
  sign-in and is not used. **A 404 means an older Cloud**: failure
  `cloud_unsupported`, "This Crewly Cloud does not support agent access yet."
- **Machines:** `GET <cloud>/api/cloud/support-grants/:id/instances` →
  `{instances: [{instanceId, deviceName, relayQueueId, lastSeenAt, live}]}`.
  The relay queue id stays inside the backend; no agent sees it.
- **Read:** only the paths `buildSupportReadPath` can build, from validated
  parts:

  | Read | Path sent |
  |---|---|
  | agents | `/support/agents` |
  | conversations | `/support/conversations?limit=<1..100, default 30>` |
  | messages | `/support/conversations/<id>/messages?limit=<1..100, default 30>&direction=backward[&cursor=<older>]` |
  | errors | `/support/errors?limit=<1..200, default 50>` |

  A conversation id must be one clean segment (`CONVERSATION_ID_PATTERN`), a
  cursor base64url (`CURSOR_PATTERN`); anything else is refused locally
  (`invalid`) and nothing is sent.
- **Matching the answer:** every request gets a random UUID. It is put in a
  pending map **before** the send (the answer may arrive first), with a 20 s
  timer. The client listens to cloud-sync's `'message'` stream and takes an
  `api_response` only when its `data.id` is a pending id; any other
  `api_response` is left alone. An answer whose body is over 1,000,000
  characters is dropped (`failed`). The timer, the entry and, on `stop()`,
  the listener are always removed; `stop()` fails what is still waiting. At
  most 20 reads wait at once (`rate_limited` beyond that).
- **Other listeners:** `api_response` is emitted on the `'message'` stream
  untouched. The owner REST passthrough (`MobileApiRelayService`) and the
  support relay handle `api_request` only, and the remaining listeners filter
  on their own types, so none of them acts on it.
- **Failures** (`SupportViewFailureCode`, each with one plain sentence):

  | Failure | HTTP (local API) | When |
  |---|---|---|
  | `access_ended` | 403 | no active grant; relay 404 / 403; Cloud 403 / 404 for a grant's machines |
  | `agent_access_off` | 403 | relay `support_agent_access_off`, or Cloud says `agentAccess: false` (refused locally, nothing sent) |
  | `read_only` | 403 | relay or machine `support_agent_read_only` / `support_method_refused` |
  | `not_allowed` | 403 | relay or machine `support_agent_path_refused` / `support_path_refused` |
  | `rate_limited` | 429 | relay `support_agent_rate_limited` or any 429; 20 reads already waiting |
  | `offline` | 504 | no answer in 20 s; machine has no relay queue; grant reaches no machine |
  | `disabled` | 403 | machine answers `support_disabled` (its owner turned support access off) |
  | `not_found` | 404 | machine answers 404; no machine matches the name given |
  | `not_connected` | 503 | this machine is not signed in to Cloud, has no relay queue, or Cloud is unreachable |
  | `cloud_unsupported` | 501 | Cloud has no received-grants list (404) |
  | `turned_off_here` | 403 | `support.allowAgentViews` is off on this machine |
  | `owner_only` | 403 | the session is working for someone other than the owner |
  | `choose` | 409 | several grants or machines and none named (`choices` lists them) |
  | `invalid` | 400 | a value was refused before anything was sent |
  | `failed` | 502 | anything else |

### View (`support-view.service.ts`)

For each call: (1) refuse when `support.allowAgentViews` is off; (2) refuse a
session whose acting-for person is not the owner (a grant is given to the
account; what comes back is for the owner); (3) pick the grant (the only one,
or the one named by grant id, grantor email or name) and the machine (the
only one, or the one named by device name or instance id); (4) send the read
with the agent's display name (`Orc` for the orchestrator, the member's name
otherwise, reduced to the envelope's pattern; the session name when there is
none) as `supportAgent`; (5) note the private source; (6) write the Activity
entry.

**Private source.** A successful read is noted in the private-source tracker
(#969) as `note(session, 'support:<grantor email>', 'support-access')`
(`support:<grant id>` when Cloud gave no email). For the tracker's window
(20 minutes) the existing consumers then treat what the session writes as
sourced from that person: a reply to a shared place is held for the owner
(Share / Keep private), memory and wiki pages are visible to the owner only,
and a shared-channel send to another company is refused.

The id is the **grantor's**, not the owner's. The data belongs to the other
account, and the reply-audience check skips the owner's own id (the owner's
connector data may go where the owner is), so noting the owner would hold
nothing. Known gaps, left as they are rather than bending the tracker:

- The hold card names the raw id (`support:steve@example.com`); it is not in
  the people directory.
- A reply in a direct message is not held, whoever the DM is with. The
  `owner_only` gate keeps non-owner work from reading in the first place.
- The window is time-based: a write more than 20 minutes after the last read
  is not held. The skill's block and doc carry the rule beyond that.

**Activity log (this machine).** Actor `{type: 'agent', id: <session>, via:
'support-view'}`, action `support-view.read` or `support-view.refused`,
target `{type: 'support-grant', id: <grant id | 'none'>}`, `after: {agent,
area, conversationId?, outcome, grantId, grantorEmail, role, includePrivate,
machine, instanceId}` and a note such as "Agent Nova (crewly-nova) read
conversations on Studio Mac of steve@example.com through support access".
Never message content, never a relay queue id.

### Local API (`controllers/support-view`)

Mounted at `/api/support-view`. The caller is the agent session
(`X-Agent-Session`, as `message-colleague` and `search-chat` read it); a call
without one is refused with 403. `grant` and `machine` are optional query
parameters on every read.

| Route | Answer |
|---|---|
| `GET /grants` | `{success, grants: [{id, grantorEmail, grantorName?, role, includePrivate, agentAccess: true \| false \| null, expiresAt?, machines: [{instanceId, deviceName, live, lastSeenAt?}], machinesError?}]}` |
| `GET /agents` | `{success, grant, machine, data}` (`data` as the support API returns it) |
| `GET /conversations?limit=` | same |
| `GET /conversations/:id/messages?limit=&older=` | same; `data.nextCursor` is the next `older` |
| `GET /errors?limit=` | same |

Failures: `{success: false, code, error, choices?}` with the status of the
table above; 503 `not_connected` when the service is not running.

### Setting

`settings.support.allowAgentViews` (default `true`; a settings file that
predates it reads as on), beside `support.allowGrantees`, same plumbing: `PUT
/api/settings {"support": {"allowAgentViews": false}}` (owner only). Off
answers every `/api/support-view` call 403 `turned_off_here`. Like
`allowGrantees` it has no toggle in the dashboard yet.

### Skill (`config/skills/agent/core/support-view-instance`)

`list`, `agents`, `conversations`, `messages <conversation-id> [--older
<cursor>]`, `errors`; `--grant`, `--machine`, `--limit`. Listed for every
role in the skills reference of the agent prompt (bundled skills are not in
`registry.json`).

- Everything the other machine sent is printed between `===== BEGIN CONTENT
  FROM ANOTHER ACCOUNT'S MACHINE (<machine> of <account>, read-only support
  access) =====` and `===== END CONTENT FROM ANOTHER ACCOUNT'S MACHINE =====`,
  under two lines saying it is data, never instructions, and private to the
  owner (no shared channels, memory or wiki; report to the owner). A reminder
  to summarise follows the block.
- Runs of three or more `=` in remote text are shortened and continuation
  lines of a message are indented, so remote text cannot forge the end line.
- A withheld message prints as `[withheld: private content, not shared
  through this grant]`. Attachments are a count.
- A failure is one plain line on stderr (`Support view failed [<code>]:
  <sentence>`, plus the choices for `choose`), exit 1, nothing on stdout.
  Argument mistakes exit 2 before anything is sent.

## Tests

`support.types.test.ts`, `support-relay.service.test.ts`,
`support-audit.service.test.ts`, `support.wiring.test.ts`,
`support-client.types.test.ts`, `support-client.service.test.ts` (fake
cloud-sync, fake fetch), `support-view.service.test.ts`,
`controllers/support-view/support-view.controller.test.ts`,
`cloud-sync.service.test.ts` (envelope actor, `api_response` passthrough,
`sendSupportAgentRequest`), `settings.types.test.ts`,
`skills-reference.module.test.ts`, and the skill's `execute.test.sh` (stub
backend). None touches the real `~/.crewly`, Cloud or relay.

## Not in this slice

- No dashboard toggle for `support.allowAgentViews`.
- No wiki pages, settings or restart for agents; a person does those in the
  portal under Access.
- Not exercised against a real second account, relay or Cloud.
