/**
 * Gemini CLI Workspace Credential Helper
 *
 * Piggybacks on the Google Workspace extension for Gemini CLI
 * (https://github.com/gemini-cli-extensions/workspace) for Google OAuth
 * credential acquisition and refresh.
 *
 * **Capture** reads the extension's file-storage token file (written when
 * the user runs the extension with `GEMINI_CLI_WORKSPACE_FORCE_FILE_STORAGE=true`)
 * and imports the tokens into Crewly's own encrypted store.
 *
 * **Refresh** POSTs the stored `refresh_token` to the extension's Cloud
 * Function `/refreshToken` endpoint — no client_secret needed on our side.
 *
 * After capture, Crewly owns the tokens; the extension's own state is not
 * depended on for day-to-day operation.
 *
 * @module services/credential/helpers/gemini-cli-workspace.helper
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

import {
  CredentialHelper,
  CredentialHelperName,
  CredentialRegistryEntry,
  GoogleOAuthPayload,
  CredentialRevokedError,
} from '../../../types/credential.types.js';
import { CredentialStoreService } from '../credential-store.service.js';

// ============================================================================
// Constants — extracted from the extension source
// (github.com/gemini-cli-extensions/workspace)
// ============================================================================

const DEFAULT_EXTENSION_PATH = path.join(
  os.homedir(),
  '.gemini',
  'extensions',
  'google-workspace',
);
const TOKEN_FILENAME = 'gemini-cli-workspace-token.json';
const MASTER_KEY_FILENAME = '.gemini-cli-workspace-master-key';
const MAIN_ACCOUNT_KEY = 'main-account';
const SALT_SUFFIX = '-gemini-cli-workspace';

const DEFAULT_CLOUD_FUNCTION_URL =
  'https://google-workspace-extension.geminicli.com';
const DEFAULT_REFRESH_PATH = '/refreshToken';
const DEFAULT_CLIENT_ID =
  '338689075775-o75k922vn5fdl18qergr96rp8g63e4d7.apps.googleusercontent.com';

/** Refresh if the current access token expires within this window. */
const DEFAULT_EXPIRY_BUFFER_MS = 60_000;
/** Minimum gap between refresh attempts for the same credential. */
const REFRESH_COOLDOWN_MS = 30_000;

const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';

// ============================================================================
// Types
// ============================================================================

/**
 * Shape of the OAuthCredentials object the extension stores on disk.
 * Matches the extension's `OAuthCredentials` type.
 */
interface ExtensionOAuthCredentials {
  serverName: string;
  token: {
    accessToken?: string;
    refreshToken?: string;
    tokenType?: string;
    scope?: string;
    expiresAt?: number;
  };
  updatedAt: number;
}

/**
 * Minimal fetch-compatible function shape (for test injection).
 */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

/**
 * Helper configuration — all fields optional; defaults match production.
 */
export interface GeminiCliHelperConfig {
  /** Path to the extension install directory (default: `~/.gemini/extensions/google-workspace`). */
  extensionPath?: string;
  /** Cloud Function base URL. */
  cloudFunctionUrl?: string;
  /** Path on the cloud function for refresh calls. */
  refreshPath?: string;
  /** Client ID to store on the credential (for later refresh identification). */
  clientId?: string;
  /** Refresh buffer in ms — refresh if token expires within this window. */
  expiryBufferMs?: number;
  /** Fetch implementation (injectable for tests). */
  fetch?: FetchLike;
}

// ============================================================================
// Helper
// ============================================================================

/**
 * Credential helper that reads tokens from the gemini-cli-workspace extension
 * and refreshes them via the extension's Cloud Function.
 */
export class GeminiCliWorkspaceHelper implements CredentialHelper {
  readonly name: CredentialHelperName = 'gemini-cli-workspace';

  private readonly extensionPath: string;
  private readonly cloudFunctionUrl: string;
  private readonly refreshPath: string;
  private readonly clientId: string;
  private readonly expiryBufferMs: number;
  private readonly fetchFn: FetchLike;
  private readonly store: CredentialStoreService;

  /** Per-credential refresh in-flight promises (serializes concurrent refreshes). */
  private readonly refreshInFlight = new Map<
    string,
    Promise<GoogleOAuthPayload>
  >();
  /** Per-credential last refresh attempt timestamp (for cooldown). */
  private readonly lastRefreshAttempt = new Map<string, number>();

  constructor(
    store: CredentialStoreService,
    config?: GeminiCliHelperConfig,
  ) {
    this.store = store;
    this.extensionPath = config?.extensionPath ?? DEFAULT_EXTENSION_PATH;
    this.cloudFunctionUrl =
      config?.cloudFunctionUrl ?? DEFAULT_CLOUD_FUNCTION_URL;
    this.refreshPath = config?.refreshPath ?? DEFAULT_REFRESH_PATH;
    this.clientId = config?.clientId ?? DEFAULT_CLIENT_ID;
    this.expiryBufferMs = config?.expiryBufferMs ?? DEFAULT_EXPIRY_BUFFER_MS;
    this.fetchFn =
      config?.fetch ??
      ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>);
  }

  // ------------------------------------------------------------------
  //  Capture
  // ------------------------------------------------------------------

  /**
   * Read the extension's current token file and return its contents as a
   * `GoogleOAuthPayload` ready to persist in Crewly's store.
   *
   * The user must have completed extension login with
   * `GEMINI_CLI_WORKSPACE_FORCE_FILE_STORAGE=true` before calling this.
   */
  async captureFromFile(): Promise<GoogleOAuthPayload> {
    const tokenPath = path.join(this.extensionPath, TOKEN_FILENAME);
    const masterKeyPath = path.join(this.extensionPath, MASTER_KEY_FILENAME);

    // Surface a user-friendly error if login hasn't happened yet
    try {
      await fs.access(tokenPath);
    } catch {
      throw new Error(
        `Gemini CLI Workspace token file not found at ${tokenPath}. ` +
          `Please run 'GEMINI_CLI_WORKSPACE_FORCE_FILE_STORAGE=true gemini' ` +
          `and complete Google sign-in first, then retry.`,
      );
    }
    try {
      await fs.access(masterKeyPath);
    } catch {
      throw new Error(
        `Gemini CLI Workspace master key file not found at ${masterKeyPath}. ` +
          `The extension should create this on first login.`,
      );
    }

    const encryptedText = await fs.readFile(tokenPath, 'utf8');
    const masterKey = await fs.readFile(masterKeyPath);

    // Derive the extension's encryption key (scrypt with hostname-username salt).
    // Must match `file-token-storage.ts` exactly.
    const salt = `${os.hostname()}-${os.userInfo().username}${SALT_SUFFIX}`;
    const encryptionKey = crypto.scryptSync(masterKey, salt, 32);

    const decrypted = this.decryptExtensionFormat(encryptedText, encryptionKey);
    const parsed = JSON.parse(decrypted) as Record<
      string,
      ExtensionOAuthCredentials
    >;
    const entry = parsed[MAIN_ACCOUNT_KEY];
    if (!entry) {
      throw new Error(
        `Extension token file does not contain a '${MAIN_ACCOUNT_KEY}' entry. ` +
          `Did login complete successfully?`,
      );
    }

    const { accessToken, refreshToken, tokenType, scope, expiresAt } =
      entry.token;
    if (!accessToken || !refreshToken) {
      throw new Error(
        `Extension token is missing accessToken or refreshToken — login may be incomplete.`,
      );
    }

    const scopes = typeof scope === 'string' ? scope.split(' ').filter(Boolean) : [];

    const accountEmail = await this.fetchUserEmail(accessToken);

    return {
      type: 'google-oauth',
      accessToken,
      refreshToken,
      tokenType: (tokenType as 'Bearer') ?? 'Bearer',
      expiresAt: expiresAt ?? Date.now() + 3600_000,
      scopes,
      accountEmail,
      clientId: this.clientId,
    };
  }

  /**
   * Remove the extension's token file. Call after `captureFromFile()` to
   * prepare for the next account's login (the extension otherwise returns
   * cached credentials if scopes match, skipping the login prompt).
   * Leaves the master.key file untouched so existing ciphertexts remain
   * decryptable if needed.
   */
  async clearExtensionFile(): Promise<void> {
    const tokenPath = path.join(this.extensionPath, TOKEN_FILENAME);
    try {
      await fs.unlink(tokenPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  // ------------------------------------------------------------------
  //  Refresh / getAccessToken
  // ------------------------------------------------------------------

  /**
   * Return a valid `GoogleOAuthPayload`, refreshing via the extension's
   * cloud function if the access token is within the expiry buffer.
   *
   * Concurrent calls for the same credential share a single refresh.
   *
   * @throws CredentialRevokedError if the refresh token is no longer valid
   */
  async getAccessToken(
    entry: CredentialRegistryEntry,
    payload: GoogleOAuthPayload,
  ): Promise<GoogleOAuthPayload> {
    // Fast path: still valid
    if (payload.expiresAt - Date.now() > this.expiryBufferMs) {
      return payload;
    }

    // Coalesce concurrent refreshes for the same credential
    const existing = this.refreshInFlight.get(entry.id);
    if (existing) return existing;

    // Cooldown — avoid hammering the refresh endpoint
    const last = this.lastRefreshAttempt.get(entry.id) ?? 0;
    if (Date.now() - last < REFRESH_COOLDOWN_MS) {
      // Within cooldown — return the (possibly expired) payload; caller will
      // get a fresh attempt after the cooldown window.
      return payload;
    }

    const promise = this.doRefresh(entry, payload);
    this.refreshInFlight.set(entry.id, promise);
    this.lastRefreshAttempt.set(entry.id, Date.now());
    try {
      return await promise;
    } finally {
      this.refreshInFlight.delete(entry.id);
    }
  }

  private async doRefresh(
    entry: CredentialRegistryEntry,
    payload: GoogleOAuthPayload,
  ): Promise<GoogleOAuthPayload> {
    const url = this.cloudFunctionUrl.replace(/\/$/, '') + this.refreshPath;
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: payload.refreshToken }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // Google responds 400 with body containing "invalid_grant" when the
      // refresh token is revoked/expired beyond recovery.
      if (
        response.status === 400 &&
        /invalid_grant/i.test(body)
      ) {
        await this.store.updateCredential(entry.id, { status: 'revoked' });
        throw new CredentialRevokedError(
          entry.id,
          entry.name,
          `Log in to the Gemini CLI Workspace extension again and re-import this credential in Crewly.`,
        );
      }
      throw new Error(
        `Token refresh failed (${response.status}): ${body.slice(0, 500)}`,
      );
    }

    const data = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      scope?: string;
      token_type?: string;
    };
    if (!data.access_token) {
      throw new Error('Token refresh response missing access_token');
    }

    const expiresAt =
      Date.now() + (data.expires_in ?? 3600) * 1000;

    const updated: GoogleOAuthPayload = {
      ...payload,
      accessToken: data.access_token,
      expiresAt,
      // Google typically does NOT issue a new refresh_token on refresh,
      // but honor it if present
      refreshToken: data.refresh_token ?? payload.refreshToken,
      scopes:
        typeof data.scope === 'string'
          ? data.scope.split(' ').filter(Boolean)
          : payload.scopes,
    };

    await this.store.setPayload(entry.id, updated);
    await this.store.updateCredential(entry.id, {
      expiresAt,
      lastUsedAt: new Date().toISOString(),
    });

    return updated;
  }

  // ------------------------------------------------------------------
  //  Internals
  // ------------------------------------------------------------------

  /**
   * Decrypt the extension's `{iv_hex}:{authTag_hex}:{ciphertext_hex}`
   * format (AES-256-GCM).
   */
  private decryptExtensionFormat(
    encryptedText: string,
    key: Buffer,
  ): string {
    const parts = encryptedText.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid extension token format (expected iv:tag:ciphertext)');
    }
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const ciphertextHex = parts[2];

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /**
   * Fetch the user's email via Google's userinfo endpoint. Best-effort;
   * returns undefined on failure.
   */
  private async fetchUserEmail(
    accessToken: string,
  ): Promise<string | undefined> {
    try {
      const response = await this.fetchFn(USERINFO_ENDPOINT, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) return undefined;
      const data = (await response.json()) as { email?: string };
      return data.email;
    } catch {
      return undefined;
    }
  }
}

// ============================================================================
// Test helpers (not exported from public barrel — intended for tests only)
// ============================================================================

/**
 * Encrypt a plaintext string with the extension's file format. Used in
 * tests to generate fake token files.
 */
export function encryptExtensionFormatForTesting(
  plaintext: string,
  key: Buffer,
): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

/**
 * Derive the extension's encryption key using the real scrypt + salt.
 * Test-only export.
 */
export function deriveExtensionKeyForTesting(masterKey: Buffer): Buffer {
  const salt = `${os.hostname()}-${os.userInfo().username}${SALT_SUFFIX}`;
  return crypto.scryptSync(masterKey, salt, 32);
}
