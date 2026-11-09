# Feature map for the dashboard (#811)

**Status**: slice 1 shipped (map + sync check), slice 2 shipped (reproduce
CLI as the `reproduce-ui` core skill). Slice 3 (bug report → reproduce with
evidence → fix) is open.

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

## Slice 2 — reproduce CLI: the `reproduce-ui` core skill

`config/skills/agent/core/reproduce-ui/` (`execute.sh` → `reproduce.mjs`),
assignable to developer, QA, team-leader and orchestrator roles. It attaches
to the running dashboard (`CREWLY_API_URL`, loopback needs no token), opens a
feature by its map entry, waits for its key element and saves evidence.

- **Input**: `--route "/tickets?tab=runs"`, or `--feature <word from a
  Routes row>` with `--param k=v` for `:params`; `--wait <css>` overrides the
  selector; `--map`, `--base-url`, `--out`, `--timeout`, `--full-page`,
  `--browser`, `--dry-run`; the same fields as a JSON first argument.
- **Map lookup**: explicit `--map`, else `$CREWLY_PROJECT_PATH/frontend/
  FEATURE_MAP.md`, else the package's own copy (a repo install). Without a
  map, `--route` and `--wait` still work.
- **Wait selector** from the feature's **Elements** line: `x-panel-${tab}`
  is filled with the `?tab=` value; otherwise the first static id (ids with
  `${…}` or `a|b` alternatives are skipped); no Elements line → `body`.
- **Evidence**: `$CREWLY_HOME/evidence/<utc stamp>-<route slug>/` with
  `screenshot.png`, `console.json` (console errors, warnings, page errors),
  `requests.json` (failed requests and responses ≥ 400), `report.md`,
  `summary.json`; one JSON summary line on stdout.
- **Exit codes**: 0 element appeared, 2 it did not (evidence still saved),
  1 usage or browser error (JSON on stderr).
- **Browser**: `playwright-core` (a Crewly dependency) driving the installed
  Google Chrome (`channel: 'chrome'`) or `--browser <path>`; no browser
  download. Viewport 1280×800, `domcontentloaded` then the element, then up
  to 5 s of network idle.
- **Defaults**: 60 s per step and a 180 s skill timeout, because a loaded
  machine renders a tab panel in 25–45 s headless.
- **Tests**: `execute.test.sh` (fixture map, `--dry-run` only, offline).
- **Used by**: the developer `debugging` SOP, step 2.

Limits: pages behind a Cloud sign-in show their signed-out state (still
evidence); the owner's live Chrome and external sites are the
`remote-browser` skill's job; no automatic matching of a screenshot to a
feature (slice 3).

First real finding: the dashboard's CSP (`script-src 'self' 'unsafe-eval'`)
blocked the inline theme-init script on every load; fixed by hashing the
inline scripts of the built `index.html` into `script-src` at startup.

## Slice 3 — bug report → reproduce with evidence → fix

`reproduce-ui` 1.1.0 takes the report itself. The agent reads the
screenshot (it can; no OCR step) and writes the owner's sentence plus the
headings, tab names and labels it sees into `--report "<text>"` (or
`--report-file`, or `report` in the JSON input). `matchReport` in
`reproduce.mjs` scores every **Features** section of the map:

- tokens: lower-case words of three or more characters, a stopword list of
  words that name no feature ("page", "blank", "error", "loading" …), a
  trailing plural `s` dropped so "runs" meets "run";
- a word in the feature's title or **Expected** line scores 2, in its route
  segments, **Reach** or **Elements** (ids split on `-`) 1, and a word that
  is one of its tab names (`tabs \`board\` · \`runs\`` in the heading) 4 —
  the tab also becomes the `?tab=` of the route;
- the best feature is chosen when two or more of its words matched, it has
  3+ points and at least 1.5× the runner-up. One word is never enough
  ("Usage" alone is a `--feature`), so a vague report cannot pick a page by
  accident.

A match runs exactly as `--route` would (the tab panel is the wait target);
the plan and `summary.json` carry `match` (title, score, matched words, the
other candidates) and `report` (the text). No match, or two features about
equally: exit 3 with the candidates and their scores on stderr, so the agent
picks one and passes `--route`. `--route`/`--feature` take precedence over
`--report`.

**Evidence for the ticket**: `summary.ticketLine` (also the "For the ticket"
section of `report.md`, which now also quotes the report and names the words
that chose the feature): `Reproduced \`/tickets?tab=runs\`: key element
\`[data-testid="tickets-panel-runs"]\` NOT found (Timeout …); 1 console
error; 2 failed requests (first: POST …/api/b → 500); evidence: <dir>`. A 5xx
is named first, then a network failure, then the first 4xx. The agent puts
that line in the ticket, fixes, re-runs and adds the second line as proof.

Wired into the developer `debugging` SOP step 2; tests in
`execute.test.sh` (fixture map with Expected lines; tab pick, Expected pick,
no match, one-word, even split, report file, JSON input, precedence, no map,
`ticketLine` and `report.md` rendering through a node import — no browser).

Checked against the real map: "the runs tab under tickets is blank" →
`/tickets?tab=runs` [6] over `/tickets/runs/:id` [4]; "settings activity log
empty" → `/settings?tab=activity`; "Wiki recent pages not showing" →
`/wiki`; "something is off" → exit 3, no candidates.

Not done: the flow does not open the ticket or post the line itself — the
agent does, because which ticket (or Slack thread) the report came from is
the conversation's knowledge, not the skill's.

## Non-goals

- A generated map. The value is in the human-readable *Expected* and
  *Reach* lines; generation would give route lists, which the test already
  derives.
- Covering the Cloud portal (`crewly-web`) or the phone app here; each has
  its own router and would get its own map.
