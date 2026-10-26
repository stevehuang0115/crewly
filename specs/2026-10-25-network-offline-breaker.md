# Network offline breaker

**Status:** shipped in 1.20.415; follow-ups (log throttle for the remaining
Cloud callers, `/health` field) shipped in 1.20.416.

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

Reporters: the relay WebSocket (`error` → failure, `open` → success), the
Cloud Sync recovery loop (catch → failure, 2xx → success), since 1.20.422 the
three regular Cloud Sync polls too (heartbeat, device poll, message poll:
catch → failure, any answer → success — the message poll runs every few
seconds, so the breaker trips within seconds of a DNS outage instead of
minutes into the recovery loop, and resets with the first poll that answers),
and since 1.20.416
the three other callers that `fetch` api.crewlyai.com directly: the Slack
instance registry (`cloudRequest`), the Slack Cloud config refresh
(`fetchFromCloud`) and the conversation upload (`send`). Each reports the *raw*
fetch error, because the `SlackIdentityCloudError` they wrap it in keeps only
the message ("Cloud unreachable: fetch failed") and loses the DNS code in
`cause`. Any answer from Cloud, even a 5xx, counts as a success. The relay
reconnects every minute, so the breaker trips about three minutes into an
outage.

Third-party hosts never report. `RemoteMcpAuth` talks to the MCP server's own
token endpoint; a dead MCP host returning ENOTFOUND is not an outage and must
not pause agent starts. It only shares the log throttle.

`warnUnlessOfflineRepeat(logger, source, message, meta)` is the one helper the
callers use: warn (plus `offlineMinutes`) when `shouldLog(source)` says so,
otherwise the same line at debug with "(repeat while offline)". When the
breaker trips it clears every source's throttle slot, so each caller gets one
full warn at the start of the outage even if it warned seconds earlier while
still online.

Consumers:

| Where | Behaviour while offline |
|---|---|
| `LiveReconcilerDataProvider.executeWakeAction` | `start` and `rehydrate` return `{ outcome: 'skipped', reason: 'network offline' }`; one info line per agent per 10 min. `redeliver` is untouched (the agent is already alive). |
| `CloudDisconnectNoticeService` | new dep `isOffline()`; no DM attempt, not recorded as notified, the next minute's check retries. |
| Relay + Cloud Sync logs | first line as before (with `offlineMinutes` once tripped), repeats at debug. |
| Slack instance registry heartbeat + agent sync, Slack Cloud config refresh, Slack identity provisioning, conversation upload, Remote MCP refresh/sign-in | same throttle via `warnUnlessOfflineRepeat`; one slot per source (Remote MCP: per server id). |
| AppWake app polls + mention inbox, Cloud Sync queue re-registration | same throttle (`app-wake`, `app-wake-mentions`, `cloud-sync-register`); the no-queue-id `error` stays unthrottled (#1466). |
| `GET /health` | `network: { offline, offlineSince?, consecutiveFailures, lastFailureSource?, lastErrorCode? }` from `getStatus()`. |

The queued work is still queued when the network returns; the reconciler's
normal loop picks it up with no special resume path.

## Self-calls never wait on DNS (1.20.422)

The 2026-10-26 Wi-Fi drop (23:52–00:10Z) showed a second failure mode the
breaker cannot see. The DNS errors were connect timeouts, not `ENOTFOUND`, so
the breaker stayed quiet; meanwhile the reconciler's `start` wakes of two
agents failed seven times with `fetch failed` after exactly 10 s and five
dispatch writes timed out at 45 s — all calls from the backend to **itself**
(`http://localhost:8787/...`). Node resolves every hostname, `localhost`
included, with `getaddrinfo` on the libuv threadpool (4 threads); the pool was
full of hanging Cloud lookups, so the self-call's lookup queued behind them
until undici's connect timeout.

`getLocalApiBaseUrl()` therefore hands out an IP literal, never a hostname
(`backend/src/utils/local-api-url.utils.ts`, `selfCallHost`): `127.0.0.1` for
a wildcard (`0.0.0.0`, `::`) or hostname bind, the bind address itself when
the server binds a specific IP (IPv6 bracketed). Node skips the lookup for IP
literals, so a self-call — and an agent's `CREWLY_API_URL` — never waits on
DNS. The server passes its bind host at construction
(`setLocalApiPort(port, bindHost)`).

## Not covered (follow-ups)

- Agents already running when the network drops are left alone. Their runtime
  turn dies with "Can't reach the API server"; the existing idle/exit monitors
  handle that, and the breaker only stops new starts.
- `GoogleWorkspaceToken`, `MicrosoftToken`, `CanvaToken`, `TeamMoveCloud`
  also throw "Cloud unreachable" but run only on demand (a connector call), not
  on a timer, so they did not add to the outage noise and stay as they are.

## Tests

- `network-status.service.test.ts`: code extraction (self, cause chain,
  message, string, non-network ignored), trip threshold, Cloud-outage immunity,
  `warnUnlessOfflineRepeat` (online: every call warns; offline: one warn with
  `offlineMinutes`, then debug),
  reset with duration, per-source log throttle and its reset.
- `reconciler-data-provider.test.ts`: start and rehydrate skipped while
  offline with no API call, start proceeds after `recordSuccess`.
- `cloud-disconnect-notice.service.test.ts`: no DM while offline, sent on the
  first check after the network is back.
- `cloud-sync.service.test.ts`: three regular message polls failing with
  `ENOTFOUND` on `cause` trip the breaker, a 503 never does, the next answer
  resets it.
- `local-api-url.utils.test.ts`: the base URL is `http://127.0.0.1:N`; a
  specific bind address becomes the host (IPv6 bracketed); wildcards and
  hostnames mean loopback.
- `slack-instance-registry.service.test.ts`, `slack-cloud-config.service.test.ts`,
  `conversation-cloud-sync.service.test.ts`: three ENOTFOUND fetches trip the
  breaker through the raw error, the next answer clears it; the upload warns
  once, not per retry.
