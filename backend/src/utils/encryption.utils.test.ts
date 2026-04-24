/**
 * Tests for encryption.utils — AES-256-GCM round-trip + tamper detection.
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  encrypt,
  decrypt,
  ensureMasterKey,
  defaultCredentialsDir,
  defaultMasterKeyPath,
  _resetDerivedKeyCache,
} from './encryption.utils.js';

describe('encryption.utils', () => {
  let testDir: string;
  let masterKeyPath: string;

  beforeEach(async () => {
    _resetDerivedKeyCache();
    testDir = path.join(
      os.tmpdir(),
      `crewly-enc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    masterKeyPath = path.join(testDir, 'master.key');
    await ensureMasterKey(masterKeyPath);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
    _resetDerivedKeyCache();
  });

  describe('ensureMasterKey', () => {
    it('creates a 32-byte random file when absent', async () => {
      const contents = await fs.readFile(masterKeyPath);
      expect(contents).toHaveLength(32);
    });

    it('does not overwrite an existing master.key on second call', async () => {
      const original = await fs.readFile(masterKeyPath);
      await ensureMasterKey(masterKeyPath);
      const after = await fs.readFile(masterKeyPath);
      expect(after.equals(original)).toBe(true);
    });

    it('creates the parent directory if missing', async () => {
      const nestedDir = path.join(testDir, 'nested', 'deeper');
      const nestedKey = path.join(nestedDir, 'master.key');
      await ensureMasterKey(nestedKey);
      const stat = await fs.stat(nestedKey);
      expect(stat.isFile()).toBe(true);
    });

    it('writes file with 0600 permissions on POSIX', async () => {
      if (process.platform === 'win32') return;
      const stat = await fs.stat(masterKeyPath);
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  describe('encrypt / decrypt round-trip', () => {
    it('round-trips a short ASCII string', async () => {
      const enc = await encrypt('hello world', masterKeyPath);
      const dec = await decrypt(enc, masterKeyPath);
      expect(dec).toBe('hello world');
    });

    it('produces different ciphertexts for the same plaintext (fresh IV per call)', async () => {
      const a = await encrypt('same input', masterKeyPath);
      const b = await encrypt('same input', masterKeyPath);
      expect(a.equals(b)).toBe(false);
    });

    it('round-trips unicode correctly', async () => {
      const text = '你好世界 🌍 — тест — café';
      const enc = await encrypt(text, masterKeyPath);
      const dec = await decrypt(enc, masterKeyPath);
      expect(dec).toBe(text);
    });

    it('round-trips a JSON-serialized OAuth-like payload', async () => {
      const payload = JSON.stringify({
        type: 'google-oauth',
        accessToken: 'at-' + 'x'.repeat(200),
        refreshToken: 'rt-' + 'y'.repeat(100),
        scopes: [
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/calendar.events',
        ],
        expiresAt: 1735689600000,
      });
      const enc = await encrypt(payload, masterKeyPath);
      const dec = await decrypt(enc, masterKeyPath);
      expect(JSON.parse(dec)).toEqual(JSON.parse(payload));
    });

    it('produces a buffer that begins with the format version byte', async () => {
      const enc = await encrypt('x', masterKeyPath);
      expect(enc[0]).toBe(1);
    });
  });

  describe('tamper detection', () => {
    it('rejects a ciphertext with a flipped bit in the body', async () => {
      const enc = await encrypt('secret', masterKeyPath);
      const tampered = Buffer.from(enc);
      tampered[tampered.length - 1] ^= 0x01;
      await expect(decrypt(tampered, masterKeyPath)).rejects.toThrow();
    });

    it('rejects a ciphertext with a flipped bit in the auth tag', async () => {
      const enc = await encrypt('secret', masterKeyPath);
      const tampered = Buffer.from(enc);
      // Auth tag is at offset 1 + IV_LENGTH (13..29)
      tampered[14] ^= 0x01;
      await expect(decrypt(tampered, masterKeyPath)).rejects.toThrow();
    });

    it('rejects a buffer that is too short', async () => {
      const short = Buffer.from([1, 2, 3]);
      await expect(decrypt(short, masterKeyPath)).rejects.toThrow(/too short/);
    });

    it('rejects an unsupported version byte', async () => {
      const enc = await encrypt('x', masterKeyPath);
      enc[0] = 99;
      await expect(decrypt(enc, masterKeyPath)).rejects.toThrow(/version/);
    });

    it('rejects a ciphertext encrypted with a different master key', async () => {
      const enc = await encrypt('x', masterKeyPath);

      const otherDir = path.join(
        os.tmpdir(),
        `crewly-enc-test-other-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const otherKeyPath = path.join(otherDir, 'master.key');
      await ensureMasterKey(otherKeyPath);

      try {
        await expect(decrypt(enc, otherKeyPath)).rejects.toThrow();
      } finally {
        await fs.rm(otherDir, { recursive: true, force: true });
      }
    });
  });

  describe('default paths', () => {
    it('default credentials dir is under ~/.crewly', () => {
      expect(defaultCredentialsDir()).toContain('.crewly');
      expect(defaultCredentialsDir()).toContain('credentials');
    });

    it('default master.key path is inside credentials dir', () => {
      expect(defaultMasterKeyPath()).toBe(
        path.join(defaultCredentialsDir(), 'master.key'),
      );
    });
  });
});
