# Release input-guard check (crewly#1038)

## Problem

1.20.198 shipped an input-box guard that read Claude Code's labelled top rule
(`──── crewly-orc ─`) as `unknown`. Every message delivery was held for about
40 minutes. The recorded fixtures never had that layout, so tests were green.
Since then each release has been checked by hand: render each running agent's
terminal into a `PtyTerminalBuffer`, run `classifyTuiInput` from the freshly
built dist, and treat anything but `empty`/`ours` as a blocker. This makes that
check part of the release and upgrade flow.

## Design

### Check = real buffers + the NEW build's classifier

- The running backend owns each agent's `PtyTerminalBuffer`. It reads
  `backend.captureInputView(session)` (faint ghost text blanked, cursor row),
  which is exactly what the live guard reads. A plain-text capture would lose
  the faint styling and show a grey placeholder as `foreign`.
- The views (plain JSON: `lines`, `cursorRow`) are piped to a **fresh node
  process** that runs the NEW build's `input-guard-classify.js`
  (`<build>/backend/backend/src/scripts/input-guard-classify.js`). A child
  process is used because the running process has the OLD `tui-input-guard`
  and `constants` cached in the ESM module graph; only a new process loads the
  new classifier and its constants.
- Per agent the child returns: `state` (`empty|ours|foreign|unknown`), `layout`,
  `idle` (no spinner / busy bar, via `screenShowsTurnInProgress`), a verdict and
  a short reason. The probe is `classifyTuiInput(view, '__probe__', 'before-write')`.
- Verdicts:
  - `fail`: idle, no input box parses, AND a known READY footer is in the
    bottom rows (Claude `shift+tab to cycle`, `? for shortcuts`, Gemini's
    composer hint, Codex's `ask codex to do anything`).
  - `warn` (with the reason shown): no box and a runtime NOT_READY marker
    (sign-in, trust, approval), a dialog/login/picker marker, or no ready footer
    at all (startup banner, shell prompt). These never block.
  - `skip`: blank screen, or a PTY session with no styled capture.
  - `warn`: idle and `foreign` (the box holds text; only its length is shown),
    or busy and `unknown`.
  - `ok`: `empty` / `ours`. `skip`: blank screen (session still starting).
- When the backend has no session backend the result is `unavailable` (logged),
  never `ok` with 0 agents.
- The check passes iff there is no `fail`. `warn` is reported, never blocks.
- The classifier is only called; `tui-input-guard.ts` and
  `session-command-helper.ts` are unchanged.

### Entry points

1. `crewly doctor --input-guard [--build <path>]`: calls the local backend's
   owner-only `POST /api/system/input-guard-check { build? }`, prints one row
   per agent (session, runtime, state, verdict, reason), exits 1 on any `fail`
   (and 2 if the backend cannot be reached). `--build` accepts a package root,
   a `dist` dir, or the `dist/backend` dir. Default: the running install.
2. Upgrade gate. In `SystemControlService.runUpgrade` and
   `AutoUpdateService.runCycle`, after the install is verified and before the
   upgrade marker and restart, the check runs against the installed package.
   On `fail`: no marker, no restart. The old version keeps running; the failure
   is logged (`auto-update.log` / backend log / action record `failed`); the
   owner gets one short English message per target version (ledger
   `<crewlyHome>/input-guard-blocked.json`). Auto-update backs off like any
   other failure.
   - Override: `POST /api/system/upgrade { when, force: true }` (owner-only)
     skips the gate and says so in the record; `CREWLY_SKIP_INPUT_GUARD_CHECK=1`
     does the same for auto-update.
   - A build that predates the script (file missing) is "unavailable": logged,
     not blocking. A script that crashes or times out is a failure.
   - The new package is already on disk after a block. The owner notice and
     action message say so: any restart (crash, supervisor, manual) loads it.
     A `blocked-build.json` marker in CREWLY_HOME records it; boot warns while
     it stands; a passing check or a force clears it.
   - The notice is recorded as sent only after the send succeeds. A retry for a
     version already on disk re-runs the check without `npm install`.
3. Mac dev checkout (build, then kill the backend so the supervisor relaunches):
   `npm run check:input-guard` = `crewly doctor --input-guard --build dist`.
   Run it after `npm run build` and before killing the backend.

## Tests

Unit only, using the recorded fixtures in `__fixtures__/tui/` (including
`labelled-rule-*`, `busy-labelled-*`): the classify script's pure function, report
building, build-path resolution, child-process runner (fake spawn), the
upgrade gate in both services (block, pass, force, unavailable, once-notify),
and the CLI printer/exit codes. No live PTY/Claude runs.
