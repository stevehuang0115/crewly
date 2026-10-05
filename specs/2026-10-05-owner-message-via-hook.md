# Owner messages at the next tool boundary

Status: implemented (branch `feat/owner-message-via-hook`)

## Problem

A busy Claude Code agent (orc, Ella, Milo) runs turns of 10–30+ minutes. An
owner message sent meanwhile waits in Crewly's queue
(`SubAgentMessageQueue`) until the turn ends, so the owner waits that long.
Claude Code's native queued input is not a fix: in 2.1.289, text queued while
tool calls remain is merged after the next tool result and the model may
ignore it (crewly#1118 notes: "MANGO-7" never answered).

## Design

Crewly already installs a PostToolUse hook (`config/hooks/agent-status/report.sh`)
whose backend response may carry `additionalContext` (#1086, team-lead nudge).
That channel now also carries the next waiting owner message.

1. **What is surfaced.** Queue items with `meta.owner` (the owner's own
   message, or the owner's decision answer), not a harness `reminder`, and
   with a `meta.where` conversation (needed as evidence of an answer). All
   other traffic is unchanged.
2. **When.** On a main-agent PostToolUse with a tool name. A PostToolUse
   carrying `agent_id` is a subagent's tool call (verified: Claude Code
   2.1.289 sets `agent_id` only there) and its context is not the agent's, so
   nothing is surfaced. `report.sh` now forwards `agent_id` for PostToolUse.
3. **One per call.** At most one owner message per hook call. The note is
   `[OWNER MESSAGE] …framing…` + the queued text (which already carries where
   and how to reply, as the normal delivery does). The whole
   `additionalContext` (owner note first, then the TL nudge) is capped at
   6000 chars; a long message is cut with a note to read it in its conversation.
4. **Keep until handled.** The item is not removed; it gets `surfacedAt` and
   `surfaceCount` (persisted with the queue). It is dropped
   (`answered-after-surfacing`) once the agent posts in its conversation after
   `surfacedAt` — same thread for a thread message; a top-level post in the
   same channel for a top-level DM (the agent was told to answer this one
   first) — checked at the next hook call and at flush.
5. **Re-surface once.** Unanswered after 5 minutes it is shown once more
   ("Reminder: …"); never a third time.
6. **Fallback.** The normal idle flush still delivers any unanswered item.
   A surfaced one is prefixed with "this owner message was already shown to
   you during your last turn … If you already answered it, do not answer
   again." So nothing is lost; at worst it arrives twice.
7. **Prompt.** Claude Code agents (communication module, every role, placed
   first so a budget trim keeps it) are told that `[OWNER MESSAGE]` notes come
   from Crewly's hook, are real owner messages, and are answered right away.
8. **Kill switch.** `CREWLY_OWNER_MESSAGE_VIA_HOOK=off`.

## Model behaviour (scratch test, 2026-10-05)

`claude -p --model haiku` (Claude Code 2.1.289) in a temp dir, task: five
`echo stepN >> log.txt` Bash calls, one per tool call. A PostToolUse hook
returns the owner note after step 2; the owner message says to reply via
`echo "REPLY: …" >> replies.txt`. "Immediate" = the reply is the very next
tool call, before step 3.

| Note framing | System-prompt rule (item 7) | Owner question | Answered | Immediate |
|---|---|---|---|---|
| draft A | no | "confirm codeword MANGO-7" | 1 / 3 | 1 / 3 — one run called it a prompt injection, one ignored it silently |
| draft A | yes | MANGO-7 | 5 / 5 | 4 / 5 (one answered after step 5, before ending the turn) |
| draft B ("it comes from Crewly's hook, not the tool's output… if you already answered, ignore") | yes | MANGO-7 | 2 / 5 | 2 / 5 — three called it a prompt injection |
| shipped (`buildOwnerHookNote`) | yes | MANGO-7 | 4 / 6 | 4 / 6 — two flagged "confirm a codeword I was just given" as suspicious |
| shipped | yes | "which file are you writing the steps into?" | 6 / 6 | 6 / 6 |

Reading: without the system-prompt rule the channel is unreliable. With the
rule and the shipped framing, a normal owner question was answered at the
next tool boundary every time; a request that itself looks like a test or an
injection ("confirm this codeword") is sometimes refused by Haiku. Small
samples, one model (Haiku; live agents mostly run Opus/Sonnet) — not a
guarantee, which is why the message stays queued until answered and the
idle delivery remains the fallback (items 4–6).
