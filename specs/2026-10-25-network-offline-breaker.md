# Network offline breaker

**Status:** shipped (this PR). Follow-ups listed at the end.

## Incident

2026-10-25 14:20Z to 17:35Z this machine had no internet. Every service that
talks to Crewly Cloud failed once a minute for three hours, each on its own:

| Source | Lines | Why it mattered |
|---|---|---|
| `BrowserProxy` relay WebSocket `getaddrinfo ENOTFOUND api.crewlyai.com` | 199 ERROR | pure noise |
| `CloudSyncService` recovery `fetch failed` | 196 WARN | noise |
| `CloudDisconnectNotice` "Could not DM the owner" | 183 WARN | Slack was as unreachable as Cloud; every retry was pointless |
| `SlackInstanceRegistry` / `SlackTeamChannels` "Cloud unreachable" | ~300 WARN | noise |
| Reconciler wake → `AgentRegistrationService` "never registered" → `IdleDetection` "stuck in started state" | 7 cycles × 2 agents | real damage |

The last row is the bug. The reconciler saw queued work for CE Owen and Vera,
started them, and the Claude CLI they run on could not reach its API. They
never registered, were marked stuck after 15 minutes, were killed, and were
started again 26 minutes later. Nothing in the harness knew the machine was
offline; each component retried as if its own counterpart were the only thing
down.

## Design

One process-wide judgement, `NetworkStatusService`
(`backend/src/services/core/network-status.service.ts`):

- Callers report `recordFailure(source, error)` and `recordSuccess(source)`.
- Only route/DNS-level codes count (`NETWORK_STATUS_CONSTANTS.OFFLINE_ERROR_CODES`:
  `ENOTFOUND`, `EAI_AGAIN`, `ENETUNREACH`, `ENETDOWN`, `EHOSTUNREACH`), read off
  the error, its `cause` chain (undici's `fetch failed`) or the message text.
  An HTTP status, `ECONNREFUSED` or a timeout never counts: a Cloud outage must
  not stop local agents.
- `OFFLINE_AFTER_FAILURES` (3) consecutive qualifying failures from any mix of
  sources trip the breaker; the first success resets it. `offline` and
  `online` events carry the status and the outage length.
- `shouldLog(source)`: full-volume log for the first failure of a source, then
  one per `REPEAT_LOG_INTERVAL_MS` (10 min) while offline. Callers log at debug
  otherwise.

Reporters: the relay WebSocket (`error` → failure, `open` → success) and the
Cloud Sync recovery loop (catch → failure, 2xx → success). The relay reconnects
every minute, so the breaker trips about three minutes into an outage.

Consumers:

| Where | Behaviour while offline |
|---|---|
| `LiveReconcilerDataProvider.executeWakeAction` | `start` and `rehydrate` return `{ outcome: 'skipped', reason: 'network offline' }`; one info line per agent per 10 min. `redeliver` is untouched (the agent is already alive). |
| `CloudDisconnectNoticeService` | new dep `isOffline()`; no DM attempt, not recorded as notified, the next minute's check retries. |
| Relay + Cloud Sync logs | first line as before (with `offlineMinutes` once tripped), repeats at debug. |

The queued work is still queued when the network returns; the reconciler's
normal loop picks it up with no special resume path.

## Not covered (follow-ups)

- `SlackInstanceRegistry`, `SlackTeamChannels`, `ConversationCloudSync`,
  `RemoteMcpAuth` still log every cycle. They go through other fetch wrappers;
  wiring them to `shouldLog` is mechanical and can follow once this shape has
  run for a while.
- Agents already running when the network drops are left alone. Their runtime
  turn dies with "Can't reach the API server"; the existing idle/exit monitors
  handle that, and the breaker only stops new starts.
- No `/health` field yet. `getStatus()` is ready for one.

## Tests

- `network-status.service.test.ts`: code extraction (self, cause chain,
  message, string, non-network ignored), trip threshold, Cloud-outage immunity,
  reset with duration, per-source log throttle and its reset.
- `reconciler-data-provider.test.ts`: start and rehydrate skipped while
  offline with no API call, start proceeds after `recordSuccess`.
- `cloud-disconnect-notice.service.test.ts`: no DM while offline, sent on the
  first check after the network is back.
