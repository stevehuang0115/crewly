/**
 * Tests for oauth.config — the shape of the two OAuth apps, and which one
 * `resolveGoogleOAuthApp()` picks for a given environment.
 */

import {
  CREWLY_GOOGLE_CLIENT_ID_ENV,
  CREWLY_GOOGLE_REDIRECT_URI_ENV,
  CREWLY_GOOGLE_REFRESH_URL_ENV,
  CREWLY_GOOGLE_SCOPES,
  GEMINI_CLI_CLOUD_FUNCTION_URL,
  GEMINI_CLI_GOOGLE_SCOPES,
  GEMINI_CLI_OAUTH_APP,
  GEMINI_CLI_REFRESH_PATH,
  GOOGLE_OAUTH_AUTH_BASE,
  GOOGLE_USERINFO_ENDPOINT,
  defaultGoogleScopes,
  googleOAuthClientId,
  googleOAuthRedirectUri,
  googleOAuthRefreshUrl,
  resolveGoogleOAuthApp,
} from './oauth.config.js';

const OVERRIDDEN_ENV_VARS = [
  CREWLY_GOOGLE_CLIENT_ID_ENV,
  CREWLY_GOOGLE_REDIRECT_URI_ENV,
  CREWLY_GOOGLE_REFRESH_URL_ENV,
];

describe('oauth.config', () => {
  // Every case starts from "Crewly's app is not configured" so that a real
  // value in the developer's own environment cannot change the result.
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of OVERRIDDEN_ENV_VARS) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of OVERRIDDEN_ENV_VARS) {
      const previous = saved.get(name);
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
    saved.clear();
  });

  describe('static endpoints', () => {
    it('exposes https URLs for the shared Google endpoints', () => {
      for (const url of [
        GOOGLE_OAUTH_AUTH_BASE,
        GOOGLE_USERINFO_ENDPOINT,
        GEMINI_CLI_CLOUD_FUNCTION_URL,
      ]) {
        expect(() => new URL(url)).not.toThrow();
        expect(new URL(url).protocol).toBe('https:');
      }
    });

    it('exposes the refresh path as an absolute path', () => {
      expect(GEMINI_CLI_REFRESH_PATH).toMatch(/^\//);
    });
  });

  describe('the borrowed Gemini CLI app', () => {
    it('has a well-formed client_id and https endpoints', () => {
      expect(GEMINI_CLI_OAUTH_APP.clientId).toMatch(
        /\.apps\.googleusercontent\.com$/,
      );
      for (const url of [
        GEMINI_CLI_OAUTH_APP.redirectUri,
        GEMINI_CLI_OAUTH_APP.refreshUrl,
      ]) {
        expect(new URL(url).protocol).toBe('https:');
      }
    });

    // Narrowing this list would silently drop a capability from installs still
    // on the fallback, whose grants were issued against Gemini's consent screen.
    it('keeps the Photos scope its consent screen already granted', () => {
      expect(GEMINI_CLI_GOOGLE_SCOPES).toContain(
        'https://www.googleapis.com/auth/photoslibrary.readonly',
      );
    });
  });

  describe("Crewly's own scopes", () => {
    it('covers the Gmail, Drive, Docs and Calendar scopes the flow needs', () => {
      for (const scope of [
        'openid',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/documents.readonly',
        'https://www.googleapis.com/auth/calendar.events',
      ]) {
        expect(CREWLY_GOOGLE_SCOPES).toContain(scope);
      }
    });

    // Requesting a scope the consent screen does not declare fails the whole
    // authorization, and the Photos Library API is not enabled on the project.
    it('omits the Photos scope, which its consent screen does not declare', () => {
      expect(CREWLY_GOOGLE_SCOPES).not.toContain(
        'https://www.googleapis.com/auth/photoslibrary.readonly',
      );
    });

    it('has no duplicates', () => {
      expect(new Set(CREWLY_GOOGLE_SCOPES).size).toBe(CREWLY_GOOGLE_SCOPES.length);
    });
  });

  describe('resolveGoogleOAuthApp', () => {
    it('falls back to the borrowed app when Crewly has no client_id', () => {
      expect(resolveGoogleOAuthApp()).toEqual(GEMINI_CLI_OAUTH_APP);
    });

    // A variable set to empty or spaces is a half-finished config, not an
    // instruction to use an app with no client_id.
    it.each(['', '   '])(
      'falls back when the client_id is %p',
      (value) => {
        process.env[CREWLY_GOOGLE_CLIENT_ID_ENV] = value;
        expect(resolveGoogleOAuthApp().provider).toBe('gemini-cli');
      },
    );

    it("uses Crewly's app once a client_id is configured", () => {
      process.env[CREWLY_GOOGLE_CLIENT_ID_ENV] = 'crewly-test-client-id';

      const app = resolveGoogleOAuthApp();
      expect(app.provider).toBe('crewly');
      expect(app.clientId).toBe('crewly-test-client-id');
      expect(app.defaultScopes).toBe(CREWLY_GOOGLE_SCOPES);
    });

    it('defaults the redirect and refresh URLs to Crewly Cloud', () => {
      process.env[CREWLY_GOOGLE_CLIENT_ID_ENV] = 'crewly-test-client-id';

      const app = resolveGoogleOAuthApp();
      expect(app.redirectUri).toBe(
        'https://api.crewlyai.com/api/cloud/google/workspace/callback',
      );
      expect(app.refreshUrl).toBe(
        'https://api.crewlyai.com/api/cloud/google/workspace/refresh',
      );
    });

    // A self-hoster pointing at their own project needs both of these.
    it('honours redirect and refresh overrides', () => {
      process.env[CREWLY_GOOGLE_CLIENT_ID_ENV] = 'crewly-test-client-id';
      process.env[CREWLY_GOOGLE_REDIRECT_URI_ENV] =
        'http://localhost:8787/api/cloud/google/workspace/callback';
      process.env[CREWLY_GOOGLE_REFRESH_URL_ENV] =
        'http://localhost:8787/api/cloud/google/workspace/refresh';

      const app = resolveGoogleOAuthApp();
      expect(app.redirectUri).toBe(
        'http://localhost:8787/api/cloud/google/workspace/callback',
      );
      expect(app.refreshUrl).toBe(
        'http://localhost:8787/api/cloud/google/workspace/refresh',
      );
    });

    // Env is read per call, not at import: a process that loads its .env after
    // module resolution must still see the configured app.
    it('reflects a change made after the module was imported', () => {
      expect(resolveGoogleOAuthApp().provider).toBe('gemini-cli');
      process.env[CREWLY_GOOGLE_CLIENT_ID_ENV] = 'crewly-test-client-id';
      expect(resolveGoogleOAuthApp().provider).toBe('crewly');
    });
  });

  describe('accessors', () => {
    it('report the borrowed app by default', () => {
      expect(googleOAuthClientId()).toBe(GEMINI_CLI_OAUTH_APP.clientId);
      expect(googleOAuthRedirectUri()).toBe(GEMINI_CLI_OAUTH_APP.redirectUri);
      expect(googleOAuthRefreshUrl()).toBe(GEMINI_CLI_OAUTH_APP.refreshUrl);
      expect(defaultGoogleScopes()).toBe(GEMINI_CLI_GOOGLE_SCOPES);
    });

    it("report Crewly's app once configured", () => {
      process.env[CREWLY_GOOGLE_CLIENT_ID_ENV] = 'crewly-test-client-id';

      expect(googleOAuthClientId()).toBe('crewly-test-client-id');
      expect(googleOAuthRedirectUri()).toContain('/workspace/callback');
      expect(googleOAuthRefreshUrl()).toContain('/workspace/refresh');
      expect(defaultGoogleScopes()).toBe(CREWLY_GOOGLE_SCOPES);
    });
  });
});
