/**
 * Google OAuth Configuration
 *
 * Crewly can acquire Google Workspace credentials through either of two OAuth
 * applications, and this module is the single place that decides which:
 *
 * - **crewly** — Crewly's own published OAuth app, brokered by Crewly Cloud.
 *   The authorization code lands on a Crewly-owned HTTPS redirect and Cloud
 *   exchanges it, so the client_secret lives only on the server and never
 *   ships with OSS. Selected by setting {@link CREWLY_GOOGLE_CLIENT_ID_ENV}.
 *
 * - **gemini-cli** — the fallback, and what every install used before Crewly
 *   had its own app: piggybacking on the Google Workspace extension for Gemini
 *   CLI (https://github.com/gemini-cli-extensions/workspace). Borrowing a
 *   published app avoided both the 7-day testing-mode grant expiry and the
 *   need to hold a client_secret, at the cost of depending on someone else's
 *   OAuth app and refresh function.
 *
 * The fallback is deliberate, not vestigial: an install that has not been
 * pointed at Crewly's app keeps working exactly as before, and a self-hoster
 * who wants to depend on neither can point these variables at a GCP project
 * of their own.
 *
 * @module config/oauth.config
 */

// ---------------------------------------------------------------------------
// Environment variable names
// ---------------------------------------------------------------------------

/** Env var that, when set, switches the Workspace flow to Crewly's own app. */
export const CREWLY_GOOGLE_CLIENT_ID_ENV = 'CREWLY_GOOGLE_CLIENT_ID';

/** Env var overriding where Google sends the authorization code. */
export const CREWLY_GOOGLE_REDIRECT_URI_ENV = 'CREWLY_GOOGLE_REDIRECT_URI';

/** Env var overriding the endpoint that exchanges a refresh token. */
export const CREWLY_GOOGLE_REFRESH_URL_ENV = 'CREWLY_GOOGLE_REFRESH_URL';

// ---------------------------------------------------------------------------
// Static endpoints
// ---------------------------------------------------------------------------

/** Base URL of Google's OAuth 2.0 authorization endpoint. */
export const GOOGLE_OAUTH_AUTH_BASE =
  'https://accounts.google.com/o/oauth2/v2/auth';

/** Google's userinfo endpoint — used to resolve an OAuth token's account email. */
export const GOOGLE_USERINFO_ENDPOINT =
  'https://www.googleapis.com/oauth2/v3/userinfo';

/** Path on the Gemini CLI cloud function used for token refresh calls. */
export const GEMINI_CLI_REFRESH_PATH = '/refreshToken';

/** Cloud Function base URL where the Gemini CLI extension's `/refreshToken` lives. */
export const GEMINI_CLI_CLOUD_FUNCTION_URL =
  'https://google-workspace-extension.geminicli.com';

/** Default Crewly Cloud origin, used to derive the Crewly redirect/refresh URLs. */
const CREWLY_CLOUD_ORIGIN = 'https://api.crewlyai.com';

// ---------------------------------------------------------------------------
// The two apps
// ---------------------------------------------------------------------------

/** Which OAuth application a Workspace credential was (or will be) issued by. */
export type GoogleOAuthProvider = 'crewly' | 'gemini-cli';

/** Everything the authorize/refresh paths need to talk to one OAuth app. */
export interface GoogleOAuthApp {
  /** Which application this is. */
  provider: GoogleOAuthProvider;
  /** OAuth client_id presented on the consent URL. */
  clientId: string;
  /** Where Google sends the authorization code. */
  redirectUri: string;
  /**
   * Endpoint that trades a refresh_token for a fresh access_token.
   *
   * Neither provider needs a client_secret on this side: 'crewly' posts to
   * Crewly Cloud, which holds the secret; 'gemini-cli' posts to the
   * extension's cloud function, which holds theirs.
   */
  refreshUrl: string;
  /** Scopes requested when the caller does not specify their own. */
  defaultScopes: readonly string[];
}

/**
 * Scopes registered on Crewly's own OAuth consent screen (GCP project
 * `crewlyai`, registered 2026-09-07).
 *
 * Requesting a scope the consent screen does not declare fails, so this list
 * and the console must move together. `photoslibrary.readonly` is absent on
 * purpose — the Photos Library API is not enabled on the project, and it is a
 * restricted scope that would widen the eventual CASA assessment for a feature
 * nothing asks for yet.
 */
export const CREWLY_GOOGLE_SCOPES: readonly string[] = [
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
];

/**
 * Scopes the Gemini CLI Workspace extension's consent screen declares.
 *
 * Kept as-is, including `photoslibrary.readonly`, because these grants were
 * issued against their app: narrowing the list would silently drop an
 * already-working capability for installs still on the fallback.
 */
export const GEMINI_CLI_GOOGLE_SCOPES: readonly string[] = [
  ...CREWLY_GOOGLE_SCOPES,
  'https://www.googleapis.com/auth/photoslibrary.readonly',
];

/** The borrowed Gemini CLI Workspace extension app. */
export const GEMINI_CLI_OAUTH_APP: GoogleOAuthApp = {
  provider: 'gemini-cli',
  clientId:
    '338689075775-o75k922vn5fdl18qergr96rp8g63e4d7.apps.googleusercontent.com',
  redirectUri: GEMINI_CLI_CLOUD_FUNCTION_URL,
  refreshUrl: `${GEMINI_CLI_CLOUD_FUNCTION_URL}${GEMINI_CLI_REFRESH_PATH}`,
  defaultScopes: GEMINI_CLI_GOOGLE_SCOPES,
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Read an env var, treating whitespace-only as unset. */
function envValue(name: string): string | undefined {
  const raw = process.env[name];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the OAuth app this install should use.
 *
 * Reads the environment on every call rather than at import time so that a
 * process which loads its `.env` after module resolution — and a test that
 * sets a variable per case — both see the value they set.
 *
 * @returns The active app; {@link GEMINI_CLI_OAUTH_APP} when Crewly's own
 *   client_id is not configured.
 *
 * @example
 * ```ts
 * const app = resolveGoogleOAuthApp();
 * if (app.provider === 'crewly') { ... }
 * ```
 */
export function resolveGoogleOAuthApp(): GoogleOAuthApp {
  const clientId = envValue(CREWLY_GOOGLE_CLIENT_ID_ENV);
  if (!clientId) return GEMINI_CLI_OAUTH_APP;

  return {
    provider: 'crewly',
    clientId,
    redirectUri:
      envValue(CREWLY_GOOGLE_REDIRECT_URI_ENV) ??
      `${CREWLY_CLOUD_ORIGIN}/api/cloud/google/workspace/callback`,
    refreshUrl:
      envValue(CREWLY_GOOGLE_REFRESH_URL_ENV) ??
      `${CREWLY_CLOUD_ORIGIN}/api/cloud/google/workspace/refresh`,
    defaultScopes: CREWLY_GOOGLE_SCOPES,
  };
}

// ---------------------------------------------------------------------------
// Back-compatible accessors
// ---------------------------------------------------------------------------

/** client_id of the active OAuth app. */
export function googleOAuthClientId(): string {
  return resolveGoogleOAuthApp().clientId;
}

/** Redirect URI of the active OAuth app. */
export function googleOAuthRedirectUri(): string {
  return resolveGoogleOAuthApp().redirectUri;
}

/** Refresh endpoint of the active OAuth app. */
export function googleOAuthRefreshUrl(): string {
  return resolveGoogleOAuthApp().refreshUrl;
}

/** Default scopes of the active OAuth app. */
export function defaultGoogleScopes(): readonly string[] {
  return resolveGoogleOAuthApp().defaultScopes;
}
