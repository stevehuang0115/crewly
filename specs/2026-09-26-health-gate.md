# `/health` gate for non-loopback callers (#825)

## Rule

`GET /health` (root, not `/api/health`) runs `healthGateMiddleware` before its unchanged handler:

| Caller | Result |
|---|---|
| Loopback: socket `127.0.0.1` / `::1` / `::ffff:127.0.0.1`, or the first `X-Forwarded-For` hop when `CREWLY_TRUST_PROXY=1` | handler, **byte-identical** to before |
| Non-loopback with a valid API token (`X-Crewly-Token`, `Authorization: Bearer`, or the `crewly_token` cookie) | handler |
| Non-loopback without one | `401` + `WWW-Authenticate: Crewly-Token`, the same body as `/api` |
| `CREWLY_PUBLIC_HEALTH=1` (or `true`) | handler, for everyone |

Loopback classification is `getClientAddress` from the API-token middleware (spec: README "API token"). A forged `X-Forwarded-For` does nothing unless `CREWLY_TRUST_PROXY` is set.

## Why

crewly-mobile's AUTO mode probes `GET http://<lan>:<port>/health` and takes the LAN transport when it answers 2xx. Since 9eb405b9 (1.15.0) every `/api` call from a non-loopback address needs the token, which older app builds never send. So a phone on the same Wi-Fi chose LAN and got 401 on everything, without falling back to the Cloud relay that works (`mobile-api-relay.service` replays on loopback with the owner token).

Making the probe fail for exactly the callers who could not use `/api` fixes the transport choice for already-installed builds, without an app release.

## Consumers (surveyed 2026-09-26)

244 files mention `/health`. 20 are real consumers of this endpoint.

**Loopback, unaffected:**
- the CLI (`start`, `status`, `stop`, harness engine)
- desktop tauri-bridge
- Docker `HEALTHCHECK` and compose healthchecks (run inside the container)
- test and ops scripts

**Non-loopback:**
- **Dashboard on a LAN URL** (`Navigation.tsx`, `useVersionCheck.ts`, same-origin): sends the `crewly_token` cookie, so it passes once the token is entered.
- **crewly-mobile** pairing and probe: the intended 401.
- **Anything reaching a Docker install through the port mapping**, including `curl localhost:8787/health` *on the host* and a reverse proxy such as the api.crewlyai.com nginx route: needs `CREWLY_PUBLIC_HEALTH=1` in that deployment's env, or the token.

## Deployment notes

- `deploy/docker-compose.smb.yml` documents the opt-out, commented out. Enabling it re-breaks the mobile fallback on that network.
- **Production Docker (`deploy/docker-compose.prod.yml`, `deploy-cloud.sh`, nginx `api.crewlyai.com`) is not in git** (`deploy/` is gitignored), and the servers' env is not visible from the repo. If those nodes are monitored externally or verified from the host, set `CREWLY_PUBLIC_HEALTH=1` in their `.env` before deploying this release.
- **PM2 hosts (`desktop/deploy`, `/opt/crewly/.env`)**: crewly-pro passes its env to the OSS child. The same applies to a remote `curl http://<ip>:8787/health`.

## Tests

- `backend/src/index.test.ts` "/health gate (#825)". This deliberately replaces the old "`/health` stays open, even with `X-Forwarded-For`" assertion. It pins:
  - loopback byte-identical with and without the gate
  - trust-proxy off: a forged XFF is ignored
  - trust-proxy on: a LAN caller without a token gets 401, and with a header, Bearer or cookie token gets 200
  - the opt-out
  - the production wiring
- `backend/src/middleware/api-token.middleware.test.ts` "healthGateMiddleware (#825)".
