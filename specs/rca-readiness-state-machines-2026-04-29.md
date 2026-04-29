---
title: RCA — Browser Binding & Terminal Queue Readiness State Machines
date: 2026-04-29
author: Sam (Tech Lead)
trigger: ORC ad-hoc investigation; Steve customer demo (SteamFun) impact
scope: Crewly OSS only (backend/). Cloud relay (api.crewlyai.com) called out as upstream cause but not in scope to fix here.
status: browser symptom RESOLVED in PR #377 (merged 2026-04-29, deploy deferred to next natural OSS restart per ORC); terminal symptom RCA-only — fix design in specs/terminal-queue-eager-monitoring-fix.md (implementation deferred to next sprint per ORC)
---

# RCA — Two Reconnect-Driven Readiness Bugs

## TL;DR

Two seemingly unrelated symptoms — (1) orc terminal messages queuing until the
side panel is opened, (2) `/api/browser/navigate` returning 503 even though the
relay shows two healthy Chrome instances — share a common shape:

> *The backend has live state, but a downstream readiness check fails because
> a state-machine transition is gated on an event that never fires (or fires
> on the wrong identity after a reconnect).*

For the browser path, I have a *root cause* and a *small, low-risk patch*
landed on `fix/proxy-multi-instance-auto-select` (waiting for review). For the
terminal path, the architectural fix touches the WS gateway lifecycle and is
not safe to ship without a proper review round — RCA only.

---

## Symptom 1 — Browser navigate returns 503 with 2 live instances

### Evidence (from Steve / ORC)

- `/api/browser/status` snapshot:
  - `proxy.state: "connected"`, `proxy.available: true`
  - `proxy.instances`: 2 Chrome entries, `lastSeen` ~now
  - Top-level `connected: false`, `relayAvailable: false`, `bindingCount: 0`
- `POST /api/browser/navigate` → `503 NO_BROWSER_CLIENT`
  with body `proxy-relay: No browser instances connected`.
- Cloud Portal also reports 2 Chrome instances "Last seen 1m ago".
- Extension DevTools console shows ~1–2 min reconnect cycles driven by
  `Pong timeout — connection appears dead, forcing reconnect`. Each
  reconnect yields a *new relay sessionId* (`74c53f77…` → `27d49b3b…`).

### Root cause (high confidence)

Two compounding issues, only one of which is OSS:

1. **Upstream (cloud relay / extension)** — extension hits a 15 s pong
   timeout (`PONG_TIMEOUT_MS` in `chrome-extension/src/types.ts:171`),
   tears down its WS, reconnects, and registers again. The relay does not
   prune the prior session promptly, so for a window the relay's view
   contains both the *ghost* (old sessionId) and the *live* (new sessionId)
   entry for the same physical Chrome — *or* there are genuinely two
   Chromes, but both are oscillating the same way. From the OSS proxy's
   perspective the result is the same: `browser_list` arrives with N≥2
   entries.

2. **OSS (this repo) — `BrowserProxyService.resolveInstance` gives up on
   N≥2.** When `sendCommand` is called without an explicit `instance`
   parameter (which is what `/api/browser/navigate` does — see
   `backend/src/controllers/browser/browser.controller.ts:319-321` and the
   `sendToolCommand` body around `:289-298`), the proxy's auto-select
   logic at `backend/src/services/browser/browser-proxy.service.ts:376-389`
   was:

   ```ts
   if (!instance) {
     if (this.instances.size === 1) {
       return this.instances.values().next().value ?? null;
     }
     return null;        // ← bug: also returns null when size > 1
   }
   ```

   So the moment the relay's instance count crosses 1, *every* unscoped
   browser tool call fails with the misleading error
   `No browser instances connected`. This is exactly the error in Steve's
   navigate response.

   Note: `bindingCount: 0` in the status payload is **expected** for
   relay-mode operation — `agentTabBindings` is the *direct-WS* binding
   table maintained by `BrowserBridgeService`, and we never have a
   direct WS in cloud-relay mode. It is a red herring for this symptom.

### Why "Path B works" (the user-clicked menu)

Path B forces an explicit `instance` parameter into the request, which
flips `resolveInstance` onto the search-by-name branch (line 386–390),
which works regardless of how many candidates are present.

### Fix (landed in this branch)

`fix/proxy-multi-instance-auto-select` (≈25 lines + 2 tests):

- Auto-select now returns the **freshest by `lastSeenAt`** when more than
  one instance is known. Tolerates ghost entries from reconnect *and* gives
  the user a sensible default when multiple Chromes are genuinely live.
- The 0-vs-ambiguous error message is split so future symptoms read
  unambiguously (`No browser instances connected` vs.
  `Could not resolve a browser instance from N candidates …`).
- Tests cover (a) ghost-stale + fresh-live → fresh wins, (b) all-bad
  timestamps → ambiguous error rather than the misleading "no instances".

Files:
- `backend/src/services/browser/browser-proxy.service.ts:314-345, 370-414`
- `backend/src/services/browser/browser-proxy.service.test.ts:444-…`

`backend/src/services/browser` test suite: 99 / 99 pass.

### What this fix does NOT cover

- Why the extension hits a 15 s pong timeout every 1–2 minutes. Two
  hypotheses — MV3 service-worker suspension between heartbeat send and
  ack receipt, or the relay occasionally dropping a `heartbeat_ack` under
  load. Both are outside OSS. *Recommendation*: open a follow-up ticket on
  crewly-pro relay reliability + chrome-extension SW keep-alive
  (background.ts:1167-1188 already wires `swKeepAlive`, but if the SW
  *itself* is suspended mid-heartbeat the timer is useless).
- Pruning ghosts on the relay side. The OSS proxy now copes; the relay
  should still drop a session promptly when it closes.

---

## Symptom 2 — Orc terminal messages queue until the side panel is opened

### Evidence (from Steve)

> "I had several messages that were queued but never delivered to orc's
> terminal. As soon as I opened the frontend side terminal panel, all
> queued messages flushed at once. Feels like a focus issue."

### Root cause (medium-high confidence — needs runtime verification)

The orchestrator's PTY is created/owned by the backend. The backend's
**`TerminalGateway` only attaches a PTY `onData` listener when a frontend
WebSocket client subscribes to that session** (`subscribe_to_session` →
`startPtyStreaming` at `backend/src/websocket/terminal.gateway.ts:268-330`).
When all clients disconnect, `stopPtyStreaming`
(`:340-354`, called from `:420-425`) tears the listener down again.

Meanwhile, the agent message-delivery path
(`AgentRegistrationService.sendMessageWithRetry` →
`session.write(...)` at `:3026, :3556`) writes directly into the PTY
*regardless* of whether anyone is listening. The dispatcher
(`QueueProcessorService.processNext`) does the same — fire and forget.

So if the user (or another orchestrator) sends a message to `crewly-orc`
*while no frontend tab is subscribed to its terminal*:

- Bytes arrive at the PTY successfully.
- Claude (the orc) reads from its stdin and processes them — the agent
  itself probably *is* responding internally; it just has no listener
  upstream to broadcast its output.
- The PTY's stdout still has buffered output, but nothing is forwarded
  to the frontend until a subscriber attaches.
- The moment the panel opens, `subscribe_to_session` runs, the `onData`
  handler is registered, the PTY drains its buffer through the new
  handler in one burst → "all queued messages just flushed".

So Steve's word "queue" is slightly off — there's no explicit queue in
the dispatcher. The PTY itself is the queue, and the gateway is the
gate that lets it drain.

### Why this is the same shape as Symptom 1

Both bugs are **state machines that wait for an event that may never fire**:

| Symptom | "Queued" thing | Gating event |
|---|---|---|
| Browser 503 | command waiting for a target | `instance` arg present *or* exactly 1 instance |
| Terminal stall | PTY stdout bytes | a frontend WS client calls `subscribe_to_session` |

Both can be made robust by giving the readiness check a *fallback path* it
can take on its own.

### Fix shape (NOT implemented — RCA only)

Three options, in order of safety:

1. **Persistent orc monitoring.** Have the backend, on boot or first
   message-to-orc, call
   `getTerminalGateway().startOrchestratorChatMonitoring(ORCHESTRATOR_SESSION_NAME)`
   so the orc PTY *always* has an `onData` listener — independent of any
   frontend subscriber. The function exists at
   `backend/src/websocket/terminal.gateway.ts:363-386`; it's just not
   guaranteed to be invoked. This is the smallest semantic change.

2. **Queue-time warm-up.** Wrap `sendMessageToAgent` with a step that
   ensures the gateway has live monitoring for the target session before
   the write goes through. Slightly more invasive — touches agent
   delivery — but couples the readiness check tightly to the operation
   that needs it.

3. **Subscribe-on-write semantics in the gateway.** When `session.write`
   is called for a session with zero subscribers, the gateway implicitly
   enters a "persistent monitoring" mode that buffers + replays on
   first subscribe. Cleanest model, but largest blast radius — every PTY
   in the system would change behavior.

### Why I am not shipping this in the same patch

- It changes the lifetime contract of an `onData` listener that other
  features (agent output capture, learning auto-record subscriber,
  WorkItem heartbeat reviewer) implicitly rely on. Needs a dedicated
  review round.
- Steve has Path B working for today's demo. There is no acute pressure
  to land a fix today, only to *understand* it.
- The 30-line ceiling Steve set for direct-commit fixes does not fit
  any of the three options above.

*Recommendation*: file as a P1 follow-up, owner Sam, target the next
sprint. I'll prep the patch on a branch alongside the gateway tests when
we get the green light.

---

## Open questions for Steve / ORC

1. The relay-side ghost-session pruning behavior — is that already on
   crewly-pro's roadmap, or do we need a new ticket?
2. For the terminal-queue fix, is option 1 (eager orc monitoring) the
   preferred direction? It's the lowest-risk and matches the spirit of
   the existing `startOrchestratorChatMonitoring` helper. If yes, I'll
   spec + ship next slot.
3. Should we surface the new ambiguous-instance case in the
   `/api/browser/status` payload (e.g. `proxy.candidateCount`) so the
   frontend can warn the user when N>1? Not blocking, but cheap to add.

---

## Verification artifacts (browser fix)

- Branch: `fix/proxy-multi-instance-auto-select` (off `main`, no
  unrelated work piggy-backed).
- Tests: `npx jest --testPathPattern="backend/src/services/browser"` →
  **99 passed, 99 total**.
- Controller tests:
  `npx jest --testPathPattern="browser.controller"` → **29 passed**.
- Lines changed: 25 in source, ~70 in tests (2 new test cases). All
  diffs stay inside `backend/src/services/browser/`.
