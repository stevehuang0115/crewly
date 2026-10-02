/**
 * Global Jest setup — runs before every test file (`setupFilesAfterEnv`, in
 * both `jest.config.js` and `jest.unit.config.js`).
 *
 * Its one job is to keep tests out of the developer's real home.
 *
 * Every file gets its own throwaway home under the OS temp dir:
 * - `CREWLY_HOME` = `<temp home>/.crewly`, so code that resolves the home
 *   through `getCrewlyHomePath()` (StorageService and friends) writes there.
 *   Test files that need a specific home still set `process.env.CREWLY_HOME`
 *   themselves; this is only the default underneath them.
 * - `os.homedir()` returns `<temp home>`, for the ~140 call sites that build
 *   `homedir()/.crewly` directly (DeviceIdentityService among them) and for a
 *   test that deletes CREWLY_HOME while its async work is still running.
 *   Setting HOME is not enough: jest gives each file a copy of process.env,
 *   but `os.homedir()` reads the worker's real environment. The function is
 *   replaced by plain assignment, not a spy, so `jest.restoreAllMocks()`
 *   cannot bring the real home back. (The worker's `os` module is shared by
 *   all its test files; each file's setup re-points it.)
 * - `HOME` / `USERPROFILE` point at the temp home too.
 *
 * 2026-10-02: a cloud-sync test that unset CREWLY_HOME while a registration
 * was in flight wrote a random relay queue id into the real
 * `~/.crewly/cloud/relay-queue.json`; the owner's running Crewly moved to a
 * queue the relay had never seen, hit the per-user quota and was deaf to
 * Slack for ~30 min. `jest.unit.config.js` had no isolation at all, and
 * `os.homedir()` was never covered. `backend/src/services/core/isolated-test-home.guard.test.ts`
 * fails if device.json, api-token, cloud/config.json or relay-queue.json can
 * reach the real home again.
 *
 * Child processes spawned with the default environment still inherit the
 * real HOME; pass `env` explicitly when spawning something that writes there.
 *
 * Issue #729: this file used to be a single line of literal `\n` escapes —
 * one big `//` comment — so the `CREWLY_HOME` it claimed to set was never set,
 * and a verification run leaked three stub teams into the real
 * `~/.crewly/teams`. `tests/setup.test.ts` now fails if the isolation stops
 * working.
 *
 * The override is unconditional on purpose: a developer shell that exports
 * `CREWLY_HOME=~/.crewly` must not be inherited by the suite.
 *
 * @module tests/setup
 */

import { mkdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Prefix of every per-file test home, so stray ones are easy to recognise. */
export const TEST_CREWLY_HOME_PREFIX = 'crewly-jest-home-';

/**
 * The throwaway home for the current test file. Captured here, not re-read
 * from the environment at teardown, so a test that repoints `CREWLY_HOME` can
 * never make the cleanup below remove a directory it does not own.
 */
const isolatedHome = path.join(
  os.tmpdir(),
  `${TEST_CREWLY_HOME_PREFIX}${process.pid}-${process.env.JEST_WORKER_ID ?? '0'}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`,
);

/** Key under which the worker's real `os.homedir` is kept (set once per worker). */
const REAL_HOMEDIR = Symbol.for('crewly.test.realHomedir');
// The module object itself: `import * as os` is a getter-only copy under
// ts-jest, so assigning on it would fail (and would not reach other files).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const osModule = require('node:os') as Record<symbol, unknown> & { homedir: () => string };
if (!osModule[REAL_HOMEDIR]) osModule[REAL_HOMEDIR] = osModule.homedir;

mkdirSync(isolatedHome, { recursive: true });
osModule.homedir = () => isolatedHome;
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.CREWLY_HOME = path.join(isolatedHome, '.crewly');

// The project store must not be inherited either. Shells Crewly starts for
// its agents export CREWLY_PROJECT_PATH (the owner's project — here, this
// very repo), and the mission store resolves CREWLY_MISSIONS_DIR → project
// path → cwd. Tests isolate themselves by pointing cwd at a temp dir, which
// the inherited project path silently overrode: when an agent ran the suite,
// fixture OKRs ("Team OKR alpha", "Pending team", "P") landed in the live
// `<repo>/.crewly/missions` and the running backend asked the owner to approve
// every one of them (24 Slack alerts, 2026-09-24). Tests that want either
// variable set it themselves.
delete process.env.CREWLY_PROJECT_PATH;
delete process.env.CREWLY_MISSIONS_DIR;

afterAll(() => {
  rmSync(isolatedHome, { recursive: true, force: true });
});
