# Agent-status hooks: ingest Claude Code hook events for `waiting_on_human` (#815, PR 2)

Companion to `specs/2026-09-26-agent-waiting-on-human.md` (PR 1, #820). That spec covers screen and title detection, owner routing and the reconciler. This one adds the third signal from #815: Claude Code's own hook events.

It is stacked on #798 (the control-plane guard) because it writes into the guard's per-session settings file.

## Why hooks

Screen detection runs on a 30 s poll and has to match text. Claude Code signals the same state directly:
- `Notification` with `notification_type: permission_prompt` (a permission dialog is showing)
- `Notification` with `notification_type: elicitation_dialog` (a question for the user is showing)
- `PermissionRequest`

It also signals the end of the state: `PostToolUse` (the tool ran, so the prompt was answered), `UserPromptSubmit` and `Stop`.

Codex 0.157 has no equivalent. Its `notify` fires on turn completion only, so Codex stays on screen and title detection, where its `Action Required` title is already a strong signal.

## Pieces

| Piece | Where |
|---|---|
| Hook script | `config/hooks/agent-status/report.sh` |
| Registration | `buildControlPlaneSettings(paths, guardHook, statusHook)` in `control-plane-guard.service.ts`: the same `<session>.settings.json` passed with `--settings` |
| Endpoint | `POST /api/agent-hooks` (`controllers/agent-hooks/`) |
| State | `services/monitoring/agent-hook-state.ts`: the latest signal per session, in memory, bounded to 500 sessions |
| Constants | `AGENT_STATUS_HOOK_CONSTANTS` in `backend/src/constants.ts` |

### One settings file, guard untouched

Claude Code takes one `--settings`, so the status hook is merged into the guard's file rather than written as a second one.
- It is registered only on `Notification`, `PermissionRequest`, `Stop`, `UserPromptSubmit` and `PostToolUse` (the tool events use matcher `*`).
- It is **never registered on `PreToolUse`.** That event belongs to the guard, and a test asserts that the deny list and the `PreToolUse` entry are byte-identical with and without the status hook.
- `config/hooks/agent-status/` is added to the guard's write-protected install dirs, so an agent cannot silence or rewrite the hook.
- With the guard's kill switch (`CREWLY_CONTROL_PLANE_GUARD=0`) no settings file is written. The status hook is then off too, and screen and title detection still cover the state.

### Privacy contract

The hook's stdin can carry `tool_input`, tool output, prompts, messages and the transcript path, and any of these can hold secrets. The script handles it as follows:
- It extracts exactly two fields, `hook_event_name` and `notification_type` (with jq, or with a narrow sed fallback when jq is absent).
- It keeps a value only if it is a plain identifier (`[A-Za-z_]{1,64}`); anything else is dropped, not sanitised.
- It sends `{event, notificationType?}` plus the `X-Agent-Session` header, and prints nothing.
- It always exits 0, and the POST has a 2 s ceiling, so the hook can never block or slow the agent.

The endpoint enforces the same contract. Events and notification types are checked against fixed allowlists, extra body fields are ignored, and only identifiers are stored.

Tests: a key-looking string placed in `tool_input`, `message`, `tool_response` and `transcript_path` never appears in the POST body or headers. This holds with jq and without it (the no-jq test builds a PATH that provably lacks jq).

## Event → signal

| Event | Signal |
|---|---|
| `PermissionRequest`; `Notification`/`permission_prompt` | waiting (`permission`) |
| `Notification`/`elicitation_dialog` | waiting (`menu`) |
| `PostToolUse`, `UserPromptSubmit`, `Stop` | cleared |
| `Notification`/`idle_prompt` or `auth_success` | no signal (idle at the input box is not waiting on a human) |

## Follow-up (after PR 1 and #798 are on `main`)

- `computeAgentAttention` takes the hook signal as a third input. A fresh `waiting` hook signal with no later `cleared` means `waiting_on_human`, with precedence over the screen.
- The activity monitor reads `getHookSignal(session)` each poll.
- The endpoint triggers an immediate evaluation, so the hook path does not wait for the 30 s poll.

This is kept out of this PR because PR 1's verdict code is not on #798's base (105 commits behind `main`).
