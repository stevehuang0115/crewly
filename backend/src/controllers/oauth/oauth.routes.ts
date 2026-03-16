import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { GOOGLE_OAUTH_CONSTANTS } from '../../constants.js';
import { UserIdentityService } from '../../services/user/user-identity.service.js';
import { LoggerService } from '../../services/core/logger.service.js';

/**
 * Build Google OAuth client config from environment variables.
 *
 * @param req - Express request (used to derive the default redirect URI)
 * @returns Object with clientId, clientSecret, and redirectUri
 */
function getGoogleConfig(req: Request): { clientId: string; clientSecret: string; redirectUri: string } {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/oauth/google/callback`;
  return { clientId, clientSecret, redirectUri };
}

/**
 * Create the OAuth API router.
 *
 * Provides Google OAuth start and callback endpoints for connecting
 * user accounts to Google services.
 *
 * @returns Express Router with OAuth routes
 */
export function createOAuthRouter(): Router {
  const router = Router();
  const users = UserIdentityService.getInstance();
  const logger = LoggerService.getInstance().createComponentLogger('OAuthRoutes');

  router.get('/google/start', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { clientId, redirectUri } = getGoogleConfig(req);
      if (!clientId) {
        res.status(500).json({ success: false, error: 'GOOGLE_OAUTH_CLIENT_ID is not configured' });
        return;
      }

      const slackUserId = req.query.slackUserId ? String(req.query.slackUserId) : undefined;
      
      // Determine scopes: prefer query param, fallback to default
      let requestedScopes = GOOGLE_OAUTH_CONSTANTS.DEFAULT_SCOPES;
      if (req.query.scopes) {
        const scopesStr = String(req.query.scopes);
        // Handle both comma-separated and space-separated input
        requestedScopes = scopesStr.split(/[ ,]+/).filter(Boolean) as any;
      }

      const statePayload = {
        slackUserId,
        t: Date.now(),
        nonce: crypto.randomUUID(),
      };
      const state = Buffer.from(JSON.stringify(statePayload)).toString('base64url');

      const url = new URL(GOOGLE_OAUTH_CONSTANTS.AUTH_BASE_URL);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('prompt', 'consent');
      url.searchParams.set('scope', requestedScopes.join(' '));
      url.searchParams.set('state', state);

      res.json({ success: true, data: { authUrl: url.toString(), state } });
    } catch (error) {
      next(error);
    }
  });

  router.get('/google/callback', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const code = req.query.code ? String(req.query.code) : '';
      const state = req.query.state ? String(req.query.state) : '';
      if (!code) {
        res.status(400).json({ success: false, error: 'Missing code' });
        return;
      }

      const { clientId, clientSecret, redirectUri } = getGoogleConfig(req);
      if (!clientId || !clientSecret) {
        res.status(500).json({ success: false, error: 'Google OAuth credentials are not configured' });
        return;
      }

      const tokenResp = await fetch(GOOGLE_OAUTH_CONSTANTS.TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });

      if (!tokenResp.ok) {
        const details = await tokenResp.text();
        res.status(400).json({ success: false, error: `Failed to exchange OAuth code: ${details}` });
        return;
      }

      const tokenData = await tokenResp.json() as {
        access_token: string;
        refresh_token?: string;
        scope?: string;
        token_type?: string;
      };

      const profileResp = await fetch(GOOGLE_OAUTH_CONSTANTS.USERINFO_ENDPOINT, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });

      if (!profileResp.ok) {
        const details = await profileResp.text();
        res.status(400).json({ success: false, error: `Failed to load Google profile: ${details}` });
        return;
      }

      const profile = await profileResp.json() as { email?: string };
      if (!profile.email) {
        res.status(400).json({ success: false, error: 'Google profile did not include email' });
        return;
      }

      let statePayload: { slackUserId?: string } = {};
      if (state) {
        try {
          statePayload = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
        } catch (err) {
          logger.warn('Failed to parse OAuth state parameter', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const user = await users.createOrUpdateUser({
        email: profile.email,
        slackUserId: statePayload.slackUserId,
      });

      if (!tokenData.refresh_token) {
        logger.warn('Google OAuth did not return a refresh_token — using access_token as fallback', {
          email: profile.email,
        });
      }

      await users.connectService(user.id, 'google', {
        refreshToken: tokenData.refresh_token || tokenData.access_token,
        accessToken: tokenData.access_token,
        scopes: (tokenData.scope || '').split(' ').filter(Boolean),
      });

      res.json({
        success: true,
        data: {
          userId: user.id,
          email: user.email,
          connectedProvider: 'google',
          slackUserId: user.slackUserId,
        },
        message: 'Google OAuth connected successfully',
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
