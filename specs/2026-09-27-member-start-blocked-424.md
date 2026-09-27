# Per-member Start: a blocked start is 424, not 500 (B8 O1/O2, 2026-09-27)

A start that the user has to unblock is not a server error. Examples: a missing API key, a runtime that needs first-run setup, or a CLI that is not installed. These starts fail with `RuntimeStartupBlockedError` and `errorCode: RUNTIME_STARTUP_BLOCKED`.

## Status codes

| Endpoint | Blocked start | Unexpected error |
|---|---|---|
| `POST /api/teams/:id/start`, when no member started (#805) | 424, `error: "No team member could start. <Member>: <reason>"` | 424 when nobody started |
| `POST /api/teams/:teamId/members/:memberId/start` (this change) | 424, `error: "<Member>: <reason>"` | **500** (unchanged) |

- Both endpoints use the same status constant, `RUNTIME_STARTUP_CONSTANTS.NONE_STARTED_HTTP_STATUS`.
- Both use the same `<Member>: <reason>` wording, and the reason is passed through unchanged.
- `_startTeamMemberCore` now returns the session-creation `errorCode` in its result, so the handler can tell a blocked start from a genuine failure.

## `lastStartError` (O2)

- When a start fails, `TeamMember.lastStartError = { reason, at }` is saved with the member. The dashboard can then show why the start failed after a refresh.
- The next successful start removes the field.
- The field is set on the session-creation failure path, which covers both blocked and ordinary failures. It is not set for the invalid-role refusal or for an unexpected throw.
