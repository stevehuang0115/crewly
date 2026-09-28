# Cloud disconnect notice

Status: implemented on `feat/cloud-disconnect-notice`.

## Why

On 2026-09-27 the owner's second Mac (iriss-air) stopped heart-beating to
Crewly Cloud at 15:38 UTC. It never reconnected, not even after an auto-update
restart. Its agents kept posting to Slack, because outbound Slack uses their
own bot tokens. Inbound Slack reaches a machine only through Cloud → relay,
so every DM to those agents sat in the Cloud queue for hours. Nobody was told,
and the owner, who is never at the machine, had no way to fix it remotely.

## Behaviour

`CloudDisconnectNoticeService`
(`backend/src/services/cloud/cloud-disconnect-notice.service.ts`) starts with
the server, right after auto-update. It checks once a minute.

1. **Detect** (`evaluateDisconnect`, `cloud-disconnect-notice.utils.ts`). The
   machine must be signed in, meaning `$CREWLY_HOME/cloud/config.json` exists.
   A machine that never signed in has no config. `crewly cloud logout` and
   `CloudClientService.disconnect()` delete it. Given a sign-in, the machine is
   disconnected when either:
   - `CloudSyncService` is `auth_expired`. This fires at once, and the reason
     is `auth`.
   - No Cloud request (heartbeat, message poll, error-recovery heartbeat) has
     succeeded for 15 min. The clock starts at the last success, or at sync
     start if nothing has succeeded yet. The reason is `auth` if Cloud's last
     answer was 401/403 and the token refresh failed, otherwise `unreachable`.

   A restart that has not reached Cloud yet counts as `pending`, not
   `connected`, so no false "back online" message goes out.
   `CloudSyncService.getHealth()` supplies `lastContactAt`, `startedAt` and
   `authRejected`.
2. **Link** (reason `auth` only). Crewly runs `crewly cloud login --no-browser`
   in a PTY using the running node binary and
   `<package>/dist/cli/cli/src/index.js` (`cloud-login-runner.ts`). This is the
   same device pairing the owner would run by hand, driven the way the harness
   login broker drives a login. The runner reads the approve link
   (`…/cloud/pair?code=XXXX-XXXX`) and the code off the screen, waiting up to
   30 s for them. The CLI then polls crewly-auth, saves the credentials and
   calls `POST /api/cloud/connect` itself.
3. **DM.** The notice goes straight to the Slack Web API
   (`slack-owner-direct-dm.ts`) because Cloud is gone. It uses the
   orchestrator's own bot token, or the workspace bot token if the orchestrator
   has none, and the owner's Slack user id (`SlackService.getOwnerUserId`). The
   text is in Chinese and names the device, the reason, the local start time
   and the link. If no link can be had, the notice says Crewly keeps retrying.
4. **Owner input.** Device pairing needs no typed input. If the CLI ever shows
   a paste/enter prompt, the service polls `conversations.history` on the same
   DM every 5 s for up to 15 min. It types the owner's newest message into the
   PTY. The reply is never logged.
5. **Success.** The service reconnects from the saved config: stop
   CloudSync, then `performCloudConnect`. `CloudSyncService.start()` now also
   resets out of `error` / `auth_expired`. The service then posts
   「已重新连上 Cloud，排队的消息正在送达。」. The same follow-up goes out when the
   machine reconnects any other way, but only if the owner was told first.

## Rate limit and state

- The state file is `$CREWLY_HOME/cloud/disconnect-notice.json`. It holds the
  episode start, the reason, `lastNotifiedAt`, the DM channel and ts, whether
  the notice has a working link, and `loginBlockedUntil`.
- One notice per episode, repeated at most every 6 h. The state survives
  restarts, so a restart does not re-notify.
- **Expired link:** the device pairing lasts 15 min. When it expires, the next
  check starts a new CLI login and **edits** the existing message with the new
  link. Editing does not notify the owner again, so the link stays usable
  whenever they look.
- **CLI cannot start:** the notice goes out without a link, and a new start is
  retried every 5 min. The link is edited in once one comes.
- **Failed login** (denied, command error, timeout, or an edit that fails):
  one brief note 「重新登录没有完成（…）。Crewly 会在 <time> 再发一次新链接。」,
  then no login runs until the next 6-hour window.
- **Episode end:** reconnect or logout clears the state and kills any live
  login run.
- **No Slack on this machine** (no owner id or no bot token): the service only
  logs, at most once per window.

## Switch

`CREWLY_CLOUD_DISCONNECT_NOTICE=0` (or `false` / `off` / `no`) turns it off.
Constants live in `CLOUD_DISCONNECT_NOTICE_CONSTANTS` (`config/constants.ts`).
