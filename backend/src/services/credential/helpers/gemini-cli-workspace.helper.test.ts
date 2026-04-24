/**
 * Tests for GeminiCliWorkspaceHelper — capture + refresh + mutex + cooldown.
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

import {
  GeminiCliWorkspaceHelper,
  encryptExtensionFormatForTesting,
  deriveExtensionKeyForTesting,
  FetchLike,
} from './gemini-cli-workspace.helper.js';
import {
  CredentialStoreService,
  resetCredentialStoreService,
} from '../credential-store.service.js';
import {
  CredentialRegistryEntry,
  CredentialRevokedError,
  GoogleOAuthPayload,
} from '../../../types/credential.types.js';
import { _resetDerivedKeyCache } from '../../../utils/encryption.utils.js';

// ============================================================================
// Test utilities
// ============================================================================

function makePayload(overrides: Partial<GoogleOAuthPayload> = {}): GoogleOAuthPayload {
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

function makeEntry(overrides: Partial<CredentialRegistryEntry> = {}): CredentialRegistryEntry {
  const now = new Date().toISOString();
  return {
    id: 'cred-test-1',
    name: 'test-cred',
    type: 'google-oauth',
    provider: 'google',
    helper: 'gemini-cli-workspace',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    accountEmail: 'test@example.com',
    expiresAt: Date.now() + 3600_000,
    createdAt: now,
    updatedAt: now,
    status: 'active',
    encFile: 'cred-test-1.enc',
    ...overrides,
  };
}

/** Write a fake extension-format token file at the given directory. */
async function writeFakeExtensionTokenFile(
  extensionDir: string,
  payload: { accessToken: string; refreshToken: string; scope?: string; expiresAt?: number },
): Promise<void> {
  await fs.mkdir(extensionDir, { recursive: true });
  const masterKey = crypto.randomBytes(32);
  await fs.writeFile(
    path.join(extensionDir, '.gemini-cli-workspace-master-key'),
    masterKey,
    { mode: 0o600 },
  );
  const encKey = deriveExtensionKeyForTesting(masterKey);
  const body = {
    'main-account': {
      serverName: 'main-account',
      token: {
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
        tokenType: 'Bearer',
        scope: payload.scope ?? 'https://www.googleapis.com/auth/gmail.readonly',
        expiresAt: payload.expiresAt ?? Date.now() + 3600_000,
      },
      updatedAt: Date.now(),
    },
  };
  const encrypted = encryptExtensionFormatForTesting(JSON.stringify(body), encKey);
  await fs.writeFile(
    path.join(extensionDir, 'gemini-cli-workspace-token.json'),
    encrypted,
    { mode: 0o600 },
  );
}

/** Build a mock fetch that records calls and returns pre-scripted responses. */
function mockFetch(
  responder: (url: string, init?: Parameters<FetchLike>[1]) => {
    ok?: boolean;
    status?: number;
    body?: unknown;
  },
): FetchLike & { calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> } {
  const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = responder(url, init);
    const status = r.status ?? (r.ok ?? true ? 200 : 500);
    const ok = r.ok ?? (status >= 200 && status < 300);
    const bodyStr = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    return {
      ok,
      status,
      text: async () => bodyStr,
      json: async () => JSON.parse(bodyStr),
    };
  };
  (fn as typeof fn & { calls: typeof calls }).calls = calls;
  return fn as FetchLike & { calls: typeof calls };
}

// ============================================================================
// Tests
// ============================================================================

describe('GeminiCliWorkspaceHelper', () => {
  let testDir: string;
  let extensionDir: string;
  let storeDir: string;
  let store: CredentialStoreService;

  beforeEach(async () => {
    _resetDerivedKeyCache();
    testDir = path.join(
      os.tmpdir(),
      `crewly-gemini-helper-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    extensionDir = path.join(testDir, 'ext');
    storeDir = path.join(testDir, 'store');
    store = new CredentialStoreService({ dir: storeDir });
    await store.init();
    resetCredentialStoreService();
  });

  afterEach(async () => {
    resetCredentialStoreService();
    _resetDerivedKeyCache();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------
  //  captureFromFile
  // ------------------------------------------------------------------

  describe('captureFromFile', () => {
    it('reads and decrypts the extension token file', async () => {
      await writeFakeExtensionTokenFile(extensionDir, {
        accessToken: 'at-captured',
        refreshToken: 'rt-captured',
        scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly',
      });

      // Mock userinfo fetch
      const fetch = mockFetch(() => ({
        body: { email: 'captured@example.com' },
      }));

      const helper = new GeminiCliWorkspaceHelper(store, {
        extensionPath: extensionDir,
        fetch,
      });

      const payload = await helper.captureFromFile();

      expect(payload.type).toBe('google-oauth');
      expect(payload.accessToken).toBe('at-captured');
      expect(payload.refreshToken).toBe('rt-captured');
      expect(payload.scopes).toEqual([
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/calendar.readonly',
      ]);
      expect(payload.accountEmail).toBe('captured@example.com');
      expect(payload.clientId).toBeTruthy();
    });

    it('throws a user-friendly error when token file is missing', async () => {
      const helper = new GeminiCliWorkspaceHelper(store, {
        extensionPath: extensionDir,
      });

      await expect(helper.captureFromFile()).rejects.toThrow(
        /token file not found/i,
      );
    });

    it('still returns payload when userinfo fetch fails (email optional)', async () => {
      await writeFakeExtensionTokenFile(extensionDir, {
        accessToken: 'at-1',
        refreshToken: 'rt-1',
      });

      const fetch = mockFetch(() => ({ ok: false, status: 401, body: 'unauthorized' }));

      const helper = new GeminiCliWorkspaceHelper(store, {
        extensionPath: extensionDir,
        fetch,
      });

      const payload = await helper.captureFromFile();
      expect(payload.accessToken).toBe('at-1');
      expect(payload.accountEmail).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------
  //  clearExtensionFile
  // ------------------------------------------------------------------

  describe('clearExtensionFile', () => {
    it('deletes the extension token file', async () => {
      await writeFakeExtensionTokenFile(extensionDir, {
        accessToken: 'at',
        refreshToken: 'rt',
      });
      const tokenPath = path.join(extensionDir, 'gemini-cli-workspace-token.json');
      await fs.access(tokenPath); // confirm exists

      const helper = new GeminiCliWorkspaceHelper(store, { extensionPath: extensionDir });
      await helper.clearExtensionFile();

      await expect(fs.access(tokenPath)).rejects.toThrow();
    });

    it('is a no-op if the file does not exist', async () => {
      const helper = new GeminiCliWorkspaceHelper(store, { extensionPath: extensionDir });
      await expect(helper.clearExtensionFile()).resolves.toBeUndefined();
    });
  });

  // ------------------------------------------------------------------
  //  getAccessToken
  // ------------------------------------------------------------------

  describe('getAccessToken — fast path', () => {
    it('returns unchanged payload when not near expiry', async () => {
      const fetch = mockFetch(() => ({ body: {} }));
      const helper = new GeminiCliWorkspaceHelper(store, {
        extensionPath: extensionDir,
        fetch,
      });

      const entry = makeEntry();
      const payload = makePayload({ expiresAt: Date.now() + 3600_000 });

      const result = await helper.getAccessToken(entry, payload);

      expect(result).toBe(payload);
      expect((fetch as unknown as { calls: unknown[] }).calls).toHaveLength(0);
    });
  });

  describe('getAccessToken — refresh', () => {
    it('refreshes via cloud function when near expiry and persists new payload', async () => {
      // Add a real credential so setPayload + updateCredential can persist
      const added = await store.addOAuth({
        name: 'refresh-test',
        provider: 'google',
        helper: 'gemini-cli-workspace',
        payload: makePayload({
          accessToken: 'at-old',
          refreshToken: 'rt-stable',
          expiresAt: Date.now() + 1000, // nearly expired
        }),
      });

      const fetch = mockFetch((url) => {
        expect(url).toContain('/refreshToken');
        return {
          body: {
            access_token: 'at-new',
            expires_in: 3600,
            token_type: 'Bearer',
          },
        };
      });

      const helper = new GeminiCliWorkspaceHelper(store, {
        extensionPath: extensionDir,
        fetch,
      });

      const stored = await store.getPayload(added.id);
      const result = await helper.getAccessToken(added, stored as GoogleOAuthPayload);

      expect(result.accessToken).toBe('at-new');
      expect(result.refreshToken).toBe('rt-stable'); // unchanged

      // Persisted
      const persisted = (await store.getPayload(added.id)) as GoogleOAuthPayload;
      expect(persisted.accessToken).toBe('at-new');
      const meta = await store.getCredential(added.id);
      expect(meta.lastUsedAt).toBeDefined();
    });

    it('throws CredentialRevokedError on invalid_grant and marks credential revoked', async () => {
      const added = await store.addOAuth({
        name: 'revoked-test',
        provider: 'google',
        helper: 'gemini-cli-workspace',
        payload: makePayload({
          refreshToken: 'rt-dead',
          expiresAt: Date.now() + 500,
        }),
      });

      const fetch = mockFetch(() => ({
        ok: false,
        status: 400,
        body: { error: 'invalid_grant', error_description: 'Token revoked' },
      }));

      const helper = new GeminiCliWorkspaceHelper(store, {
        extensionPath: extensionDir,
        fetch,
      });

      const payload = (await store.getPayload(added.id)) as GoogleOAuthPayload;

      await expect(
        helper.getAccessToken(added, payload),
      ).rejects.toThrow(CredentialRevokedError);

      const meta = await store.getCredential(added.id);
      expect(meta.status).toBe('revoked');
    });

    it('coalesces concurrent refresh calls into one network request', async () => {
      const added = await store.addOAuth({
        name: 'mutex-test',
        provider: 'google',
        helper: 'gemini-cli-workspace',
        payload: makePayload({
          accessToken: 'at-old',
          refreshToken: 'rt-test',
          expiresAt: Date.now() + 100,
        }),
      });

      let refreshCalls = 0;
      const fetch = mockFetch((url) => {
        if (url.includes('/refreshToken')) refreshCalls += 1;
        return {
          body: { access_token: 'at-fresh', expires_in: 3600 },
        };
      });

      const helper = new GeminiCliWorkspaceHelper(store, {
        extensionPath: extensionDir,
        fetch,
      });

      const payload = (await store.getPayload(added.id)) as GoogleOAuthPayload;

      const results = await Promise.all([
        helper.getAccessToken(added, payload),
        helper.getAccessToken(added, payload),
        helper.getAccessToken(added, payload),
      ]);

      expect(refreshCalls).toBe(1);
      for (const r of results) {
        expect(r.accessToken).toBe('at-fresh');
      }
    });

    it('returns original payload within cooldown window instead of retrying', async () => {
      const added = await store.addOAuth({
        name: 'cooldown-test',
        provider: 'google',
        helper: 'gemini-cli-workspace',
        payload: makePayload({
          accessToken: 'at-stale',
          refreshToken: 'rt-ok',
          expiresAt: Date.now() + 100,
        }),
      });

      let refreshCalls = 0;
      const fetch = mockFetch(() => {
        refreshCalls += 1;
        return { body: { access_token: 'at-fresh', expires_in: 3600 } };
      });

      const helper = new GeminiCliWorkspaceHelper(store, {
        extensionPath: extensionDir,
        fetch,
      });

      const payload = (await store.getPayload(added.id)) as GoogleOAuthPayload;

      // First call triggers a refresh
      const first = await helper.getAccessToken(added, payload);
      expect(first.accessToken).toBe('at-fresh');
      expect(refreshCalls).toBe(1);

      // Second call within cooldown returns the stale payload without
      // hitting the network again. Simulate expiring "payload" by passing
      // the same one (not the refreshed one).
      const second = await helper.getAccessToken(added, payload);
      expect(refreshCalls).toBe(1);
      expect(second.accessToken).toBe('at-stale'); // original returned, cooldown active
    });

    it('propagates non-invalid_grant HTTP errors without marking revoked', async () => {
      const added = await store.addOAuth({
        name: 'network-error-test',
        provider: 'google',
        helper: 'gemini-cli-workspace',
        payload: makePayload({
          refreshToken: 'rt-ok',
          expiresAt: Date.now() + 100,
        }),
      });

      const fetch = mockFetch(() => ({
        ok: false,
        status: 503,
        body: 'Service Unavailable',
      }));

      const helper = new GeminiCliWorkspaceHelper(store, {
        extensionPath: extensionDir,
        fetch,
      });

      const payload = (await store.getPayload(added.id)) as GoogleOAuthPayload;

      await expect(
        helper.getAccessToken(added, payload),
      ).rejects.toThrow(/refresh failed/i);

      const meta = await store.getCredential(added.id);
      expect(meta.status).toBe('active'); // not marked revoked on transient errors
    });
  });
});
