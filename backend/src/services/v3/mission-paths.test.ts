/**
 * Tests for the shared mission path resolver.
 *
 * @module services/v3/mission-paths.test
 */

import * as path from 'path';
import {
  getMissionsDir,
  getMissionPath,
  getKeyResultsDir,
  getMissionProjectPath,
  MISSIONS_DIR_ENV,
} from './mission-paths.js';

describe('mission-paths', () => {
  const originalCwd = process.cwd;
  let savedMissionsDir: string | undefined;
  let savedProjectPath: string | undefined;

  beforeEach(() => {
    savedMissionsDir = process.env[MISSIONS_DIR_ENV];
    savedProjectPath = process.env.CREWLY_PROJECT_PATH;
    delete process.env[MISSIONS_DIR_ENV];
    delete process.env.CREWLY_PROJECT_PATH;
    process.cwd = () => '/cwd-root';
  });

  afterEach(() => {
    process.cwd = originalCwd;
    if (savedMissionsDir === undefined) delete process.env[MISSIONS_DIR_ENV];
    else process.env[MISSIONS_DIR_ENV] = savedMissionsDir;
    if (savedProjectPath === undefined) delete process.env.CREWLY_PROJECT_PATH;
    else process.env.CREWLY_PROJECT_PATH = savedProjectPath;
  });

  it('defaults to <cwd>/.crewly/missions when nothing is set', () => {
    expect(getMissionsDir()).toBe(path.join('/cwd-root', '.crewly', 'missions'));
    expect(getMissionProjectPath()).toBe('/cwd-root');
  });

  it('prefers CREWLY_PROJECT_PATH over cwd', () => {
    process.env.CREWLY_PROJECT_PATH = '/proj';
    expect(getMissionsDir()).toBe(path.join('/proj', '.crewly', 'missions'));
    expect(getMissionProjectPath()).toBe('/proj');
  });

  it('prefers CREWLY_MISSIONS_DIR over everything, including an explicit projectPath', () => {
    process.env.CREWLY_PROJECT_PATH = '/proj';
    process.env[MISSIONS_DIR_ENV] = '/tmp/isolated-missions';
    expect(getMissionsDir()).toBe('/tmp/isolated-missions');
    expect(getMissionsDir('/explicit')).toBe('/tmp/isolated-missions');
  });

  it('uses an explicit projectPath ahead of env/cwd when no store override is set', () => {
    process.env.CREWLY_PROJECT_PATH = '/proj';
    expect(getMissionsDir('/explicit')).toBe(path.join('/explicit', '.crewly', 'missions'));
  });

  it('ignores empty-string env values', () => {
    process.env.CREWLY_PROJECT_PATH = '';
    process.env[MISSIONS_DIR_ENV] = '';
    expect(getMissionsDir()).toBe(path.join('/cwd-root', '.crewly', 'missions'));
  });

  it('re-reads the environment on every call (no caching)', () => {
    expect(getMissionsDir()).toBe(path.join('/cwd-root', '.crewly', 'missions'));
    process.cwd = () => '/other';
    expect(getMissionsDir()).toBe(path.join('/other', '.crewly', 'missions'));
  });

  it('builds mission and key-result paths under the resolved dir', () => {
    expect(getMissionPath('m1')).toBe(path.join('/cwd-root', '.crewly', 'missions', 'm1.json'));
    expect(getKeyResultsDir('m1')).toBe(
      path.join('/cwd-root', '.crewly', 'missions', 'm1', 'key-results'),
    );
    expect(getKeyResultsDir('m1', '/explicit')).toBe(
      path.join('/explicit', '.crewly', 'missions', 'm1', 'key-results'),
    );
  });
});
