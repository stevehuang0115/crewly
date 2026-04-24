/**
 * Credential Types (Frontend)
 *
 * UI-facing types that mirror the backend's `CredentialRegistryEntry`.
 * Intentionally excludes backend-only fields (e.g., `encFile`).
 *
 * @module types/credential.types
 */

/** High-level credential type. */
export type CredentialType = 'api-key' | 'google-oauth';

/** Lifecycle status of a credential. */
export type CredentialStatus = 'active' | 'revoked';

/** Helper that manages refresh for OAuth credentials. */
export type CredentialHelperName =
  | 'gemini-cli-workspace'
  | 'byo-oauth'
  | 'gcloud-adc'
  | 'crewly-official';

/** Metadata for a credential — the shape returned by `GET /api/credentials`. */
export interface CredentialSummary {
  id: string;
  name: string;
  type: CredentialType;
  provider: string;
  helper?: CredentialHelperName;
  scopes?: string[];
  accountEmail?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  expiresAt?: number;
  status: CredentialStatus;
}

/** Request body for `POST /api/credentials/api-key`. */
export interface AddApiKeyRequest {
  name: string;
  provider: string;
  value: string;
}

/** Request body for `POST /api/credentials/oauth/import-gemini-cli`. */
export interface ImportGeminiCliRequest {
  name: string;
}

/** Request body for `PATCH /api/credentials/:id`. */
export interface UpdateCredentialRequest {
  name?: string;
  status?: CredentialStatus;
}

// ============================================================================
// Headless Google OAuth (UI-driven) — types
// ============================================================================

/**
 * Scope preset identifiers shown in the "Add Google account" dialog.
 *
 * - `gmail-only` — minimal scope set; lowest chance of Google blocking the
 *   consent screen on a non-Workspace account.
 * - `full-workspace` — broad scope set (Gmail + Drive + Calendar + Photos).
 *   We omit `scopes` on the `/start` call so the backend uses its default.
 * - `custom` — the user supplies their own scope list (advanced).
 */
export type GoogleScopePreset = 'gmail-only' | 'full-workspace' | 'custom';

/**
 * Minimal scope set — just enough to read/write Gmail and identify the
 * account. Matches what the backend treats as "low-risk" for personal gmail
 * accounts that don't allow broad Workspace consent.
 */
export const GMAIL_ONLY_SCOPES: readonly string[] = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/gmail.modify',
];

/**
 * Request body for `POST /api/credentials/oauth/google/start`.
 *
 * When `scopes` is omitted the backend uses its broad Workspace default.
 */
export interface StartGoogleOAuthRequest {
  scopes?: string[];
}

/** Response body for `POST /api/credentials/oauth/google/start`. */
export interface StartGoogleOAuthResponse {
  authUrl: string;
}

/**
 * Request body for `POST /api/credentials/oauth/google/complete`.
 *
 * `credentialsJson` can be either:
 * - the raw JSON string the user pasted from the OAuth success page, or
 * - an already-parsed object with `access_token` / `refresh_token`.
 */
export interface CompleteGoogleOAuthRequest {
  name: string;
  credentialsJson: string | Record<string, unknown>;
}
