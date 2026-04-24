/**
 * Tests for CredentialStoreService — end-to-end CRUD + encryption round-trip.
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

import {
  CredentialStoreService,
  getCredentialStoreService,
  resetCredentialStoreService,
} from './credential-store.service.js';
import {
  CredentialNotFoundError,
  GoogleOAuthPayload,
  ApiKeyPayload,
} from '../../types/credential.types.js';
import { _resetDerivedKeyCache } from '../../utils/encryption.utils.js';

/** Helper: construct a fully-formed OAuth payload for tests. */
function makeOAuthPayload(
  overrides: Partial<GoogleOAuthPayload> = {},
): GoogleOAuthPayload {
  return {
    type: 'google-oauth',
    accessToken: 'at-default',
    refreshToken: 'rt-default',
    tokenType: 'Bearer',
    expiresAt: Date.now() + 3600_000,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    accountEmail: 'test@example.com',
    clientId: 'client-id-default',
    ...overrides,
  };
}

describe('CredentialStoreService', () => {
  let testDir: string;
  let store: CredentialStoreService;

  beforeEach(async () => {
    _resetDerivedKeyCache();
    testDir = path.join(
      os.tmpdir(),
      `crewly-cred-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    store = new CredentialStoreService({ dir: testDir });
    await store.init();
    resetCredentialStoreService();
  });

  afterEach(async () => {
    resetCredentialStoreService();
    _resetDerivedKeyCache();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------
  //  Initialization
  // ---------------------------------------------------------------

  describe('init', () => {
    it('creates the credentials directory', async () => {
      const stat = await fs.stat(testDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('creates a master.key with 0600 permissions on POSIX', async () => {
      const stat = await fs.stat(path.join(testDir, 'master.key'));
      if (process.platform !== 'win32') {
        expect(stat.mode & 0o777).toBe(0o600);
      }
    });

    it('is idempotent', async () => {
      const originalKey = await fs.readFile(path.join(testDir, 'master.key'));
      await store.init();
      await store.init();
      const afterKey = await fs.readFile(path.join(testDir, 'master.key'));
      expect(afterKey.equals(originalKey)).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  //  List / get
  // ---------------------------------------------------------------

  describe('listCredentials on empty store', () => {
    it('returns an empty array', async () => {
      const list = await store.listCredentials();
      expect(list).toEqual([]);
    });
  });

  describe('getCredential on unknown id', () => {
    it('throws CredentialNotFoundError', async () => {
      await expect(store.getCredential('cred-nope')).rejects.toThrow(
        CredentialNotFoundError,
      );
    });
  });

  // ---------------------------------------------------------------
  //  API-key CRUD
  // ---------------------------------------------------------------

  describe('addApiKey', () => {
    it('creates a credential and persists metadata + payload', async () => {
      const entry = await store.addApiKey({
        name: 'gemini-main',
        provider: 'gemini',
        value: 'k-abc-123',
      });

      expect(entry.id).toMatch(/^cred-/);
      expect(entry.type).toBe('api-key');
      expect(entry.provider).toBe('gemini');
      expect(entry.name).toBe('gemini-main');
      expect(entry.status).toBe('active');
      expect(entry.encFile).toBe(`${entry.id}.enc`);

      // Metadata visible via listCredentials
      const list = await store.listCredentials();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(entry.id);

      // Payload decrypts round-trip
      const payload = (await store.getPayload(entry.id)) as ApiKeyPayload;
      expect(payload.type).toBe('api-key');
      expect(payload.value).toBe('k-abc-123');
    });

    it('does not include raw value in registry metadata', async () => {
      const entry = await store.addApiKey({
        name: 'k1',
        provider: 'gemini',
        value: 'secret-value',
      });
      const list = await store.listCredentials();
      // Metadata should never contain the raw secret
      expect(JSON.stringify(list)).not.toContain('secret-value');
      // The .enc file should be opaque bytes (not plaintext)
      const encContents = await fs.readFile(
        path.join(testDir, entry.encFile),
        'utf8',
      );
      expect(encContents).not.toContain('secret-value');
    });
  });

  // ---------------------------------------------------------------
  //  OAuth CRUD
  // ---------------------------------------------------------------

  describe('addOAuth', () => {
    it('creates a credential, records helper and scopes, persists payload', async () => {
      const payload = makeOAuthPayload({
        accessToken: 'at-oauth-123',
        refreshToken: 'rt-oauth-456',
        scopes: [
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/calendar.readonly',
        ],
        accountEmail: 'info@steam-fun.com',
      });

      const entry = await store.addOAuth({
        name: 'info-steam-fun',
        provider: 'google',
        helper: 'gemini-cli-workspace',
        payload,
      });

      expect(entry.type).toBe('google-oauth');
      expect(entry.helper).toBe('gemini-cli-workspace');
      expect(entry.accountEmail).toBe('info@steam-fun.com');
      expect(entry.scopes).toHaveLength(2);
      expect(entry.expiresAt).toBe(payload.expiresAt);

      // Payload round-trips
      const got = (await store.getPayload(entry.id)) as GoogleOAuthPayload;
      expect(got.type).toBe('google-oauth');
      expect(got.accessToken).toBe('at-oauth-123');
      expect(got.refreshToken).toBe('rt-oauth-456');
    });

    it('supports multiple independent accounts at once', async () => {
      const a = await store.addOAuth({
        name: 'info',
        provider: 'google',
        helper: 'gemini-cli-workspace',
        payload: makeOAuthPayload({
          accessToken: 'at-A',
          refreshToken: 'rt-A',
          accountEmail: 'a@example.com',
        }),
      });
      const b = await store.addOAuth({
        name: 'personal',
        provider: 'google',
        helper: 'gemini-cli-workspace',
        payload: makeOAuthPayload({
          accessToken: 'at-B',
          refreshToken: 'rt-B',
          accountEmail: 'b@example.com',
        }),
      });

      expect(a.id).not.toBe(b.id);

      const list = await store.listCredentials();
      expect(list).toHaveLength(2);

      const pa = (await store.getPayload(a.id)) as GoogleOAuthPayload;
      const pb = (await store.getPayload(b.id)) as GoogleOAuthPayload;
      expect(pa.refreshToken).toBe('rt-A');
      expect(pb.refreshToken).toBe('rt-B');
    });
  });

  // ---------------------------------------------------------------
  //  Update
  // ---------------------------------------------------------------

  describe('updateCredential', () => {
    it('updates name and bumps updatedAt', async () => {
      const entry = await store.addApiKey({
        name: 'original',
        provider: 'gemini',
        value: 'v',
      });
      const originalUpdated = entry.updatedAt;
      // Nudge clock to guarantee timestamp change
      await new Promise((r) => setTimeout(r, 10));

      const patched = await store.updateCredential(entry.id, {
        name: 'renamed',
      });
      expect(patched.name).toBe('renamed');
      expect(patched.updatedAt).not.toBe(originalUpdated);
      expect(patched.id).toBe(entry.id);
    });

    it('marks a credential as revoked', async () => {
      const entry = await store.addOAuth({
        name: 'x',
        provider: 'google',
        helper: 'gemini-cli-workspace',
        payload: makeOAuthPayload(),
      });
      const patched = await store.updateCredential(entry.id, {
        status: 'revoked',
      });
      expect(patched.status).toBe('revoked');
    });

    it('throws on unknown id', async () => {
      await expect(
        store.updateCredential('cred-nope', { name: 'x' }),
      ).rejects.toThrow(CredentialNotFoundError);
    });
  });

  // ---------------------------------------------------------------
  //  Delete
  // ---------------------------------------------------------------

  describe('deleteCredential', () => {
    it('removes registry entry and encrypted file', async () => {
      const entry = await store.addApiKey({
        name: 'gone',
        provider: 'gemini',
        value: 'v',
      });
      const encPath = path.join(testDir, entry.encFile);
      await fs.access(encPath); // exists

      await store.deleteCredential(entry.id);

      await expect(store.getCredential(entry.id)).rejects.toThrow(
        CredentialNotFoundError,
      );
      await expect(fs.access(encPath)).rejects.toThrow();
    });

    it('tolerates a missing .enc file (registry authoritative)', async () => {
      const entry = await store.addApiKey({
        name: 'orphan',
        provider: 'gemini',
        value: 'v',
      });
      // Manually delete the .enc so only the registry remains
      await fs.unlink(path.join(testDir, entry.encFile));

      await expect(store.deleteCredential(entry.id)).resolves.toBeUndefined();
      await expect(store.getCredential(entry.id)).rejects.toThrow(
        CredentialNotFoundError,
      );
    });

    it('throws on unknown id', async () => {
      await expect(store.deleteCredential('cred-nope')).rejects.toThrow(
        CredentialNotFoundError,
      );
    });
  });

  // ---------------------------------------------------------------
  //  Payload refresh (setPayload)
  // ---------------------------------------------------------------

  describe('setPayload', () => {
    it('rewrites encrypted payload in place', async () => {
      const entry = await store.addOAuth({
        name: 'rot',
        provider: 'google',
        helper: 'gemini-cli-workspace',
        payload: makeOAuthPayload({ accessToken: 'at-old' }),
      });

      await store.setPayload(entry.id, {
        ...makeOAuthPayload({ accessToken: 'at-new' }),
      });

      const p = (await store.getPayload(entry.id)) as GoogleOAuthPayload;
      expect(p.accessToken).toBe('at-new');
    });

    it('throws on unknown id', async () => {
      await expect(
        store.setPayload('cred-nope', {
          type: 'api-key',
          value: 'x',
        }),
      ).rejects.toThrow(CredentialNotFoundError);
    });
  });

  // ---------------------------------------------------------------
  //  findCredentialsByProvider
  // ---------------------------------------------------------------

  describe('findCredentialsByProvider', () => {
    it('filters by provider and optionally by type', async () => {
      await store.addApiKey({
        name: 'gem-k',
        provider: 'gemini',
        value: 'v',
      });
      await store.addOAuth({
        name: 'google-a',
        provider: 'google',
        helper: 'gemini-cli-workspace',
        payload: makeOAuthPayload(),
      });
      await store.addOAuth({
        name: 'google-b',
        provider: 'google',
        helper: 'gemini-cli-workspace',
        payload: makeOAuthPayload(),
      });

      const geminiOnly = await store.findCredentialsByProvider('gemini');
      expect(geminiOnly).toHaveLength(1);

      const googleOnly = await store.findCredentialsByProvider('google');
      expect(googleOnly).toHaveLength(2);

      const googleOAuthOnly = await store.findCredentialsByProvider(
        'google',
        'google-oauth',
      );
      expect(googleOAuthOnly).toHaveLength(2);

      const googleApiKey = await store.findCredentialsByProvider(
        'google',
        'api-key',
      );
      expect(googleApiKey).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------
  //  Persistence across instances (simulating process restart)
  // ---------------------------------------------------------------

  describe('persistence across instances', () => {
    it('a new instance sees credentials added by the previous instance', async () => {
      const entry = await store.addOAuth({
        name: 'persistent',
        provider: 'google',
        helper: 'gemini-cli-workspace',
        payload: makeOAuthPayload({ refreshToken: 'rt-persist' }),
      });

      // Simulate process restart with a fresh service instance against the same dir
      const store2 = new CredentialStoreService({ dir: testDir });
      const found = await store2.getCredential(entry.id);
      expect(found.name).toBe('persistent');

      const payload = (await store2.getPayload(entry.id)) as GoogleOAuthPayload;
      expect(payload.refreshToken).toBe('rt-persist');
    });
  });

  // ---------------------------------------------------------------
  //  Singleton
  // ---------------------------------------------------------------

  describe('getCredentialStoreService singleton', () => {
    it('returns the same instance across calls', () => {
      const a = getCredentialStoreService();
      const b = getCredentialStoreService();
      expect(a).toBe(b);
    });

    it('resetCredentialStoreService clears the singleton', () => {
      const a = getCredentialStoreService();
      resetCredentialStoreService();
      const b = getCredentialStoreService();
      expect(a).not.toBe(b);
    });
  });
});
