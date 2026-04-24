/**
 * Google Userinfo Helper
 *
 * Fetches the signed-in user's email from Google's userinfo endpoint given a
 * valid OAuth access token. Best-effort: returns `undefined` on network or
 * HTTP error so callers can proceed without an account email when the grant
 * is still valid.
 *
 * Used by both the credentials controller (headless OAuth completion) and
 * the Gemini CLI Workspace helper (token capture) so the fetch + parsing
 * logic lives in one place.
 *
 * @module utils/google-userinfo.utils
 */

import { GOOGLE_USERINFO_ENDPOINT } from '../config/oauth.config.js';

/**
 * Minimal fetch-compatible function shape — injectable for tests and to
 * match the `FetchLike` shape used by the Gemini CLI helper.
 */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

/**
 * Fetch the account email associated with the given OAuth access token.
 *
 * Best-effort: returns `undefined` on network failure, non-2xx response,
 * or a response missing the `email` field. Never throws.
 *
 * @param accessToken - A valid Google OAuth access token with a scope that
 *                      grants `userinfo.email` (e.g. openid/email).
 * @param fetchImpl - Injectable fetch (defaults to the global `fetch`).
 * @returns The account email, or `undefined` if it cannot be determined.
 */
export async function fetchGoogleAccountEmail(
  accessToken: string,
  fetchImpl?: FetchLike,
): Promise<string | undefined> {
  const doFetch: FetchLike =
    fetchImpl ??
    ((url, init) =>
      fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>);

  try {
    const response = await doFetch(GOOGLE_USERINFO_ENDPOINT, {
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
