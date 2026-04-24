/**
 * Tests for backend/src/constants.ts.
 *
 * `constants.ts` is a large central config file. Rather than asserting on
 * every value (which would just duplicate the source), this test focuses on
 * the constants where wrong values would silently break a flow — most
 * critically the OAuth scope set used to issue new Google credentials.
 */
import {
  GOOGLE_OAUTH_CONSTANTS,
} from './constants.js';

describe('GOOGLE_OAUTH_CONSTANTS', () => {
  describe('DEFAULT_SCOPES', () => {
    const scopes = GOOGLE_OAUTH_CONSTANTS.DEFAULT_SCOPES;

    it('uses gmail.modify as the single Gmail scope so all 9 actions of the agent gmail skill work without re-auth', () => {
      // gmail.modify is a Google-side functional superset that covers
      // gmail.readonly + gmail.send + label/state mutations. Crewly's
      // skill-executor does string-exact scope matching, so declaring
      // gmail.modify alone is what makes the agent gmail skill (which
      // requires gmail.modify) accept credentials minted via this flow.
      const gmailScopes = scopes.filter((s) => s.includes('gmail'));
      expect(gmailScopes).toEqual(['https://www.googleapis.com/auth/gmail.modify']);
    });

    it('does NOT request gmail.readonly or gmail.send separately (gmail.modify covers them)', () => {
      expect(scopes).not.toContain('https://www.googleapis.com/auth/gmail.readonly');
      expect(scopes).not.toContain('https://www.googleapis.com/auth/gmail.send');
    });

    it('includes openid + email for user identity resolution', () => {
      expect(scopes).toContain('openid');
      expect(scopes).toContain('email');
    });

    it('is non-empty (defaults must be populated)', () => {
      expect(scopes.length).toBeGreaterThan(0);
    });
  });

  describe('endpoint URLs', () => {
    it('points AUTH_BASE_URL at Google production OAuth endpoint', () => {
      expect(GOOGLE_OAUTH_CONSTANTS.AUTH_BASE_URL).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth',
      );
    });

    it('points TOKEN_ENDPOINT at the Google token endpoint', () => {
      expect(GOOGLE_OAUTH_CONSTANTS.TOKEN_ENDPOINT).toBe(
        'https://oauth2.googleapis.com/token',
      );
    });

    it('points USERINFO_ENDPOINT at the Google userinfo endpoint', () => {
      expect(GOOGLE_OAUTH_CONSTANTS.USERINFO_ENDPOINT).toBe(
        'https://www.googleapis.com/oauth2/v2/userinfo',
      );
    });
  });

  describe('WORKSPACE_SCOPES', () => {
    it('exposes a broader workspace set for skills that need Drive/Calendar/Docs', () => {
      // This is intentionally separate from DEFAULT_SCOPES — skills that
      // need broader access can request these via the explicit override
      // path on /credentials/oauth/google/start.
      const ws = GOOGLE_OAUTH_CONSTANTS.WORKSPACE_SCOPES;
      expect(Array.isArray(ws)).toBe(true);
      expect(ws.length).toBeGreaterThan(0);
    });
  });
});
