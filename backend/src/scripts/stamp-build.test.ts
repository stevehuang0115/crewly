import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { readBuildInfo, BUILD_INFO_FILENAME } from '../utils/build-provenance.js';
import { stampBuild } from './stamp-build.js';

/**
 * Tests for the build-time stamper.
 *
 * The stamper must never break a build: an unstamped build degrades to a
 * startup warning, whereas a stamper that throws would stop people building
 * at all.
 */

let dir: string;
const logs: string[] = [];
const warns: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crewly-stamp-'));
  logs.length = 0;
  warns.length = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('stampBuild', () => {
  it('skips without throwing when HEAD cannot be resolved', () => {
    // A temp dir is not a repository. A build outside git must still succeed.
    const out = join(dir, 'out');
    let result!: boolean;
    expect(() => {
      result = stampBuild(out, dir, (m) => logs.push(m), (m) => warns.push(m));
    }).not.toThrow();
    expect(result).toBe(false);
    expect(existsSync(join(out, BUILD_INFO_FILENAME))).toBe(false);
    expect(warns.join()).toContain('unstamped');
  });

  it('writes a readable stamp when HEAD resolves, creating the output dir', () => {
    // Stamp against this repository, whose HEAD is resolvable.
    const out = join(dir, 'nested', 'out');
    const ok = stampBuild(out, process.cwd(), (m) => logs.push(m), (m) => warns.push(m));

    expect(ok).toBe(true);
    const info = readBuildInfo(out);
    expect(info?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(() => new Date(info!.builtAt).toISOString()).not.toThrow();
    expect(logs.join()).toContain('stamp-build:');
  });
});
