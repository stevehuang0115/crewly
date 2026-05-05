/**
 * Tests for {@link getCrewlyHomePath}.
 *
 * Covers the three precedence cases the helper must honour:
 *   1. `CREWLY_HOME` set to a real path → returned as-is.
 *   2. `CREWLY_HOME` unset → falls back to `~/.crewly`.
 *   3. `CREWLY_HOME` set to empty string → treated as unset (default).
 *
 * The third case matters for shells that export blank values when
 * users `unset CREWLY_HOME` then re-source their shellrc — we must
 * not write to a literal empty path.
 */

import * as os from 'os';
import * as path from 'path';
import { getCrewlyHomePath } from './crewly-home.utils.js';

describe('getCrewlyHomePath', () => {
  const ORIGINAL_ENV = process.env.CREWLY_HOME;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.CREWLY_HOME;
    } else {
      process.env.CREWLY_HOME = ORIGINAL_ENV;
    }
  });

  it('returns CREWLY_HOME verbatim when set to a non-empty value', () => {
    process.env.CREWLY_HOME = '/tmp/crewly-test-profile-abc123';
    expect(getCrewlyHomePath()).toBe('/tmp/crewly-test-profile-abc123');
  });

  it('falls back to ~/.crewly when CREWLY_HOME is unset', () => {
    delete process.env.CREWLY_HOME;
    expect(getCrewlyHomePath()).toBe(path.join(os.homedir(), '.crewly'));
  });

  it('treats empty-string CREWLY_HOME as unset and returns default', () => {
    process.env.CREWLY_HOME = '';
    expect(getCrewlyHomePath()).toBe(path.join(os.homedir(), '.crewly'));
  });
});
