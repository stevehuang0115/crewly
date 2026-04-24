/**
 * Headless Google OAuth Controller
 *
 * Implements the "remote user" Google OAuth flow for callers without a
 * terminal (e.g., Slack agents, email). The agent posts to `/oauth/google/start`
 * to get an `authUrl` that the user clicks on any device; the Gemini CLI
 * Workspace cloud function renders the credentials JSON; the agent posts
 * the pasted JSON back to `/oauth/google/complete` to save it as a Crewly
 * credential.
 *
 * This flow is separate from `/oauth/import-gemini-cli` (which reads from
 * the on-box extension's token file) and lives in its own module so the
 * credentials CRUD controller stays focused.
 *
 * @module controllers/credentials/google-oauth.controller
 */

import type { Request, Response, NextFunction } from 'express';

import { getCredentialStoreService } from '../../services/credential/credential-store.service.js';
import { LoggerService } from '../../services/core/logger.service.js';
import {
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_REDIRECT_URI,
  GOOGLE_OAUTH_AUTH_BASE,
  DEFAULT_GOOGLE_SCOPES,
} from '../../config/oauth.config.js';
import { fetchGoogleAccountEmail } from '../../utils/google-userinfo.utils.js';

const logger = LoggerService.getInstance().createComponentLogger(
  'GoogleOAuthController',
);

/**
 * Default access-token lifetime to assume when Google does not return
 * `expiry_date` on the credentials JSON (1h matches Google's typical
 * access-token TTL).
 */
const DEFAULT_ACCESS_TOKEN_TTL_MS = 3600_000;

/**
 * POST /api/credentials/oauth/google/start
 *
 * Build a Google OAuth URL that the caller can send to a remote user (via
 * Slack, email, etc.). The URL opens on the user's device, they sign in,
 * and the cloud function returns a page showing the credentials JSON for
 * the user to copy back.
 *
 * Body: `{ scopes?: string[] }` — optional scope override
 * Returns: `{ success, data: { authUrl } }`
 */
export async function startGoogleOAuth(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const scopesOverride = (req.body?.scopes as string[] | undefined) ?? undefined;
    const scopes =
      scopesOverride && scopesOverride.length > 0
        ? scopesOverride
        : DEFAULT_GOOGLE_SCOPES;

    // state payload tells the cloud function to render the manual/copy-paste
    // page (instead of redirecting to a localhost URI, which this flow doesn't
    // use).
    const statePayload = { manual: true };
    const state = Buffer.from(JSON.stringify(statePayload)).toString('base64');

    const params = new URLSearchParams({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
      response_type: 'code',
      scope: scopes.join(' '),
      state,
      access_type: 'offline',
      prompt: 'consent',
    });

    const authUrl = `${GOOGLE_OAUTH_AUTH_BASE}?${params.toString()}`;
    res.json({ success: true, data: { authUrl } });
  } catch (err) {
    logger.error('startGoogleOAuth failed', { err });
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Failed to build OAuth URL',
    });
  }
}

/**
 * POST /api/credentials/oauth/google/complete
 *
 * Accept the credentials JSON the user copied from the OAuth success page,
 * verify it, fetch the account email, and save as a new Crewly credential.
 *
 * Body: `{ name: string, credentialsJson: string | object }`
 * Returns: `{ success, data: CredentialRegistryEntry }`
 */
export async function completeGoogleOAuth(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const { name, credentialsJson } = (req.body ?? {}) as {
      name?: string;
      credentialsJson?: unknown;
    };

    if (!name || !credentialsJson) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: name, credentialsJson',
      });
      return;
    }

    const parsed = parseCredentialsJson(credentialsJson);
    if (!parsed.ok) {
      res.status(400).json({ success: false, error: parsed.error });
      return;
    }

    const accessToken = parsed.value.access_token as string | undefined;
    const refreshToken = parsed.value.refresh_token as string | undefined;
    const scope = parsed.value.scope as string | undefined;
    const tokenType = (parsed.value.token_type as string | undefined) ?? 'Bearer';
    const expiryDate = parsed.value.expiry_date as number | undefined;

    if (!accessToken || !refreshToken) {
      res.status(400).json({
        success: false,
        error:
          'credentialsJson is missing access_token or refresh_token. Make sure you copied the entire JSON block.',
      });
      return;
    }

    const accountEmail = await fetchGoogleAccountEmail(accessToken);
    const scopes =
      typeof scope === 'string' ? scope.split(' ').filter(Boolean) : [];

    const cred = await getCredentialStoreService().addOAuth({
      name,
      provider: 'google',
      helper: 'gemini-cli-workspace',
      payload: {
        type: 'google-oauth',
        accessToken,
        refreshToken,
        tokenType: tokenType as 'Bearer',
        expiresAt: expiryDate ?? Date.now() + DEFAULT_ACCESS_TOKEN_TTL_MS,
        scopes,
        accountEmail,
        clientId: GOOGLE_OAUTH_CLIENT_ID,
      },
    });

    logger.info('Completed headless Google OAuth', {
      id: cred.id,
      accountEmail,
    });

    res.status(201).json({ success: true, data: cred });
  } catch (err) {
    logger.error('completeGoogleOAuth failed', { err });
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Failed to save credential',
    });
  }
}

/** Result of parsing the `credentialsJson` field from a request body. */
type ParsedCredentialsJson =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Normalize `credentialsJson` to a parsed object. Accepts either a JSON
 * string or an already-parsed object. Returns a discriminated result so
 * callers can surface precise 400 messages to the user.
 */
function parseCredentialsJson(input: unknown): ParsedCredentialsJson {
  if (typeof input === 'string') {
    try {
      return { ok: true, value: JSON.parse(input) as Record<string, unknown> };
    } catch {
      return {
        ok: false,
        error:
          'credentialsJson is not valid JSON. Paste the JSON block from the "Success! Credentials Ready" page exactly as shown.',
      };
    }
  }
  if (typeof input === 'object' && input !== null) {
    return { ok: true, value: input as Record<string, unknown> };
  }
  return {
    ok: false,
    error: 'credentialsJson must be a JSON string or object',
  };
}
