# Changelog

User-visible changes. Newest first.

## Unreleased

### Changed — behavior change

- **`GET /health` now requires the API token from non-loopback callers** (#825).
  Loopback (`localhost`, `127.0.0.1`, `::1`) is unchanged: same status, headers and body.
  A caller from another address without the token now gets `401` with the
  `WWW-Authenticate: Crewly-Token` challenge, the same as `/api`. It previously got
  `200` and the install's version and agent count.
  - **Who is affected:** self-hosters who monitor `/health` from another machine, and
    Docker installs checked from the host through the port mapping
    (`curl localhost:8787/health` on the host is not loopback inside the container).
  - **What to do:** send the token (`X-Crewly-Token`, `Authorization: Bearer`, or the
    `crewly_token` cookie), or set `CREWLY_PUBLIC_HEALTH=1` to keep `/health` open.
    Docker `HEALTHCHECK`s that run inside the container need no change.
  - **Why:** crewly-mobile picks its same-Wi-Fi (LAN) transport when `/health` answers
    200. Since 1.15.0 (9eb405b9) every `/api` call from that transport has needed a token the
    app does not have, so the app got stuck on 401s instead of using the Cloud relay.
    With this change it falls back to the relay.
