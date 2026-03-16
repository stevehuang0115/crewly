/**
 * Cloud Google OAuth Controller
 *
 * Handles Google OAuth login flow for the CrewlyAI Cloud Portal.
 * Provides both browser-redirect (GET) and API (POST) flows.
 *
 * Routes:
 * - GET  /api/cloud/google/start    -> Redirects to Google consent screen
 * - GET  /api/cloud/google/callback  -> Handles Google redirect, issues JWT, redirects to frontend
 * - POST /api/cloud/google/url       -> Returns Google OAuth URL as JSON (for SPA clients)
 * - POST /api/cloud/google/callback  -> Exchanges code for JWT, returns JSON (for SPA clients)
 *
 * @module controllers/cloud/cloud-google-auth.controller
 */

import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { GOOGLE_OAUTH_CONSTANTS, AUTH_CONSTANTS, CLOUD_AUTH_CONSTANTS } from '../../constants.js';
import { UserIdentityService } from '../../services/user/user-identity.service.js';
import { LoggerService } from '../../services/core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('CloudGoogleAuth');

/** Env var for the Cloud Portal frontend URL (where to redirect after login). */
const CLOUD_PORTAL_FRONTEND_URL = (): string =>
  process.env['CLOUD_PORTAL_URL'] || 'https://crewlyai.com';

/** Env var for the Google OAuth redirect URI (must match GCP console). */
const CLOUD_GOOGLE_REDIRECT_URI = (req: Request): string =>
  process.env['CLOUD_GOOGLE_REDIRECT_URI'] ||
  `${req.protocol}://${req.get('host')}/api/cloud/google/callback`;

/** Scopes for Cloud Portal login -- only need email and profile. */
const LOGIN_SCOPES = ['openid', 'email', 'profile'];

/** Default user plan assigned to new users. */
const DEFAULT_USER_PLAN = AUTH_CONSTANTS.PLANS.FREE;

// ---------------------------------------------------------------------------
// Shared helpers (R1-01, R1-02)
// ---------------------------------------------------------------------------

/** Result of exchanging a Google auth code for tokens and user profile. */
interface GoogleLoginResult {
  user: { id: string; createdAt?: string };
  profile: { email: string; name?: string; picture?: string };
  tokenData: { access_token: string; refresh_token?: string };
}

/**
 * Build a Google OAuth consent URL with the given post-login redirect.
 *
 * Consolidates URL construction used by both cloudGoogleStart and cloudGoogleUrl.
 *
 * @param req - Express request (used to derive redirect_uri)
 * @param postLoginRedirect - Where to send user after login completes
 * @returns Full Google OAuth consent URL string
 * @throws Error if GOOGLE_CLIENT_ID is not configured
 */
function buildGoogleOAuthUrl(req: Request, postLoginRedirect: string): string {
  const clientId = CLOUD_AUTH_CONSTANTS.GOOGLE.CLIENT_ID;
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID is not configured');

  const redirectUri = CLOUD_GOOGLE_REDIRECT_URI(req);
  const statePayload = {
    redirectTo: postLoginRedirect,
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
  url.searchParams.set('scope', LOGIN_SCOPES.join(' '));
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * Exchange a Google authorization code for tokens, fetch user profile,
 * and upsert the user in the local identity store.
 *
 * Shared by both GET and POST callback handlers.
 *
 * @param code - Google authorization code
 * @param req - Express request (used to derive redirect_uri)
 * @returns GoogleLoginResult with user, profile, and token data
 * @throws Error on credential misconfiguration, token exchange failure, or missing profile data
 */
async function exchangeCodeAndCreateUser(code: string, req: Request): Promise<GoogleLoginResult> {
  const clientId = CLOUD_AUTH_CONSTANTS.GOOGLE.CLIENT_ID;
  const clientSecret = process.env['GOOGLE_CLIENT_SECRET'] || '';

  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth credentials not configured');
  }

  const redirectUri = CLOUD_GOOGLE_REDIRECT_URI(req);

  // Exchange code for tokens
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
    logger.error('Failed to exchange Google OAuth code', { status: tokenResp.status, details });
    throw new Error(`token_exchange_failed: ${tokenResp.status}`);
  }

  const tokenData = (await tokenResp.json()) as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
  };

  // Fetch Google profile
  const profileResp = await fetch(GOOGLE_OAUTH_CONSTANTS.USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (!profileResp.ok) {
    logger.error('Failed to fetch Google profile', { status: profileResp.status });
    throw new Error(`profile_fetch_failed: ${profileResp.status}`);
  }

  const profile = (await profileResp.json()) as {
    email?: string;
    name?: string;
    picture?: string;
  };

  if (!profile.email) {
    throw new Error('no_email');
  }

  // Create or find user and store tokens
  const users = UserIdentityService.getInstance();
  const user = await users.createOrUpdateUser({ email: profile.email });

  if (tokenData.refresh_token || tokenData.access_token) {
    await users.connectService(user.id, 'google', {
      refreshToken: tokenData.refresh_token || tokenData.access_token,
      accessToken: tokenData.access_token,
      scopes: LOGIN_SCOPES,
    });
  }

  return {
    user,
    profile: { email: profile.email, name: profile.name, picture: profile.picture },
    tokenData: { access_token: tokenData.access_token, refresh_token: tokenData.refresh_token },
  };
}

/**
 * Sign a JWT using HMAC-SHA256.
 *
 * @param payload - JWT payload object
 * @returns Signed JWT string (header.payload.signature)
 */
export function signJwt(payload: Record<string, unknown>): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', AUTH_CONSTANTS.JWT.DEFAULT_SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');
  return `${headerB64}.${payloadB64}.${signature}`;
}

/**
 * Verify a JWT signed with HMAC-SHA256.
 *
 * @param token - JWT string (header.payload.signature)
 * @returns Decoded payload if valid, null if invalid or expired
 */
export function verifyJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signature] = parts;
    const expectedSig = crypto
      .createHmac('sha256', AUTH_CONSTANTS.JWT.DEFAULT_SECRET)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url');

    if (signature !== expectedSig) return null;

    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8'));

    // Check expiry
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/cloud/google/start
 *
 * Redirects the browser to the Google OAuth consent screen.
 *
 * @param req - Express request with optional query: { redirect }
 * @param res - Express response (302 redirect)
 * @param next - Next function for error propagation
 */
export async function cloudGoogleStart(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const postLoginRedirect = req.query['redirect'] ? String(req.query['redirect']) : '';
    const url = buildGoogleOAuthUrl(req, postLoginRedirect);

    logger.info('Redirecting to Google OAuth consent screen');
    res.redirect(url);
  } catch (error) {
    if (error instanceof Error && error.message.includes('GOOGLE_CLIENT_ID')) {
      res.status(500).json({ success: false, error: error.message });
      return;
    }
    logger.error('Failed to initiate Google OAuth', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * GET /api/cloud/google/callback
 *
 * Handles the Google OAuth redirect, exchanges code, issues JWT, and redirects.
 *
 * @param req - Express request with query: { code, state? }
 * @param res - Express response (302 redirect to frontend)
 * @param next - Next function for error propagation
 */
export async function cloudGoogleCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const code = req.query['code'] ? String(req.query['code']) : '';
    const state = req.query['state'] ? String(req.query['state']) : '';
    const errorParam = req.query['error'] ? String(req.query['error']) : '';

    const portalUrl = CLOUD_PORTAL_FRONTEND_URL();

    if (errorParam) {
      logger.warn('Google OAuth returned error', { error: errorParam });
      res.redirect(`${portalUrl}/login?error=${encodeURIComponent(errorParam)}`);
      return;
    }

    if (!code) {
      logger.warn('Google OAuth callback missing code');
      res.redirect(`${portalUrl}/login?error=missing_code`);
      return;
    }

    let result: GoogleLoginResult;
    try {
      result = await exchangeCodeAndCreateUser(code, req);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('Google OAuth exchange failed', { error: errMsg });
      const errorCode = errMsg.split(':')[0] || 'exchange_failed';
      res.redirect(`${portalUrl}/login?error=${encodeURIComponent(errorCode)}`);
      return;
    }

    // Issue JWT
    const now = Math.floor(Date.now() / 1000);
    const accessToken = signJwt({
      sub: result.user.id,
      email: result.profile.email,
      name: result.profile.name || '',
      plan: DEFAULT_USER_PLAN,
      iat: now,
      exp: now + AUTH_CONSTANTS.JWT.ACCESS_TOKEN_EXPIRY_S,
      iss: AUTH_CONSTANTS.JWT.ISSUER,
      type: 'access',
    });

    // Parse state for post-login redirect
    let postLoginRedirect = '';
    if (state) {
      try {
        const parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as { redirectTo?: string; redirect?: string };
        postLoginRedirect = parsed.redirectTo || parsed.redirect || '';
      } catch {
        logger.warn('Failed to parse OAuth state parameter');
      }
    }

    const finalRedirect = postLoginRedirect || portalUrl;
    const separator = finalRedirect.includes('?') ? '&' : '?';

    logger.info('Cloud Google OAuth login successful', { email: result.profile.email, userId: result.user.id });
    res.redirect(`${finalRedirect}${separator}token=${accessToken}`);
  } catch (error) {
    logger.error('Cloud Google OAuth callback error', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * POST /api/cloud/google/url
 *
 * Returns the Google OAuth consent URL as JSON (for SPA clients).
 *
 * @param req - Request with optional body: { redirectTo, redirectUrl }
 * @param res - Response returning { success, data: { url } }
 * @param next - Next function for error propagation
 */
export async function cloudGoogleUrl(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const postLoginRedirect = req.body?.redirectTo || req.body?.redirectUrl || '';
    const url = buildGoogleOAuthUrl(req, postLoginRedirect);

    logger.info('Returning Google OAuth URL for SPA client');
    res.json({ success: true, data: { url } });
  } catch (error) {
    if (error instanceof Error && error.message.includes('GOOGLE_CLIENT_ID')) {
      res.status(500).json({ success: false, error: error.message });
      return;
    }
    logger.error('Failed to generate Google OAuth URL', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

/**
 * POST /api/cloud/google/callback
 *
 * SPA-friendly code exchange: accepts { code } in body, returns JWT + user as JSON.
 *
 * @param req - Request with body: { code }
 * @param res - Response returning { success, data: { accessToken, refreshToken, expiresIn, user } }
 * @param next - Next function for error propagation
 */
export async function cloudGoogleCallbackPost(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { code } = req.body;
    if (!code) {
      res.status(400).json({ success: false, error: 'Missing authorization code' });
      return;
    }

    const result = await exchangeCodeAndCreateUser(code, req);

    // Issue access token
    const now = Math.floor(Date.now() / 1000);
    const accessToken = signJwt({
      sub: result.user.id,
      email: result.profile.email,
      name: result.profile.name || '',
      plan: DEFAULT_USER_PLAN,
      iat: now,
      exp: now + AUTH_CONSTANTS.JWT.ACCESS_TOKEN_EXPIRY_S,
      iss: AUTH_CONSTANTS.JWT.ISSUER,
      type: 'access',
    });

    // Issue refresh token (longer lived, carries user claims for token refresh)
    const refreshToken = signJwt({
      sub: result.user.id,
      email: result.profile.email,
      name: result.profile.name || '',
      plan: DEFAULT_USER_PLAN,
      iat: now,
      exp: now + AUTH_CONSTANTS.JWT.REFRESH_TOKEN_EXPIRY_S,
      iss: AUTH_CONSTANTS.JWT.ISSUER,
      type: 'refresh',
    });

    logger.info('Cloud Google OAuth login successful (POST)', { email: result.profile.email, userId: result.user.id });
    res.json({
      success: true,
      data: {
        accessToken,
        refreshToken,
        expiresIn: AUTH_CONSTANTS.JWT.ACCESS_TOKEN_EXPIRY_S,
        user: {
          id: result.user.id,
          email: result.profile.email,
          displayName: result.profile.name || '',
          plan: DEFAULT_USER_PLAN,
          createdAt: result.user.createdAt || '',
        },
      },
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (errMsg.includes('credentials not configured')) {
      res.status(500).json({ success: false, error: 'Google OAuth credentials not configured' });
      return;
    }
    if (errMsg.startsWith('token_exchange_failed') || errMsg.startsWith('profile_fetch_failed') || errMsg === 'no_email') {
      res.status(400).json({ success: false, error: errMsg.includes(':') ? errMsg.split(':')[0]! : errMsg });
      return;
    }
    logger.error('Cloud Google OAuth callback (POST) error', { error: errMsg });
    next(error);
  }
}
