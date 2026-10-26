# Feature map for the dashboard (#811)

**Status**: slice 1 shipped (map + sync check). Slice 2 (reproduce CLI) and
slice 3 (bug report → reproduce with evidence → fix) are open.

## Problem

A bug report from the owner is usually a phone screenshot and one sentence.
An agent asked to reproduce or fix it can drive a browser, but does not know
which feature the screenshot shows, how a user reaches it, what "correct"
looks like, or which files own it, so it guesses. Each session also writes
its own throwaway script to drive the app, so results differ between
sessions. The feature map is the shared memory that removes the guessing;
the reproduce CLI (slice 2) removes the throwaway scripts.

## Slice 1 — the map and its sync check

### The map: `frontend/FEATURE_MAP.md`

One file, next to the code it describes. Three parts:

1. **Routes** — a table with one row per static route of `src/App.tsx`:
   the route, the page file, how a user reaches it (sidebar item, row, link,
   redirect, first run), and the page's one job.
2. **Old URLs** — a table with one row per `LEGACY_REDIRECTS` rule
   (`src/constants/routes.constants.ts`): the old URL and where it goes.
3. **Features** — one section per feature (a route or a group of related
   routes) with five lines: *Reach* (how to get there, including `?tab=`),
   *Expected* (what the page is supposed to do, from the page's header
   comment and the redesign spec), *Elements* (the `data-testid` anchors to
   drive it by), *Backend* (the `/api/...` calls or service modules that feed
   it), *Source* (the owning files).

The map is written for agents: short, concrete, no screenshots. Where the
map and a page's header comment disagree, the page is right and the map is
fixed. The redesign spec (`specs/2026-10-02-ui-redesign.md §Routes`) stays
the design authority for *what* the routes are; the map says how to find and
drive them.

### The sync check: `frontend/src/utils/feature-map.ts` + `.test.ts`

Pure parsers, run by the frontend vitest suite in CI (`ci.yml` → frontend
`npx vitest run`):

- `routesFromRouter(App.tsx source)` — every static `<Route path=...>` /
  `<Route index>` as an absolute path, nested routes joined to their layout
  route (`/` + `projects/:id` → `/projects/:id`). Attribute values may hold
  JSX (`element={<X />}`), so a tag ends at the first `>` outside braces.
  Routes rendered from an expression (`path={rule.path}`) are not static and
  are covered by the next parser.
- `legacyRedirectPaths(routes.constants.ts source)` — the `path:` of every
  rule in the `LEGACY_REDIRECTS` literal (the literal after the `=`, not the
  type annotation's `[]`).
- `markdownSection` + `routeTableRows` — the backticked first cell and the
  second cell of each row under `## Routes` and `## Old URLs`.
- `diffRoutes(router, map)` → `{ unmapped, stale }`.

The test fails, naming the routes to add or remove, when:

- a route in `App.tsx` has no row under **Routes**, or a row names a route
  that is gone;
- an old URL in `LEGACY_REDIRECTS` has no row under **Old URLs**, or vice
  versa;
- a **Routes** row names a page file that does not exist;
- a **Routes** row's route is not mentioned in any **Features** section.

Prose (Reach / Expected / Elements / Backend) is not checked; it is the part
a reviewer reads.

### Workflow

- New route → add the **Routes** row and a **Features** section in the same
  PR. The test is the reminder; `CLAUDE.md` says so under Frontend
  Development.
- Removed or renamed route → remove or rename the row; add the old URL to
  `LEGACY_REDIRECTS` and **Old URLs** when links to it may exist (Slack
  messages, decision cards, bookmarks).
- New `data-testid` an agent needs → add it to the feature's **Elements**.

## Slice 2 — reproduce CLI (open)

A script in the skills directory that starts the app (or attaches to the
running one), opens a feature by its map entry (route + `?tab=`), waits for
its key element, and saves evidence (screenshot, console errors, failed
requests, timings) under a per-run folder. Used by one existing skill or SOP
so agents stop writing ad-hoc drivers per session. The map's **Elements**
lines are what the CLI waits for; the **Reach** lines are what it follows.

## Slice 3 — bug report → reproduce with evidence → fix (open)

Given a screenshot and a sentence: match the screenshot to a feature by its
elements and words, run the reproduce CLI on that feature, attach the
evidence to the ticket, then fix. Needs slice 2 and a way to match a
screenshot to a map entry (OCR of visible labels against the map's words is
enough to start).

## Non-goals

- A generated map. The value is in the human-readable *Expected* and
  *Reach* lines; generation would give route lists, which the test already
  derives.
- Covering the Cloud portal (`crewly-web`) or the phone app here; each has
  its own router and would get its own map.
