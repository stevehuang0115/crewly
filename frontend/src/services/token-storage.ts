/**
 * Cloud Auth Client (HTTP-based)
 *
 * OSS builds authenticate via HTTP calls to the Cloud API
 * (api.crewlyai.com). No direct Supabase SDK dependency.
 *
 * Tokens are stored in localStorage and attached as Bearer
 * tokens to subsequent API calls.
 *
 * @module services/token-storage
 */

// ---------------------------------------------------------------------------
// Token storage keys
// ---------------------------------------------------------------------------

const ACCESS_TOKEN_KEY = 'crewly_access_token';
const REFRESH_TOKEN_KEY = 'crewly_refresh_token';

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

/**
 * Get the stored access token.
 *
 * @returns Access token string or null
 */
export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

/**
 * Get the stored refresh token.
 *
 * @returns Refresh token string or null
 */
export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

/**
 * Store auth tokens from a login/register/refresh response.
 *
 * @param accessToken - JWT access token
 * @param refreshToken - Refresh token for renewal
 */
export function storeTokens(accessToken: string, refreshToken: string): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

/**
 * Clear stored auth tokens (on logout).
 */
export function clearTokens(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}
