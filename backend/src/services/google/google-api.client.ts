/**
 * Google API client — the one place Gmail and Calendar calls go through.
 *
 * Attaches the Cloud-minted access token, maps Google's HTTP failures to
 * {@link GoogleWorkspaceError}, and drops the cached token on a 401 so the
 * next call refreshes instead of failing the same way again.
 *
 * @module services/google/google-api.client
 */

import { GOOGLE_WORKSPACE_CONSTANTS } from '../../constants.js';
import { GoogleWorkspaceError } from './google-workspace-token.service.js';

/** The slice of GoogleWorkspaceTokenService the Google services need. */
export interface GoogleTokenProvider {
  getAccessToken(): Promise<string>;
  clearCache(): void;
}

/** Shared constructor dependencies for Gmail / Calendar services. */
export interface GoogleApiDeps {
  tokens: GoogleTokenProvider;
  fetchImpl?: typeof fetch;
}

/** Google's error envelope (`{ error: { code, message, status } }`). */
interface GoogleErrorBody {
  error?: { code?: number; message?: string; status?: string } | string;
}

/**
 * Extract the human message from a Google error body, tolerating both the
 * object and the plain-string shapes Google uses.
 *
 * @param text - Raw response body
 * @returns Message or undefined
 */
function googleErrorMessage(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as GoogleErrorBody;
    if (typeof parsed.error === 'string') return parsed.error;
    return parsed.error?.message;
  } catch {
    return text ? text.slice(0, 200) : undefined;
  }
}

/**
 * Build a URL with query parameters; `undefined`/empty values are skipped and
 * array values are repeated (Gmail's `metadataHeaders=A&metadataHeaders=B`).
 *
 * @param base - Absolute URL without query
 * @param params - Query parameters
 * @returns The full URL string
 */
export function buildGoogleUrl(base: string, params: Record<string, string | number | string[] | undefined> = {}): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, v);
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Authenticated JSON call to a Google API.
 *
 * @param deps - Token provider + fetch
 * @param url - Absolute URL (use {@link buildGoogleUrl})
 * @param init - Method and optional JSON body
 * @returns The parsed JSON response
 * @throws GoogleWorkspaceError — token failures pass through; Google 401 →
 *   401 google_error (cache dropped), 403/404/429 keep their status, other
 *   failures → 502 google_error, unreachable → 502 network
 */
export async function googleRequest<T>(
  deps: GoogleApiDeps,
  url: string,
  init: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<T> {
  const token = await deps.tokens.getAccessToken();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const CODES = GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(GOOGLE_WORKSPACE_CONSTANTS.REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GoogleWorkspaceError(502, CODES.NETWORK, `Google unreachable: ${message}`);
  }

  const text = await res.text();
  if (!res.ok) {
    const message = googleErrorMessage(text) ?? `Google request failed (${res.status})`;
    if (res.status === 401) {
      deps.tokens.clearCache();
      throw new GoogleWorkspaceError(401, CODES.GOOGLE_ERROR, `Google rejected the access token: ${message}`);
    }
    const passthrough = res.status === 403 || res.status === 404 || res.status === 429;
    throw new GoogleWorkspaceError(passthrough ? res.status : 502, CODES.GOOGLE_ERROR, message);
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GoogleWorkspaceError(502, CODES.GOOGLE_ERROR, 'Google returned a non-JSON response.');
  }
}
