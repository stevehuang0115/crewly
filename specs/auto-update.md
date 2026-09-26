# Automatic self-update

Status: implemented on `feat/auto-update` (based on 1.20.143).

## Why

The owner runs Crewly on several machines: the main Mac, a second Mac
(iriss-air), and a Linux server (steamfun-ops, systemd). Releases go out
several times a day and the machines drift. The Air sat on 1.20.127 while main
was on 1.20.143, so it missed a fix and its agent couldn't open the owner's
voice message. The owner is rarely at a machine. Every npm-installed machine
should stay on the latest release with nobody at the keyboard.

## Behaviour

`AutoUpdateService` (`backend/src/services/system/auto-update.service.ts`)
starts with the server, before the orchestrator auto-start.

1. **Check.** About 10 min after boot, then every 3 h
   (`AUTO_UPDATE_CONSTANTS.FIRST_CHECK_DELAY_MS` / `CHECK_INTERVAL_MS`), it asks
   the npm registry for `crewly@latest` through `VersionCheckService`. It
   accepts a cached answer only if that answer is younger than 30 min, and it
   records the result so `/health` (`latestVersion`, `updateAvailable`) stays
   current.
2. **Quiet window.** If the registry has a newer version, the service installs
   only when nothing is busy: no turn in flight (`InFlightTurnTracker.getMidTurn`)
   and no active agent (team member or orchestrator) whose `workingStatus` is
   `in_progress`. It checks twice, about 60 s apart. If either check finds
   something busy, it waits 5 min and tries again. After 24 h of waiting, a
   leftover `in_progress` flag no longer blocks the update. A turn in flight
   always blocks.
3. **Install** into the prefix the running copy lives in. The prefix comes from
   the package root: `<prefix>/lib/node_modules/crewly` on POSIX,
   `<prefix>\node_modules\crewly` on Windows. The command is
   `npm install -g --prefix <prefix> crewly@<exact version>`. This covers the
   default global prefix (nvm, Homebrew, /usr/local) and the user prefix
   `<crewlyHome>/npm-global`. It also installs over the running copy even when
   a different `npm` or `node` comes first on the service's PATH. The service
   uses the `npm` next to `process.execPath` when there is one. npm output goes
   to `<crewlyHome>/logs/auto-update.log`, and the install times out after
   10 min.
4. **Verify.** The installed `<packageRoot>/package.json` version must equal
   the target.
5. **Restart.** The service writes `<crewlyHome>/auto-update-pending.json`
   (`{fromVersion, toVersion, at}`). It then calls
   `RestartDrainService.requestGracefulShutdown({exitCode: 120})`, which is the
   same path `POST /api/system/restart` uses: pause deliveries, drain in-flight
   turns (up to `CREWLY_RESTART_DRAIN_MS`), persist interrupted turns, and exit
   with `RESTART_REQUESTED`. Before the restart it runs `process.chdir(packageRoot)`,
   because npm replaced the package directory (new inode) and the old cwd no
   longer exists (#244).
6. **Tell the owner.** On the next boot the service reads and deletes the
   marker. If the running version equals `toVersion`, it sends one notification
   through `SlackService.sendNotification`, which is the owner-notification
   path and DMs the workspace owner through the master bot:
   「Crewly 已自动升级到 x.y.z（本机：<deviceName>）」. It waits up to 10 min for
   Slack to connect. On that boot the generic "back online" announcement is
   skipped, so each upgrade sends one message, not two.

### Failures

- An npm error, a timeout, a version mismatch after install, or a missing
  restart handler counts as a failure. The service does not restart onto the
  suspect install. It backs off for 6 h (`FAILURE_BACKOFF_MS`) and records the
  failure in the status file.
- On the second failure in a row (`FAILURE_NOTIFY_THRESHOLD`), the owner gets
  one DM with the reason. The DM is sent once per target version.
- If the restart comes back on a version other than the one in the marker, it
  also counts as a failure.
- A successful upgrade resets the failure count and the backoff.
- There is **no automatic rollback**. If a release installs fine but crashes at
  boot, the machine stays down until someone runs `crewly upgrade` or pins a
  version.

### Skips (logged once, when the mode changes)

| Mode | When | Log line |
|---|---|---|
| `dev-checkout` | package root is a git working tree (`.git` dir or worktree file) | `dev checkout — auto-update off (<root>)` |
| `unmanaged` | not under `<prefix>/lib/node_modules/crewly` (Docker `/app`, a local dependency, the npx cache) | `not an npm global install — auto-update off` |
| `disabled-setting` | `settings.general.autoUpdate === false` | `auto-update off (Settings → General)` |
| `disabled-env` | `CREWLY_AUTO_UPDATE=0/false/off/no` | `auto-update off (CREWLY_AUTO_UPDATE)` |
| `no-supervisor` | no `crewly start` parent to respawn the backend | `auto-update off: no crewly start parent …` |
| (per cycle) | restart or shutdown already in progress | none; the cycle is skipped |

The package root is found from the entry script (`process.argv[1]`, realpath'd),
not from the cwd. An `npm link` into the repo resolves to the repo and counts
as a dev checkout.

`CREWLY_AUTO_UPDATE=1/true/on/yes` turns auto-update on even when the setting
is off.

### Setting

`settings.general.autoUpdate` is optional and defaults to `true`, so older
settings files merge to on. It appears as the "Automatic Updates" toggle in
Settings → General. The service reads the setting on every cycle, so a change
takes effect at the next check without a restart.

## How the restart relaunches in each run mode

The backend never relaunches itself. The process that brings it back is the
`crewly start` CLI parent, whose restart loop respawns
`node <projectRoot>/dist/backend/backend/src/index.js` when the backend exits
with 120. `projectRoot` is a path string, and it is the directory npm just
replaced, so the respawned backend runs the new version. `crewly start` now
sets `CREWLY_RESTART_SUPERVISOR=cli-start` on the backend it spawns. A backend
started by an older CLI recognises the parent from its command line
(`/proc/<ppid>/cmdline` or `ps`).

| Run mode | Chain | After auto-update |
|---|---|---|
| Foreground `crewly start` | terminal → CLI → backend | The CLI respawns the backend on the new code. The CLI process itself keeps the old code until it is next started. |
| macOS login item (`~/.crewly/crewly-start.command`) | Terminal → bash `while true` loop → CLI → backend | The CLI respawns the backend. If the CLI ever exits, the wrapper loop restarts the whole chain 5 s later on the new code. This is also why `kill -TERM $(cat ~/.crewly/crewly.pid)` relaunches: the pid file holds the CLI pid. |
| Linux systemd user unit (`crewly service install`) | systemd (`Restart=on-failure`, `KillMode=mixed`) → wrapper `exec node … start` → CLI → backend | The CLI respawns the backend. systemd only restarts the chain if the CLI exits non-zero. |
| Desktop app (Electron `ProcessManager`) | app → `crewly start --no-browser` (shell) → CLI → backend | The CLI respawns the backend. The app does not restart the CLI if the CLI dies. |
| Backend run directly (`node dist/backend/...`, the legacy PM2 `ecosystem.config.js`, Docker) | none | `no-supervisor` or `unmanaged`: auto-update stays off. |

**Self-SIGKILL edge case.** `shutdown()` has a force-exit timer (5 s when
`NODE_ENV` ≠ production, 10 s otherwise) that SIGKILLs the process when
teardown overruns. The exit code is then lost. The restart loop therefore
respawns once more when a fresh (< 5 min) `auto-update-pending.json` exists
(`cli/src/utils/backend-respawn.ts`). It does this at most once per CLI
process, so a new version that dies at boot cannot cause a respawn loop.
Parents older than this change don't have that fallback. In foreground and
desktop-app mode they stay down in this edge case. Under the macOS wrapper and
systemd, the CLI exits 1 and the supervisor restarts the chain on the new code.

## Mixed versions across machines

Each machine updates on its own schedule: first check about 10 min after boot,
then every 3 h, each waiting for its own quiet window. For up to a few hours
the owner's machines may run different versions. No extra coordination is
needed:

- Machines talk only through Slack, Cloud and the relay, and those protocols
  are additive between neighbouring releases.
- The quiet window keeps an upgrade from interrupting a turn. Anything cut off
  by the drain timeout is persisted and resumed after the restart
  (specs/safe-restart.md).

Two Crewly homes that share one global install both upgrade and restart. The
second install is a no-op for npm.

## Status and CLI

- `<crewlyHome>/auto-update-state.json` holds `currentVersion`,
  `latestVersion`, `lastCheckAt`, `mode`, `lastResult {outcome, at, version,
  message}`, `consecutiveFailures`, `backoffUntil` and
  `failureNotifiedVersion`. It is written atomically.
- `<crewlyHome>/auto-update-pending.json` is the restart marker. The next boot
  deletes it, even when it is malformed.
- `<crewlyHome>/logs/auto-update.log` is the human log: decisions, npm output
  and notices.
- `crewly update-status` shows the installed version, the running version
  (from `/health`), the latest version, whether auto-update is on and why not,
  the last check, the last result, failures and backoff, and the log path. It
  works with the backend stopped.

## Known limits

- On Windows, npm cannot always replace files that are in use (EBUSY/EPERM).
  That counts as a failure: back off, and DM the owner on repeat.
- Between the install and the restart (usually seconds, up to the drain
  timeout), the old backend is running with the new files on disk. A lazy
  `import()` in that window loads new-version modules.
- There is no rollback, and there is no staged or percentage rollout.
