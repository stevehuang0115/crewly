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
import * as fs from 'fs';
import {
  getCrewlyHomeId,
  getCrewlyHomePath,
  isInsidePackageTree,
  resolveProjectDataDir,
  migrateLegacyProjectData,
} from './crewly-home.utils.js';

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

describe('isInsidePackageTree', () => {
  it('detects a node_modules segment anywhere in the path', () => {
    expect(isInsidePackageTree('/usr/lib/node_modules/crewly')).toBe(true);
    expect(isInsidePackageTree('/home/me/proj/node_modules/x/dist')).toBe(true);
    expect(isInsidePackageTree('C:\\Users\\me\\AppData\\npm\\node_modules\\crewly')).toBe(true);
  });
  it('does not match a project that merely mentions node_modules in a file name', () => {
    expect(isInsidePackageTree('/home/me/proj')).toBe(false);
    expect(isInsidePackageTree('/home/me/node_modules_backup')).toBe(false);
  });
});

describe('resolveProjectDataDir', () => {
  const ORIGINAL = process.env.CREWLY_HOME;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CREWLY_HOME;
    else process.env.CREWLY_HOME = ORIGINAL;
  });
  it('returns <project>/.crewly for a real project', () => {
    expect(resolveProjectDataDir('/repo')).toBe(path.join('/repo', '.crewly'));
  });
  it('returns the Crewly home when the project path is the npm package tree', () => {
    process.env.CREWLY_HOME = '/tmp/crewly-home-x';
    expect(resolveProjectDataDir('/usr/lib/node_modules/crewly')).toBe('/tmp/crewly-home-x');
  });
});

describe('migrateLegacyProjectData', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-migrate-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function seedLegacy(): string {
    const legacy = path.join(tmp, 'pkg', '.crewly');
    fs.mkdirSync(path.join(legacy, 'missions'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'missions', 'm1.json'), '{}');
    fs.mkdirSync(path.join(legacy, 'triggers'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'triggers', 'triggers.json'), '[]');
    fs.mkdirSync(path.join(legacy, 'requests'), { recursive: true }); // empty → skipped
    fs.writeFileSync(path.join(legacy, 'agents-index.json'), '{"agents":[]}');
    fs.writeFileSync(path.join(legacy, 'unrelated.txt'), 'x'); // not a known store
    return legacy;
  }

  it('copies every known non-empty store once and leaves the source in place', () => {
    const legacy = seedLegacy();
    const safe = path.join(tmp, 'home');
    expect(migrateLegacyProjectData(legacy, safe).sort()).toEqual(['agents-index.json', 'missions', 'triggers']);
    expect(fs.existsSync(path.join(safe, 'missions', 'm1.json'))).toBe(true);
    expect(fs.existsSync(path.join(safe, 'agents-index.json'))).toBe(true);
    expect(fs.existsSync(path.join(safe, 'unrelated.txt'))).toBe(false);
    expect(fs.existsSync(path.join(legacy, 'missions', 'm1.json'))).toBe(true);
    // Second run: everything already populated → nothing copied.
    expect(migrateLegacyProjectData(legacy, safe)).toEqual([]);
  });

  it('never overwrites a populated safe store', () => {
    const legacy = seedLegacy();
    const safe = path.join(tmp, 'home');
    fs.mkdirSync(path.join(safe, 'missions'), { recursive: true });
    fs.writeFileSync(path.join(safe, 'missions', 'live.json'), '{}');
    const copied = migrateLegacyProjectData(legacy, safe);
    expect(copied).not.toContain('missions');
    expect(fs.existsSync(path.join(safe, 'missions', 'm1.json'))).toBe(false);
  });

  it('is a no-op when legacy and safe are the same directory or legacy is missing', () => {
    const legacy = seedLegacy();
    expect(migrateLegacyProjectData(legacy, legacy)).toEqual([]);
    expect(migrateLegacyProjectData(path.join(tmp, 'nope'), path.join(tmp, 'home'))).toEqual([]);
  });
});

describe('getCrewlyHomeId', () => {
  it('is a short stable hex id of the absolute home path', () => {
    const id = getCrewlyHomeId('/home/alice/.crewly');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(getCrewlyHomeId('/home/alice/.crewly')).toBe(id);
    expect(getCrewlyHomeId('/home/alice/.crewly/')).toBe(id);
  });

  it('differs between homes (another Unix user, another CREWLY_HOME)', () => {
    expect(getCrewlyHomeId('/home/alice/.crewly')).not.toBe(getCrewlyHomeId('/root/.crewly'));
  });
});
