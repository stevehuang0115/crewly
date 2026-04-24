/**
 * Tests for oauth.config — sanity-check the constants are non-empty and
 * well-formed URLs / scope strings.
 */

import {
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_REDIRECT_URI,
  GOOGLE_OAUTH_AUTH_BASE,
  GEMINI_CLI_CLOUD_FUNCTION_URL,
  GEMINI_CLI_REFRESH_PATH,
  GOOGLE_USERINFO_ENDPOINT,
  DEFAULT_GOOGLE_SCOPES,
} from './oauth.config.js';

describe('oauth.config', () => {
  it('client_id is non-empty and ends with .apps.googleusercontent.com', () => {
    expect(GOOGLE_OAUTH_CLIENT_ID).toBeTruthy();
    expect(GOOGLE_OAUTH_CLIENT_ID).toMatch(/\.apps\.googleusercontent\.com$/);
  });

  it('auth base, redirect URI, userinfo endpoint are https URLs', () => {
    for (const url of [
      GOOGLE_OAUTH_REDIRECT_URI,
      GOOGLE_OAUTH_AUTH_BASE,
      GEMINI_CLI_CLOUD_FUNCTION_URL,
      GOOGLE_USERINFO_ENDPOINT,
    ]) {
      expect(() => new URL(url)).not.toThrow();
      expect(new URL(url).protocol).toBe('https:');
    }
  });

  it('refresh path is an absolute path', () => {
    expect(GEMINI_CLI_REFRESH_PATH).toMatch(/^\//);
  });

  it('default scopes is non-empty and contains openid + email + core Google scopes', () => {
    expect(DEFAULT_GOOGLE_SCOPES.length).toBeGreaterThan(0);
    expect(DEFAULT_GOOGLE_SCOPES).toContain('openid');
    expect(DEFAULT_GOOGLE_SCOPES).toContain(
      'https://www.googleapis.com/auth/userinfo.email',
    );
    expect(DEFAULT_GOOGLE_SCOPES).toContain(
      'https://www.googleapis.com/auth/gmail.readonly',
    );
  });

  it('default scopes are unique', () => {
    const deduped = new Set(DEFAULT_GOOGLE_SCOPES);
    expect(deduped.size).toBe(DEFAULT_GOOGLE_SCOPES.length);
  });
});
