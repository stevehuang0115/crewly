# Shared Slack rooms — one machine owns an un-@'d owner message

Status: implemented (branch `fix/shared-room-owner`). Split out of crewly#1014.
Cloud side: crewly-services#29.

## Incident

On 2026-10-03 the owner wrote "linkedin有人回复了" (no @) in the Mac's
`#crewly-marketing`. The Mac's Marketing Ella and the Air's Personal
Assistant Ella both acted on it ("every awake agent decides"), and the Air's
orchestrator also routed it to the Air's Ella.

## Rules

1. **One owner per message, computed the same everywhere.**
   `roomOwnerInstance(room)` reads only Cloud's presence snapshot, judging
   every machine's agents (this machine's included) by it, so all machines
   agree:
   - Cloud's `room.home` (the machine whose team channel it is), when an
     agent there is awake;
   - otherwise the lowest instance id among machines with an awake member;
   - nobody awake → no owner; Cloud's `fallback` decides.

   A non-owner records the message and does not dispatch it. The
   orchestrator's fall-through skips a message another machine owns.
2. **One fallback.** Only the owner arms the 90 s unanswered watch, even
   when its agents got the message as optional. Deferring machines never
   do. When Cloud names a wake-up machine (`room.fallback`), only that
   machine arms it.
3. **No double hand-off.** The fallback does not hand the message over to a
   room lead that already holds it.
4. **Cloud** (crewly-services#29):
   - sends `room.home`, chosen by sorting on instance id;
   - keeps same-named agents on two machines as separate members;
   - delivers an un-@'d room message only to the owning machine, so older
     Crewly builds on other machines don't act on it.

## Known gaps

- Until crewly-services#29 is deployed, there is no `room.home`. The
  tie-break can pick a machine that joined a team room ad hoc, though it is
  still exactly one machine.
- Another machine's answer is not forwarded here, so the owner's fallback
  only sees its own agents' replies.
