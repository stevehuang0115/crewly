/**
 * Google OAuth Configuration
 *
 * Shared constants for the Google OAuth flows that piggyback on the Gemini
 * CLI Workspace extension's published OAuth app. Defining these here lets
 * the REST controller (URL-builder) and the helper (refresh client) stay in
 * sync on client_id / redirect_uri / endpoints.
 *
 * These values come from the Gemini CLI Workspace extension's
 * `workspace-server/src/utils/config.ts` — using the same client_id
 * + redirect_uri lets us avoid the 7-day testing-mode grant expiry.
 *
 * @module config/oauth.config
 */

/** OAuth client_id for the Gemini CLI Workspace extension's published app. */
export const GOOGLE_OAUTH_CLIENT_ID =
  '338689075775-o75k922vn5fdl18qergr96rp8g63e4d7.apps.googleusercontent.com';

/** Redirect URI the Gemini CLI Workspace cloud function is registered for. */
export const GOOGLE_OAUTH_REDIRECT_URI =
  'https://google-workspace-extension.geminicli.com';

/** Base URL of Google's OAuth 2.0 authorization endpoint. */
export const GOOGLE_OAUTH_AUTH_BASE =
  'https://accounts.google.com/o/oauth2/v2/auth';

/** Cloud Function base URL where the extension's `/refreshToken` lives. */
export const GEMINI_CLI_CLOUD_FUNCTION_URL =
  'https://google-workspace-extension.geminicli.com';

/** Path on the cloud function used for token refresh calls. */
export const GEMINI_CLI_REFRESH_PATH = '/refreshToken';

/** Google's userinfo endpoint — used to resolve an OAuth token's account email. */
export const GOOGLE_USERINFO_ENDPOINT =
  'https://www.googleapis.com/oauth2/v3/userinfo';

/**
 * Default scope set for a broad Workspace grant — covers the common Gmail,
 * Drive, Docs, Calendar, and Photos read paths used by marketplace skills.
 * Callers of `/oauth/google/start` may override via the request body.
 */
export const DEFAULT_GOOGLE_SCOPES: readonly string[] = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/photoslibrary.readonly',
];
