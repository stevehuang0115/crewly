/**
 * Guard for the global Jest setup (`tests/setup.ts`).
 *
 * Issue #729: the setup file was one line of literal `\n` escapes, i.e. a
 * single comment, so the suite never actually isolated `CREWLY_HOME` and a
 * verification run wrote stub teams into the developer's real `~/.crewly`.
 * These assertions fail the moment that isolation stops taking effect.
 *
 * @module tests/setup.test
 */

import * as os from 'node:os';
import * as path from 'node:path';

import { getCrewlyHomePath } from '../backend/src/services/core/crewly-home.utils.js';
import { TEST_CREWLY_HOME_PREFIX } from './setup.js';

describe('global test setup — CREWLY_HOME isolation (#729)', () => {
  it('points CREWLY_HOME at a per-file directory under the OS temp dir', () => {
    const home = process.env.CREWLY_HOME;

    expect(home).toBeDefined();
    expect(path.dirname(home as string)).toBe(os.tmpdir());
    expect(path.basename(home as string).startsWith(TEST_CREWLY_HOME_PREFIX)).toBe(true);
  });

  it('never resolves the Crewly home to the real ~/.crewly', () => {
    const realHome = path.join(os.homedir(), '.crewly');

    expect(getCrewlyHomePath()).not.toBe(realHome);
    expect(getCrewlyHomePath().startsWith(`${realHome}${path.sep}`)).toBe(false);
  });
});

describe('global test setup — project store isolation (2026-09-24 OKR leak)', () => {
  it('does not inherit CREWLY_PROJECT_PATH / CREWLY_MISSIONS_DIR from the shell', () => {
    expect(process.env.CREWLY_PROJECT_PATH).toBeUndefined();
    expect(process.env.CREWLY_MISSIONS_DIR).toBeUndefined();
  });
});
