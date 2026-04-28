# Cloud Event Fan-out Contract — `'event'` MessageType

**Status:** Frozen v1 contract — autonomy_v1.f1.
**Audience:** web/ (cloud relay) implementers.
**OSS-side reference:** `backend/src/services/cloud/cloud-event-bridge.service.ts` + `cloud-event-forwarder.service.ts`.
**Origin design:** `.crewly/tasks/autonomy_v1/follow-up/cross-machine-event-triggers-decomp.md` § (c) *(repo-local, gitignored)*.
**Arch verdict:** `.crewly/tmp/arch-verdict-cross-machine-event-triggers-2026-04-28.md` (PASS-WITH-REQUIRED-CHANGES, all conditions adopted) *(repo-local, gitignored)*.

This document is the **single narrow artifact** that the OSS event runtime
and the web/ Cloud Relay share. Per the compose-at-boundary discipline
demonstrated by **PR #347** (`BrandOnboarding ⊥ OnboardingService`) and
**PR #348** (`StatusBadge ⊥ RequestStatusPill`), the two sides keep their
internal state independent and meet only at this contract. OSS-side may
ship before / after / independent of web/ — until web/ honours this
contract, the OSS forwarder/inbound-bridge are no-ops; once web/ ships,
the loop closes without further OSS changes.

## Goal

Route AgentEvents emitted on device A to triggers on paired devices [B, C, …]
within ≤ 5 s of remote emission, with at-least-once delivery semantics
that the OSS-side idempotency stack tolerates.

## Wire format — outbound (origin → cloud)

Origin device calls the existing `/api/cloud/send` endpoint with:

```http
POST /api/cloud/send
Authorization: Bearer <device-jwt>
Content-Type: application/json

{
  "type": "event",                           // NEW MessageType (v1.f1)
  "targetMachine": "*broadcast",             // see Routing
  "payload": {
    "event": {
      "id": "<uuid>",                        // origin-assigned, stable across fan-out
      "type": "xhs:scrape:done",             // canonical event type (string — see § Unknown types)
      "sessionName": "iriss-air-marketing",
      "timestamp": "2026-04-28T01:44:12.345Z",
      "...": "<other AgentEvent fields the publisher set: workItemId, missionId, requestId, etc.>"
    },
    "originDeviceId": "<deviceId>",          // origin echoes its own id
    "originDeviceName": "iriss-air"          // optional human-readable
  }
}
```

**Important:** `event.source` and `event.originDeviceId` are NOT shipped on
the wire. The receiving CloudEventInboundBridge stamps `source = 'remote'` +
`originDeviceId` from the message envelope so the contract is symmetric:
both sides compute the origin tag from the message, never from the
event payload. This prevents the wire from mutating those fields
mid-flight.

### Routing semantics

| `targetMachine` value | Meaning |
|---|---|
| `"*broadcast"` | Fan out to every paired device in the same tenant. **OSS v1 always uses this.** |
| `"<deviceId>"` | Direct fan-out to one device (point-to-point). Reserved for v2 — OSS v1 will not use. |

Cloud determines tenant membership and per-device queue routing.

### MessageType parallelism (Arch M1)

| Type | Purpose | Wire shape |
|---|---|---|
| `'cross-machine'` | Free-text orchestrator messages, slack-style. | `CommandPayload` / `AgentMessagePayload`. |
| **`'event'`** *(NEW)* | Typed AgentEvent objects, schema-stable. | `EventMessagePayload` (this doc). |

Two types kept parallel because they have **different consumers** (the
cross-machine message router vs. the event-bus inbound bridge), **different
validation paths**, and **different downstream sinks**. The OSS forwarder
emits `'event'`; the inbound bridge filters on `type === 'event'`.

## Wire format — inbound (cloud → device, polled)

The receiving device polls `/api/cloud/messages/poll` (existing endpoint —
no new endpoint needed). Cloud returns:

```json
{
  "id": "<cloud-message-uuid>",          // cloud-assigned; UNIQUE per fan-out delivery
  "fromDeviceId": "<origin-deviceId>",
  "createdAt": "<iso>",
  "payload": "{\"type\":\"event\",\"data\":{ <same payload as outbound> },\"encrypted\":false,\"fromDeviceName\":\"iriss-air\"}"
}
```

This matches the existing `IncomingMessage` envelope wrapping
(`{type, data, encrypted, fromDeviceName}` JSON-encoded as a string in the
`payload` field). **No new envelope shape, no new endpoint** — only the
new `type === 'event'` discriminator.

The OSS-side `CloudSyncService.processedMessageIds` LRU dedupes the
cloud-assigned `id` upstream of the inbound bridge so duplicate cloud
deliveries (e.g. retry after ack-loss) don't reach the bridge twice.

## TTL + replay (cloud-side responsibility)

| Constraint | Owner | Notes |
|---|---|---|
| Per-event retention in subscriber queues | **Cloud (web/)** | **24 h.** Event older than 24 h on a queue MUST be GC'd to bound storage. |
| Replay on reconnect after offline | **Cloud (web/)** | When a device reconnects and polls `/messages/poll`, return all unacked events (subject to the 24 h TTL). No new replay endpoint needed — the existing poll IS the replay. |
| Per-device cursor / offset tracking | **Cloud (web/)** | Cloud tracks each device's last-acked queue position so a reconnecting device receives only what it missed. |
| Local LRU for at-least-once dedup | OSS-side | `processedMessageIds` Set bounded at `MAX_DEDUP_IDS` — already in place. |

Devices offline > 24 h SHOULD see no replayed events for the missed window
(the event has expired). OSS-side handles "missing event" naturally: a
trigger that never fires on a missed event will not double-fire later.

## OSS-side idempotency stack (active when this contract is honoured)

| Layer | Key shape | Source |
|---|---|---|
| 1. CloudSync delivery | `cloud-message-id` | `cloud-sync.service.ts` `processedMessageIds` Set. |
| 2. EventBus recent-publish | `${type}:${sessionName}:${event.id}` | `event-bus.service.ts:224` (post-Slice-1 M2 fix). |
| 3. **TriggerEngine dedup** *(new)* | `${triggerId}:${event.id}` | `trigger-engine.service.ts` `firedDedup` Set, capacity 2000. |
| 4. BRIDGE-1 per-handler | `workItemId` / `missionId` / `verifyId` / `retryId` / `escalationId` | `event-to-workitem-bridge.service.ts`. |

Each layer's key is **disjoint** from every other layer's. Cloud's
at-least-once delivery feeds layer 1 → layer 2 → layer 3, where any
duplicate is suppressed before it reaches downstream effects. See decomp
memo § (d) for the full proof.

## Errors

| HTTP | Meaning | OSS handling |
|---|---|---|
| 401 / 403 | Auth expired | Existing `handleAuthError()` token-refresh path triggers. |
| 413 | Event payload too large | Forwarder logs + drops. **Does NOT retry** — payload bloat would compound. |
| 429 | Cloud rate-limited the origin | Existing CloudSync exponential backoff. |
| 5xx | Cloud transient | Existing CloudSync retry-with-backoff. |

## Unknown event types from peers (Arch Q4)

The OSS-side `EVENT_TYPES` enum (`backend/src/types/event-bus.types.ts`)
is closed. Paired devices may roll out new event types one at a time
WITHOUT requiring fleet-wide deployment ordering — the inbound bridge
accepts any string at the wire boundary via the runtime-only
`RemoteEventType = string` alias and casts to `EventType` at the local
re-publish boundary. Unrecognised types are logged at debug level so
ops can audit drift.

This means: **cloud SHOULD NOT validate `event.type` against any
allow-list of known types**. Pass through whatever the origin device
emitted.

## Forwarder allow-list (origin-side, OSS responsibility)

Each origin device opt-in lists which event types may leave the device,
read from `<projectPath>/crewly.json` `crossMachineEvents` array. Default:
empty (no events forwarded). The cloud relay does NOT mirror this list;
it accepts whatever the origin sends.

This boundary is intentional:
- **Privacy**: avoids leaking internal events to peers by default.
- **DoS containment**: a flapping agent on one device cannot saturate
  peer queues unless the operator explicitly listed the event type.
- **Payload bloat**: bounded subset of event types over the wire.

## Loop prevention (origin-side, OSS responsibility)

The `CloudEventForwarder` short-circuits on `event.source === 'remote'`
so the inbound bridge ↔ forwarder pair cannot form a ping-pong loop.
**Cloud does not need to do anything for loop prevention** — the fence
is at the origin device.

## Versioning

- v1 / autonomy_v1.f1: this document.
- v2 (deferred): per-event subscription routing (origin device names
  subscriber set), encrypted-event option, replay endpoint with cursor.

Future revisions MUST preserve the v1 message wire shape for backward
compatibility — paired devices on v1 must continue to receive v2-emitted
events that fit the v1 shape.

## Acceptance for the web/ ticket

- [ ] `/api/cloud/send` accepts `type === 'event'` and per-tenant
      broadcasts the payload to all paired devices in the same tenant.
- [ ] Each subscriber queue retains the event for 24 h with per-device
      cursor / ack tracking.
- [ ] `/api/cloud/messages/poll` returns retained events on reconnect
      (existing endpoint; no new shape).
- [ ] Cloud does NOT validate `event.type` against any allow-list.
- [ ] Cloud does NOT mutate `event.source` or `event.originDeviceId`
      (these are absent on the outbound wire).
- [ ] At-least-once delivery semantics — duplicates with the same
      cloud-message-id are caught by the OSS-side `processedMessageIds`
      LRU; cloud is not required to deduplicate.

## OSS-side hand-off summary

| Concern | OSS-side | Web-side |
|---|---|---|
| Forwarder allow-list | ✅ ships in Slice 5 | n/a |
| Loop-prevention fence | ✅ ships in Slice 5 | n/a |
| Inbound translation to AgentEvent | ✅ ships in Slice 2 | n/a |
| 4-layer idempotency stack | ✅ ships in Slices 1-3 | n/a (cloud at-least-once OK) |
| `'event'` MessageType vocabulary | ✅ ships in Slice 1 | accept |
| Per-tenant broadcast fan-out | n/a | **REQUIRED** |
| 24 h event TTL + cursor | n/a | **REQUIRED** |
| Existing `/messages/poll` extends to events | n/a | **REQUIRED** (no shape change) |

## Pattern lineage

This contract is the deliverable form of the *narrow-shared-artifact*
discipline first cited in PR #347 / PR #348 review, then promoted by
Arch as the structuring principle for autonomy_v1.f1's OSS ⊥ web/ split
(verdict 2026-04-28). Future cross-process collaborations should treat
this doc as a worked example of the pattern.
