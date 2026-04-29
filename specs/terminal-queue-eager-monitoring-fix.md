---
title: Terminal Queue — Eager Orc-PTY Monitoring (Fix Spec)
date: 2026-04-29
author: Sam (Tech Lead)
status: APPROVED for next sprint (ORC green-light 2026-04-29). NOT for today — Steve's customer demo (SteamFun) is the binding constraint; OSS internals fix may not compete with demo risk budget.
related:
  - specs/rca-readiness-state-machines-2026-04-29.md (Symptom 2 RCA)
  - PR #377 (browser-side companion fix, already merged)
  - .crewly/specs/rca-readiness-state-machines-2026-04-29.md (local notebook copy)
---

# Terminal Queue — Eager Orc-PTY Monitoring

## 1. Problem (one paragraph, from RCA)

Messages sent to the orchestrator (`crewly-orc`) PTY appear to "queue up
and not deliver" until a frontend WebSocket client opens the side
terminal panel — at which point all queued output flushes in one burst.
Root cause: `TerminalGateway.startPtyStreaming`
(`backend/src/websocket/terminal.gateway.ts:268-330`) attaches the PTY's
`onData` listener **only** when a frontend client calls
`subscribe_to_session`. `stopPtyStreaming` (`:340-354`, called from
`:420-425`) tears it down again when the last client disconnects.
Meanwhile `AgentRegistrationService.sendMessageWithRetry` writes to the
PTY unconditionally (`:3026, :3556`). With no `onData` handler armed,
the PTY's stdout buffer accumulates locally; nothing is broadcast to
the frontend until a subscriber attaches, at which point the buffer
drains in one burst. From the user's perspective: silence, then "all
queued messages flushed".

## 2. Why fix it

- *User-visible silence* on a path the orchestrator is supposed to own
  end-to-end. Steve's "feels like a focus issue" feedback is precisely
  this. Fix removes the foot-gun.
- *Hidden inside automation*. The orchestrator runs without a human
  watching the terminal panel most of the time. Any orc workflow that
  relies on round-tripping through the PTY (e.g., manual user prompts
  injected from Slack, future cross-machine event triggers in
  autonomy_v1.f1) is silently throttled by frontend presence today.
- *Common shape with PR #377*. Both bugs were "readiness check waits
  for an event that may never fire." Closing both removes a class of
  surprise.

## 3. Proposed fix — Option 1 (eager orc monitoring)

The cleanest, smallest change. The helper already exists:

```ts
// backend/src/websocket/terminal.gateway.ts:363-386
public startOrchestratorChatMonitoring(sessionName: string): void {
  // Attaches a persistent onData listener to the orchestrator PTY,
  // independent of any frontend subscriber. Existing today; just not
  // guaranteed to be invoked.
}
```

### Change shape

1. **Boot wiring.** In `backend/src/index.ts` (or wherever
   `TerminalGateway` is constructed and wired to the orchestrator
   session lifecycle), call
   `terminalGateway.startOrchestratorChatMonitoring(ORCHESTRATOR_SESSION_NAME)`
   immediately after the gateway is up *and* the orc PTY is known to
   exist. If the orc PTY is created lazily on first message, wrap the
   start hook in the orc-PTY-create code path instead.

2. **Defensive idempotency.** Make `startOrchestratorChatMonitoring`
   safe to call repeatedly — if the PTY already has a persistent
   listener attached by us, the second call is a no-op. Today the
   helper does *not* guard against this; second invocation would
   register a duplicate handler and double-broadcast. Add a guard
   `Set<sessionName>` on the gateway.

3. **Lifecycle hook.** When the orc session is *destroyed* (e.g., agent
   stop), tear the persistent listener down so we don't leak handlers
   into a stale PTY reference. Add a corresponding
   `stopOrchestratorChatMonitoring(sessionName)` if it doesn't already
   exist; call it from the agent-stop path.

4. **Tests.**
   - Unit: gateway with `startOrchestratorChatMonitoring` armed →
     write to PTY → verify `onData` callbacks fire and broadcast queue
     receives the bytes, *without* any subscriber having connected.
   - Unit: idempotent second call → still exactly one listener.
   - Unit: stop hook removes the listener and does not affect
     subscriber-driven streaming on other sessions.
   - Integration: agent-registration `sendMessageToAgent` to orc with
     zero subscribers → message reaches a separately attached
     spy-listener. Repro of Steve's exact symptom; should fail before
     the fix and pass after.

### Estimated diff size

- Source: ~30–60 lines split across `terminal.gateway.ts` (idempotency
  guard + stop hook) and `index.ts` (boot wiring).
- Tests: 4 new unit cases + 1 integration case (~120 lines including
  setup boilerplate the existing suite already establishes).

This does not fit Steve's "<30 lines for direct commit" envelope, hence
the deferred slot.

## 4. Alternatives considered

### Option 2 — Queue-time warm-up (rejected for now)

Wrap `sendMessageToAgent` so that, before the write, the gateway is
asked to ensure persistent monitoring for the target session. Tighter
coupling between the operation that needs the readiness and the check.
Slightly more invasive; touches agent delivery (`agent-registration.service.ts`
sits in a high-traffic path). Larger blast radius.

### Option 3 — Subscribe-on-write semantics (rejected)

Change the gateway so any `session.write` for a session with zero
subscribers implicitly enters persistent-monitoring mode and buffers +
replays on first subscribe. Cleanest model but every PTY in the system
would change behavior — not just the orchestrator's. Out of proportion
to today's bug.

## 5. Risks

| Risk | Mitigation |
|---|---|
| Memory leak from never-detached `onData` listener | Lifecycle hook (#3 above) tied to agent-stop. Plus: idempotent guard prevents accumulation. |
| Output flood when frontend attaches mid-stream | Already handled by the existing buffering replay logic in `startPtyStreaming` — eager mode just means there's *less* unread buffer at attach time, not more. |
| Race: orc PTY not ready at gateway boot | Wrap the start call in a "PTY-ready" callback; or retry once after 1s. The existing `startPtyStreaming` already tolerates this race for subscriber paths. |
| Breaks other features that rely on "no subscriber = no broadcast" | Audited: `agent-output capture`, `learning auto-record subscriber`, and `WorkItem heartbeat reviewer` all read from the gateway's broadcast queue, not directly from PTY events — none of them depend on listener absence as a signal. **Confirm during review round 2.** |
| Rollback complexity | Single boot-wiring line + one method on the gateway. Trivial revert. |

## 6. Rollout plan

1. Branch off `main` after PR #377 has been deployed (next natural
   restart). Branch name: `fix/terminal-eager-orc-monitoring`.
2. Implement option 1 with the four test cases above. Aim for a single
   atomic commit per the team Code Commit SOP step 1.
3. Self-review round 1 (refactor & consistency): extract any shared
   guard into a util only if it's used in 2+ places, otherwise inline.
4. Self-review round 2 (efficiency & reliability): confirm no double
   broadcast, confirm no listener leak across PTY restart.
5. Self-review round 3 (overall quality): JSDoc on new methods, dead
   code removal.
6. Open PR, request Arch fast-ACK (no architectural change — just
   moving an existing helper from "lazy" to "eager"), merge, deploy on
   next restart.
7. Post-deploy: smoke test by sending a `send-message` to orc with the
   frontend tab closed, confirm Slack relay output shows up promptly.

## 7. Definition of done

- [ ] All 5 new tests pass.
- [ ] `backend` suite still green (current baseline pre-fix as of PR
      #377: ~all passing; will re-baseline at branch start).
- [ ] TypeScript compiles clean (`tsc -p backend/tsconfig.json --noEmit`).
- [ ] Manual repro of Steve's exact symptom: `send-message → orc` with
      frontend panel closed → message visible in `/api/agent/{orc}/output`
      within 1s. Today: silence until panel opens. After fix: prompt.
- [ ] No regression on subscriber-driven path (open panel → live stream
      still works exactly as before).

## 8. Out of scope (called out for explicit deferral)

- The chrome-extension MV3 service-worker pong-timeout root cause.
  Owner: chrome-extension repo / crewly-pro relay reliability.
- The cloud-relay ghost-session pruning behavior. Owner: crewly-pro.
- Any change to `AgentRegistrationService.sendMessageWithRetry` or
  `QueueProcessorService.processNext`. We are fixing the *broadcast*
  side, not the *write* side.
