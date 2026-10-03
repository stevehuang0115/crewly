# Review fixes: experiment cards, signal digest, seo-ops CLI

Status: implemented
Date: 2026-10-03
Issues: #986 / #992 (experiment cards), #987 / #994 (signal digest), #988 (seo-ops CLI)

The review of the experiment cards and the daily signal digest found places where the loop
records something that did not happen (a result "reported" that nobody received, a ship time
that is really the time of a note), does work twice, or keeps failing silently. This spec fixes
them and finishes the seo-ops interface the two features build on.

## 1. Experiment cards

### 1.1 Ship time
A card linked to a ticket ships when the ticket reaches `done`. The ship time dates the baseline
and the observation window, so it must be the time of the **done transition**:

- Project ticket: the last `<from> → done` (or `created (done)`) line of the ticket's `## Log`.
  The ticket's `updatedAt` is not used: any later write bumps it, including the note the card
  itself writes on the ticket when it is created.
- Harness ticket (TKT-n): `completedAt`. `updatedAt` is not used.
- The ticket is done but no done time is recorded:
  - `create` refuses with 400 unless the caller passes `shippedAt`;
  - the tick records `ship_time_unknown` on the card once, tells the owner once, and waits for
    an explicit `ship --shipped-at`.
- `create` with a ticket that is already done (and dated) ships the card right away.
  `create` with `shippedAt` ships it at that time (not in the future).

### 1.2 Reported means delivered
`SlackService.sendNotification` resolves `true` only when Slack accepted the message, and
`false` when there was nowhere to send it (no default channel, not connected, no reachable
fallback). A Slack error on an explicit channel still throws. A message suppressed by the dedup
window counts as delivered. The Slack bridge passes the result on (and answers `false` when
notifications are off).

The owner notifiers of the experiment cards and the ticket autopilot return that result. A
result is marked `reportedAt` only when the notice was delivered; otherwise a later tick sends it
again. The "fetch keeps failing" notice is likewise re-armed when it was not delivered.

### 1.3 GA4 page filter
GA4 reports landing pages as paths. A GA4 metric's `page` is stored as a path: a full URL is
reduced to its path, and any query string or fragment is dropped (`https://site/x/?utm=1` →
`/x/`). seo-ops filters on GA4's `landingPage` (path without the query string), so a page with
tracking parameters is still counted.

### 1.4 Retry backoff
A fetch that fails is retried on the next tick (15 min). After `MAX_FETCH_ATTEMPTS` (6) failures in
a row, it is retried once every 24 h (`FETCH_BACKOFF_MS`), not every tick forever. A success
resets the count. `measure` (an explicit request) is not held back.

### 1.5 Measured once
A `measure` racing a tick must not measure or report twice:
- one measurement per card at a time in the process;
- the result is written only when, under the store lock, the card is still `running`
  (the baseline likewise only when it has none);
- the owner report is claimed under the store lock (`reportedAt` set) before it is sent, and
  released when it was not delivered.

### 1.6 Conversions
GA4 metrics gain `conversions` (GA4 key events; `event` optional, to count one of them), next to
`sessions` and `events` (`event` required). Same count verdict rules (minimum 10 across both
windows).

## 2. Signal digest

### 2.1 One card a day
`POST /api/signal-digests` for a site that has a digest from the last 20 h with actions still
open:
- the same actions (same keys, any order, case and spacing ignored): answers with that digest,
  posts nothing (a retried call);
- different actions: 409 naming the digest and how many actions are still open.
Older digests are replaced as before (their open actions expire).

### 2.2 Source status
- `collect` (execute.sh) reports each source's status after every run:
  `POST /api/signal-digests/sources {site, sources}` with collect's own wording
  (`{"ga4":"ok","gsc":"error: why","inbox":"not configured"}`; a `[{name, state, detail}]`
  list is accepted too). The output gains `sourceReport`.
- Crewly keeps the latest report per site, and which failing sources the owner was last told
  about. When a source **starts** failing, or a source the owner was told about **stops**
  failing, the owner gets one notice (`Signal digest · <site>: …`, "Not working: Search Console —
  HTTP 403", "Working again: GA4"). Nothing is sent while nothing changes. A notice that was not
  delivered is sent with the next report.
- The daily "no source could be examined" team-channel post is removed (skill text and the
  scheduled task). With no examinable source `collect` still exits 1 and the lead stops.
- A digest records the source status of its run (`sources`): from the proposal's `sources`
  when given, else the site's report from the last 20 h. The card shows it under the header:
  `Sources: GA4 ✓ · Search Console ✗ HTTP 403 · Inbox — not set up`.

### 2.3 One bad source does not kill collect
Each source runs inside its own `except Exception`; any failure becomes `error: <message>` (or
the exception type when it has no message) and the other sources still run.

### 2.4 Sitemap rotation
The broken-page check takes `errors.maxUrls` sitemap URLs starting at a day-based offset and
wrapping around, so successive days check successive slices and the whole sitemap is covered every
`ceil(urls / maxUrls)` days. The output gains `sitemapUrls` and `sitemapOffset`.

### 2.5 Owner-only answer route
`POST /api/signal-digests/:id/items/:n` was owner-only only because it refused requests that
carry `X-Agent-Session`; an agent could leave the header out and press Do on its own proposal.
It now uses the existing `requireOwnerToken` middleware (as OKR approval does): the API token is
required even from loopback (agents never hold it; the dashboard and the mobile relay present
it), and any request with `X-Agent-Session` is refused with 403. The Slack card's buttons are
unaffected (they check the Slack user is the owner).

Other owner-only endpoints with the same header-absence weakness are listed in the PR for a
separate, cross-cutting fix.

## 3. seo-ops (1.2.0)

- Every JSON output carries `schemaVersion` (1) and `errors[]`. `pattern-queue plan --json`
  becomes `{schemaVersion, errors, candidates}`.
- Exit `4` = partial result: some URLs or parts failed, or URLs were skipped over a cap. The
  JSON's `errors` says which.
- `metric`:
  - `--by date|page|query` (query: gsc only) and `--host` (gsc: page-URL regex filter for
    `sc-domain:` properties; ga4: `hostName`, overriding `ga4HostName`);
  - ga4 `conversions` (key events), `events` (`--event` required);
  - ga4 `--page` is reduced to a path and matched on `landingPage`;
  - `--by page` rows carry `url`: GSC pages normalised with `urlNormalize`, GA4 paths joined to the
    site origin and normalised the same way, so the two join;
  - a failure still prints the JSON with `errors` and exits non-zero (the backend fetcher reads
    those errors when stderr is empty, and refuses output that carries errors);
  - no Search Console lag is applied to GA4.
- `inspect (--url U … | --urls-file F) [--json]`: URL Inspection for exactly those URLs (no
  impression gate), up to `inspectMax`. Each URL is `ok`, `error` (its own message; the run goes
  on) or `skipped` (over the cap). Exit 0 / 4 / the error's code when every URL failed.
- `page-report`:
  - `--ga4` without `ga4PropertyId` is an error;
  - GA4 landing pages are no longer cut to 15 / 50: all rows are fetched (paginated) and written to
    the JSON, text mode prints the top 15;
  - rows are `{path, url, sessions}` merged by path;
  - a failing inspection is recorded per URL (`inspect-failed`, `index.status: "error"`) and the
    run goes on;
  - URLs over the cap get `index.status: "skipped"`;
  - a GA4 failure is an `errors` entry.
- The skill version is 1.2.0 and the registry is regenerated, so installed copies update.

## Tests
- `experiments/*`: done-transition parsing, ship from the transition, missing time → 400 /
  `ship_time_unknown`, backoff, undelivered stuck notice and result, measure/tick race,
  GA4 page normalisation, fetcher JSON errors.
- `slack.service` / bridge: `sendNotification` delivery result.
- `signal-digest/*`: duplicate guard, source reports and notices, card source line, store,
  contract parsing, owner-token route.
- `seo_ops.test.py`, `signal_digest.test.py`, and the skills' `execute.test.sh`.
