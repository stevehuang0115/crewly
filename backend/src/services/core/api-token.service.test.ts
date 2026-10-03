/**
 * Tests for the API token service.
 *
 * Covers env precedence, first-boot generation + 0600 persistence, reuse of
 * the persisted file, constant-time verification and fingerprinting.
 *
 * @module services/core/api-token.service.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  resolveApiToken,
  getApiToken,
  getApiTokenFilePath,
  getApiTokenFingerprint,
  generateApiToken,
  verifyApiToken,
  resetApiTokenCache,
  mirrorEnvTokenToFile,
  readExistingApiToken,
} from './api-token.service.js';

describe('api-token.service', () => {
  const originalEnv = { ...process.env };
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-api-token-'));
    process.env.CREWLY_HOME = tmpHome;
    delete process.env.CREWLY_API_TOKEN;
    resetApiTokenCache();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetApiTokenCache();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('prefers CREWLY_API_TOKEN over the file and does not write a file', () => {
    process.env.CREWLY_API_TOKEN = '  pinned-token  ';
    const resolved = resolveApiToken();
    expect(resolved.token).toBe('pinned-token');
    expect(resolved.source).toBe('env');
    expect(fs.existsSync(getApiTokenFilePath())).toBe(false);
  });

  it('generates a 64-hex token on first boot and persists it 0600', () => {
    const resolved = resolveApiToken();
    expect(resolved.source).toBe('generated');
    expect(resolved.token).toMatch(/^[0-9a-f]{64}$/);
    expect(resolved.filePath).toBe(path.join(tmpHome, 'api-token'));

    const onDisk = fs.readFileSync(resolved.filePath, 'utf8').trim();
    expect(onDisk).toBe(resolved.token);
    if (process.platform !== 'win32') {
      expect(fs.statSync(resolved.filePath).mode & 0o777).toBe(0o600);
    }
  });

  it('reuses the persisted token on subsequent boots', () => {
    fs.writeFileSync(path.join(tmpHome, 'api-token'), 'from-disk\n');
    const resolved = resolveApiToken();
    expect(resolved.token).toBe('from-disk');
    expect(resolved.source).toBe('file');
  });

  it('caches the token until reset', () => {
    const first = getApiToken();
    process.env.CREWLY_API_TOKEN = 'changed-later';
    expect(getApiToken()).toBe(first);
    resetApiTokenCache();
    expect(getApiToken()).toBe('changed-later');
  });

  it('verifies only the exact token', () => {
    process.env.CREWLY_API_TOKEN = 'secret-value';
    expect(verifyApiToken('secret-value')).toBe(true);
    expect(verifyApiToken('secret-valuE')).toBe(false);
    expect(verifyApiToken('secret-value-longer')).toBe(false);
    expect(verifyApiToken('')).toBe(false);
    expect(verifyApiToken(null)).toBe(false);
    expect(verifyApiToken(undefined)).toBe(false);
  });

  it('fingerprints as the first 8 hex chars of sha256', () => {
    process.env.CREWLY_API_TOKEN = 'secret-value';
    const expected = createHash('sha256').update('secret-value').digest('hex').slice(0, 8);
    expect(getApiTokenFingerprint()).toBe(expected);
    expect(getApiTokenFingerprint('other')).toHaveLength(8);
    expect(getApiTokenFingerprint('other')).not.toBe(expected);
  });

  describe('mirrorEnvTokenToFile (#1010 review: the CLI on a systemd box)', () => {
    it('writes the env token to a missing token file, mode 0600, so the CLI can read it', () => {
      process.env.CREWLY_API_TOKEN = 'pinned-in-systemd';
      expect(mirrorEnvTokenToFile()).toBe('written');
      const file = getApiTokenFilePath();
      expect(fs.readFileSync(file, 'utf8').trim()).toBe('pinned-in-systemd');
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      // The CLI from a shell without the env var now finds it.
      delete process.env.CREWLY_API_TOKEN;
      expect(readExistingApiToken()).toBe('pinned-in-systemd');
    });

    it('leaves a matching file alone and rewrites a stale one (the server only accepts the env token)', () => {
      process.env.CREWLY_API_TOKEN = 'pinned';
      mirrorEnvTokenToFile();
      expect(mirrorEnvTokenToFile()).toBe('unchanged');
      fs.writeFileSync(getApiTokenFilePath(), 'old-token\n');
      expect(mirrorEnvTokenToFile()).toBe('updated');
      expect(fs.readFileSync(getApiTokenFilePath(), 'utf8').trim()).toBe('pinned');
    });

    it('does nothing when the token does not come from the environment', () => {
      expect(mirrorEnvTokenToFile()).toBe('not-env');
      expect(fs.existsSync(getApiTokenFilePath())).toBe(false);
    });
  });

  it('generateApiToken produces distinct values', () => {
    expect(generateApiToken()).not.toBe(generateApiToken());
  });
});
