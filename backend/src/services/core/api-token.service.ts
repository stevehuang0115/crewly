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

import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { getCrewlyHomePath } from './crewly-home.utils.js';
import { API_SECURITY_CONSTANTS } from '../../../../config/constants.js';

/** Lazily-resolved token cache for the process lifetime. */
let cachedToken: string | null = null;

/** Where the cached token came from (for the one-time startup log). */
let cachedSource: ApiTokenSource | null = null;

/** Origin of the active token. */
export type ApiTokenSource = 'env' | 'file' | 'generated';

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

/**
 * Read a previously persisted token, if any.
 *
 * @param filePath - Token file path
 * @returns Trimmed token or null when the file is missing/empty
 */
function readTokenFile(filePath: string): string | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Persist a token with owner-only permissions, creating CREWLY_HOME on demand.
 *
 * @param filePath - Token file path
 * @param token - Token to write
 */
function writeTokenFile(filePath: string, token: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${token}\n`, { mode: API_SECURITY_CONSTANTS.TOKEN_FILE_MODE });
  // writeFileSync only applies `mode` on creation; enforce it for pre-existing files too.
  fs.chmodSync(filePath, API_SECURITY_CONSTANTS.TOKEN_FILE_MODE);
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
  if (fromFile) {
    cachedToken = fromFile;
    cachedSource = 'file';
    return { token: fromFile, source: 'file', filePath };
  }

  const generated = generateApiToken();
  writeTokenFile(filePath, generated);
  cachedToken = generated;
  cachedSource = 'generated';
  return { token: generated, source: 'generated', filePath };
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
