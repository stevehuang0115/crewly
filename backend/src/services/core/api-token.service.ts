/**
 * API token service.
 *
 * Single source of truth for the shared secret that non-loopback callers
 * must present to reach `/api/*` and the WebSocket endpoints. The token is
 * either pinned via `CREWLY_API_TOKEN` or generated once on first boot and
 * persisted (mode 0600) at `<CREWLY_HOME>/api-token` so `crewly token` and
 * the running server agree on the value.
 *
 * Why this exists
 * ---------------
 * The REST API used to be completely unauthenticated while the server bound
 * every interface. On a production box the orchestrator PTY runs as root, so
 * `POST /api/terminal/:session/write` was a remote root shell. Loopback
 * callers (local skills via `api_call`, the local dashboard) keep working
 * with zero setup; everyone else needs this token.
 *
 * @module services/core/api-token.service
 */

import * as path from 'path';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { getCrewlyHomePath } from './crewly-home.utils.js';
import { API_SECURITY_CONSTANTS } from '../../../../config/constants.js';
import { readSecretText, writeSecretBytes } from './credential-vault.js';

/** Lazily-resolved token cache for the process lifetime. */
let cachedToken: string | null = null;

/** Where the cached token came from (for the one-time startup log). */
let cachedSource: ApiTokenSource | null = null;

/**
 * Origin of the active token. `ephemeral`: the token file is sealed and the
 * vault key could not be read (a locked keychain) — a process-only token is
 * used and the file is left alone, so the owner's real token is never
 * replaced by a transient keychain failure.
 */
export type ApiTokenSource = 'env' | 'file' | 'generated' | 'ephemeral';

/** Result of resolving the token, including provenance for logging. */
export interface ResolvedApiToken {
  /** The raw token value. */
  token: string;
  /** Where it came from. */
  source: ApiTokenSource;
  /** Absolute path of the token file (only meaningful for `file`/`generated`). */
  filePath: string;
}

/**
 * Absolute path of the persisted token file for the current process.
 *
 * @returns `<CREWLY_HOME>/api-token`
 */
export function getApiTokenFilePath(): string {
  return path.join(getCrewlyHomePath(), API_SECURITY_CONSTANTS.TOKEN_FILE_NAME);
}

/**
 * Generate a fresh random token.
 *
 * @returns Hex-encoded random token (`TOKEN_BYTES` bytes → 64 hex chars)
 */
export function generateApiToken(): string {
  return randomBytes(API_SECURITY_CONSTANTS.TOKEN_BYTES).toString('hex');
}

/** What reading the token file found. */
type TokenFileRead = { token: string; locked?: undefined } | { token: null; locked: string | null };

/**
 * Read a previously persisted token, if any. The file may be sealed by the
 * credential vault (specs/2026-10-04-agent-credential-isolation.md).
 *
 * @param filePath - Token file path
 * @returns The trimmed token; or null with `locked` set when the file exists
 *   but is sealed and cannot be opened right now
 */
function readTokenFile(filePath: string): TokenFileRead {
  const res = readSecretText(filePath);
  if (res.status === 'locked') return { token: null, locked: res.message };
  if (res.status === 'missing') return { token: null, locked: null };
  const raw = res.value.trim();
  return raw.length > 0 ? { token: raw } : { token: null, locked: null };
}

/**
 * Persist a token with owner-only permissions, creating CREWLY_HOME on demand.
 * Sealed with the credential vault key when one is available.
 *
 * @param filePath - Token file path
 * @param token - Token to write
 */
function writeTokenFile(filePath: string, token: string): void {
  writeSecretBytes(filePath, `${token}\n`, API_SECURITY_CONSTANTS.TOKEN_FILE_MODE);
}

/**
 * Resolve the active API token with provenance.
 *
 * Priority: `CREWLY_API_TOKEN` env → `<CREWLY_HOME>/api-token` → generate +
 * persist. The result is cached for the process lifetime; call
 * {@link resetApiTokenCache} in tests.
 *
 * @returns Token plus source and file path
 */
export function resolveApiToken(): ResolvedApiToken {
  const filePath = getApiTokenFilePath();
  if (cachedToken && cachedSource) {
    return { token: cachedToken, source: cachedSource, filePath };
  }

  const fromEnv = process.env[API_SECURITY_CONSTANTS.ENV.API_TOKEN]?.trim();
  if (fromEnv) {
    cachedToken = fromEnv;
    cachedSource = 'env';
    return { token: fromEnv, source: 'env', filePath };
  }

  const fromFile = readTokenFile(filePath);
  if (fromFile.token) {
    cachedToken = fromFile.token;
    cachedSource = 'file';
    return { token: fromFile.token, source: 'file', filePath };
  }
  if (fromFile.locked) {
    // Sealed and unreadable right now: never overwrite the owner's token.
    const ephemeral = generateApiToken();
    cachedToken = ephemeral;
    cachedSource = 'ephemeral';
    return { token: ephemeral, source: 'ephemeral', filePath };
  }

  const generated = generateApiToken();
  writeTokenFile(filePath, generated);
  cachedToken = generated;
  cachedSource = 'generated';
  return { token: generated, source: 'generated', filePath };
}

/** What {@link mirrorEnvTokenToFile} did. */
export type EnvTokenMirrorResult = 'not-env' | 'written' | 'updated' | 'unchanged' | 'failed';

/**
 * Make `<CREWLY_HOME>/api-token` hold the token the server actually uses
 * when that token is pinned by `CREWLY_API_TOKEN` (#1010 review).
 *
 * The CLI now presents the owner token on its local calls and reads it from
 * the environment or this file. A server whose token lives only in its
 * service environment (systemd on steamfun-ops) left the file missing, so
 * `crewly onboard` / `bundle` / `desktop` from an ordinary shell got 401 on
 * the owner-only routes. Called once at startup.
 *
 * - Token not from the environment: nothing to do (the file is the source).
 * - File missing: written, mode 0600.
 * - File holding another value: rewritten — the server only accepts the
 *   env token, so a stale file can only produce 401s.
 *
 * @returns What was done
 */
export function mirrorEnvTokenToFile(): EnvTokenMirrorResult {
  const fromEnv = process.env[API_SECURITY_CONSTANTS.ENV.API_TOKEN]?.trim();
  if (!fromEnv) return 'not-env';
  const filePath = getApiTokenFilePath();
  const existing = readTokenFile(filePath).token;
  if (existing === fromEnv) return 'unchanged';
  try {
    writeTokenFile(filePath, fromEnv);
    return existing === null ? 'written' : 'updated';
  } catch {
    return 'failed';
  }
}

/**
 * The token a client on this machine should present, without creating one:
 * `CREWLY_API_TOKEN`, else the token file, else null. Used by the CLI so a
 * command run before the first boot does not mint a token as a side effect.
 *
 * @returns The token, or null when none exists yet
 */
export function readExistingApiToken(): string | null {
  const fromEnv = process.env[API_SECURITY_CONSTANTS.ENV.API_TOKEN]?.trim();
  if (fromEnv) return fromEnv;
  return readTokenFile(getApiTokenFilePath()).token;
}

/**
 * Convenience accessor for the raw token.
 *
 * @returns The active API token
 */
export function getApiToken(): string {
  return resolveApiToken().token;
}

/**
 * Short, non-reversible identifier of a token for audit trails.
 *
 * @param token - Token to fingerprint (defaults to the active token)
 * @returns First `FINGERPRINT_HEX_LENGTH` hex chars of sha256(token)
 */
export function getApiTokenFingerprint(token: string = getApiToken()): string {
  return createHash('sha256')
    .update(token)
    .digest('hex')
    .slice(0, API_SECURITY_CONSTANTS.FINGERPRINT_HEX_LENGTH);
}

/**
 * Constant-time comparison of a presented token against the active one.
 *
 * @param candidate - Token presented by the caller (may be missing)
 * @returns True when the candidate matches exactly
 */
export function verifyApiToken(candidate: string | null | undefined): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return false;
  }
  const expected = Buffer.from(getApiToken());
  const presented = Buffer.from(candidate);
  if (expected.length !== presented.length) {
    return false;
  }
  return timingSafeEqual(expected, presented);
}

/**
 * Drop the in-process cache so the next resolve re-reads env/file.
 * Intended for tests.
 */
export function resetApiTokenCache(): void {
  cachedToken = null;
  cachedSource = null;
}
