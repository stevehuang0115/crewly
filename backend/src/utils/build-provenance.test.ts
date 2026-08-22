import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  BUILD_INFO_FILENAME,
  SKIP_BUILD_CHECK_ENV,
  assertBuildProvenance,
  evaluateBuildProvenance,
  formatVerdict,
  readBuildInfo,
  readGitHead,
  writeBuildInfo,
} from './build-provenance.js';

/**
 * Tests for the stale-build guard.
 *
 * The guard exists because five merged fixes were found not to be executing
 * on 2026-08-21 — the backend served a `dist/` built months earlier and
 * nothing said so. Its two obligations are: fail loudly when the compiled
 * output is from a different commit than HEAD, and never fire spuriously in
 * a deploy that legitimately has no repository.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crewly-provenance-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('evaluateBuildProvenance', () => {
  const builtAt = '2026-08-21T00:00:00.000Z';

  it('reports ok when the build commit matches HEAD', () => {
    const v = evaluateBuildProvenance({ commit: 'a'.repeat(40), builtAt }, 'a'.repeat(40));
    expect(v.state).toBe('ok');
  });

  it('reports stale when the build is from a different commit', () => {
    const v = evaluateBuildProvenance({ commit: 'a'.repeat(40), builtAt }, 'b'.repeat(40));
    expect(v.state).toBe('stale');
    expect(v).toMatchObject({ builtCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40) });
  });

  it('reports unstamped when there is no build info', () => {
    expect(evaluateBuildProvenance(null, 'a'.repeat(40)).state).toBe('unstamped');
  });

  it('reports unknown — never stale — when HEAD cannot be read', () => {
    // A container or tarball deploy has no .git. The guard must not fire
    // there: a false alarm gets the check disabled, which would leave us
    // with neither the check nor the attention.
    expect(evaluateBuildProvenance({ commit: 'a'.repeat(40), builtAt }, null).state).toBe('unknown');
  });

  it('prefers unstamped over unknown when both are missing', () => {
    expect(evaluateBuildProvenance(null, null).state).toBe('unstamped');
  });

  it('does not depend on timestamps at all', () => {
    // Commit identity, not mtimes: `git checkout` does not preserve mtimes,
    // so a time-based check would cry wolf after a branch switch.
    const older = { commit: 'a'.repeat(40), builtAt: '2020-01-01T00:00:00.000Z' };
    expect(evaluateBuildProvenance(older, 'a'.repeat(40)).state).toBe('ok');
  });
});

describe('formatVerdict', () => {
  it('names the running commit on the happy path', () => {
    const msg = formatVerdict({ state: 'ok', commit: 'abcdef1234', builtAt: 'T' });
    expect(msg).toContain('abcdef12');
  });

  it('names both commits and the remedy when stale', () => {
    const msg = formatVerdict({
      state: 'stale',
      builtCommit: 'a'.repeat(40),
      headCommit: 'b'.repeat(40),
      builtAt: 'T',
    });
    expect(msg).toContain('STALE BUILD');
    expect(msg).toContain('aaaaaaaa');
    expect(msg).toContain('bbbbbbbb');
    expect(msg).toContain('npm run build');
    expect(msg).toContain(SKIP_BUILD_CHECK_ENV);
  });
});

describe('readBuildInfo / writeBuildInfo', () => {
  it('round-trips a stamp', () => {
    writeBuildInfo(dir, 'c'.repeat(40), '2026-08-21T00:00:00.000Z');
    expect(readBuildInfo(dir)).toEqual({
      commit: 'c'.repeat(40),
      builtAt: '2026-08-21T00:00:00.000Z',
    });
  });

  it('finds a stamp in an ancestor directory', () => {
    // The compiled module sits several levels below the build root, so the
    // lookup walks up rather than hardcoding a fragile relative path.
    writeBuildInfo(dir, 'd'.repeat(40), 'T');
    const nested = join(dir, 'backend', 'src', 'utils');
    mkdirSync(nested, { recursive: true });
    expect(readBuildInfo(nested)?.commit).toBe('d'.repeat(40));
  });

  it('returns null rather than throwing on malformed json', () => {
    writeFileSync(join(dir, BUILD_INFO_FILENAME), '{ not json', 'utf8');
    expect(readBuildInfo(dir)).toBeNull();
  });

  it('returns null when the stamp is missing required fields', () => {
    writeFileSync(join(dir, BUILD_INFO_FILENAME), JSON.stringify({ commit: 'x' }), 'utf8');
    expect(readBuildInfo(dir)).toBeNull();
  });

  it('returns null when no stamp exists anywhere above', () => {
    expect(readBuildInfo(dir)).toBeNull();
  });
});

describe('readGitHead', () => {
  it('returns null outside a repository instead of throwing', () => {
    expect(readGitHead(dir)).toBeNull();
  });
});

describe('assertBuildProvenance', () => {
  const logs: string[] = [];
  const warns: string[] = [];
  const sinks = {
    log: (m: string) => logs.push(m),
    warn: (m: string) => warns.push(m),
  };

  beforeEach(() => {
    logs.length = 0;
    warns.length = 0;
  });

  it('THROWS on a stale build — the failure mode this guard exists for', () => {
    writeBuildInfo(dir, 'a'.repeat(40), 'T');
    expect(() =>
      assertBuildProvenance({
        moduleDir: dir,
        repoRoot: dir,
        headCommit: 'b'.repeat(40),
        env: {},
        ...sinks,
      }),
    ).toThrow(/STALE BUILD/);
  });

  it('downgrades a stale build to a warning when the skip flag is set', () => {
    writeBuildInfo(dir, 'a'.repeat(40), 'T');
    const v = assertBuildProvenance({
      moduleDir: dir,
      repoRoot: dir,
      headCommit: 'b'.repeat(40),
      env: { [SKIP_BUILD_CHECK_ENV]: '1' },
      ...sinks,
    });
    expect(v.state).toBe('stale');
    expect(warns.join()).toContain('STALE BUILD');
  });

  it('warns without throwing when the build is unstamped', () => {
    const v = assertBuildProvenance({ moduleDir: dir, repoRoot: dir, env: {}, ...sinks });
    expect(v.state).toBe('unstamped');
    expect(warns).toHaveLength(1);
  });

  it('never throws when there is no repository to compare against', () => {
    // The container / tarball case: a stamped build with no .git must report
    // `unknown` and carry on. If this ever throws, the guard would break
    // every deploy that does not ship a repository.
    writeBuildInfo(dir, 'a'.repeat(40), 'T');
    let v!: ReturnType<typeof assertBuildProvenance>;
    expect(() => {
      v = assertBuildProvenance({
        moduleDir: dir,
        repoRoot: dir,
        headCommit: null,
        env: {},
        ...sinks,
      });
    }).not.toThrow();
    expect(v.state).toBe('unknown');
    expect(warns).toHaveLength(1);
  });

  it('reports the running commit on the happy path', () => {
    writeBuildInfo(dir, 'e'.repeat(40), 'T');
    const v = assertBuildProvenance({
      moduleDir: dir,
      repoRoot: dir,
      headCommit: 'e'.repeat(40),
      env: {},
      ...sinks,
    });
    expect(v.state).toBe('ok');
    expect(logs.join()).toContain('eeeeeeee');
    expect(warns).toHaveLength(0);
  });
});
