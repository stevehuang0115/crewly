# Changelog

User-visible changes. Newest first.

## Unreleased

### Added

- **Project tickets — each project's own backlog, tracked in git.** One markdown file per
  ticket in `<project>/.crewly/tickets/` (frontmatter + Description / Acceptance criteria /
  Log). The project page's **Tasks** tab is now a board of these tickets (create, edit, move,
  assign). Members of the project's teams pick up `ready` tickets by themselves when idle;
  each pickup is one WorkItem, and the ticket moves to done when that WorkItem is verified.
  Agents use the new `project-tickets` skill (team leads also `assign-ticket`); the owner can
  ask the orchestrator to "put this in the backlog". API: `/api/project-tickets`.
  See `specs/2026-09-28-project-tickets.md`.
  - **Git:** when a project's `.gitignore` hides `.crewly/`, Crewly appends a small block that
    re-includes only `.crewly/tickets/` (existing lines are not changed).
  - **Old `.crewly/tasks/` files:** `crewly tickets migrate <projectPath>` shows what would be
    imported (unfinished open / in_progress files, as backlog tickets); add `--apply` to
    import. The originals are left untouched; re-running is safe.

### Changed — behavior change

- **MCP `crewly_assign_task` now creates a real WorkItem** through the running backend and
  returns its `workItemId` (it used to return a made-up id and do nothing). It fails with a
  clear message when Crewly is not running.
- **Removed dead project routes and buttons:** `/api/projects/:id/tickets*` and
  `/ticket-templates*` (YAML tickets nobody wrote), and the project page's "Create task /
  Create milestone" and "build tasks" actions, which called endpoints that did not exist.

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
