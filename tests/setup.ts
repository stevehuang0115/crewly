/**
 * Global Jest setup — runs before every test file (`setupFilesAfterEnv`).
 *
 * Its one job is to keep tests out of the developer's real Crewly home.
 *
 * Every file gets its own throwaway `CREWLY_HOME` under the OS temp dir, so
 * any code that resolves the home through `getCrewlyHomePath()` (StorageService
 * and friends) writes there instead of `~/.crewly`. Test files that need a
 * specific home still set `process.env.CREWLY_HOME` themselves; this is only
 * the default underneath them.
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

import { rmSync } from 'node:fs';
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

process.env.CREWLY_HOME = isolatedHome;

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
