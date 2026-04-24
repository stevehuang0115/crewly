/**
 * Credentials REST Controller
 *
 * Exposes workspace credential management over REST so the frontend (and
 * Cloud portal) can list, add, rename, delete, and OAuth-import credentials.
 *
 * All endpoints return `{ success, data?, error? }` matching the rest of
 * the Crewly API surface. Secret values (token payloads, API keys) are
 * never returned — only registry metadata.
 *
 * @module controllers/credentials/credentials.controller
 */

import type { Request, Response, NextFunction } from 'express';
import {
  getCredentialStoreService,
  type UpdateCredentialMetadata,
} from '../../services/credential/credential-store.service.js';
import { GeminiCliWorkspaceHelper } from '../../services/credential/helpers/gemini-cli-workspace.helper.js';
import {
  CredentialNotFoundError,
  CredentialRevokedError,
} from '../../types/credential.types.js';
import { LoggerService } from '../../services/core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger(
  'CredentialsController',
);

// ============================================================================
// Helper singleton (lazy)
// ============================================================================

let geminiHelper: GeminiCliWorkspaceHelper | null = null;

function getGeminiHelper(): GeminiCliWorkspaceHelper {
  if (!geminiHelper) {
    geminiHelper = new GeminiCliWorkspaceHelper(getCredentialStoreService());
  }
  return geminiHelper;
}

/** Reset the helper singleton — for tests only. */
export function _resetGeminiHelperForTesting(): void {
  geminiHelper = null;
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/credentials — list all credential metadata (never values).
 */
export async function listCredentials(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const creds = await getCredentialStoreService().listCredentials();
    res.json({ success: true, data: creds });
  } catch (err) {
    logger.error('listCredentials failed', { err });
    next(err);
  }
}

/**
 * GET /api/credentials/:id — metadata for a single credential.
 */
export async function getCredentialById(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const cred = await getCredentialStoreService().getCredential(req.params.id);
    res.json({ success: true, data: cred });
  } catch (err) {
    if (err instanceof CredentialNotFoundError) {
      res.status(404).json({ success: false, error: err.message });
      return;
    }
    logger.error('getCredentialById failed', { err });
    next(err);
  }
}

/**
 * POST /api/credentials/api-key — add an API key credential.
 * Body: { name, provider, value }
 */
export async function addApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { name, provider, value } = (req.body ?? {}) as {
      name?: string;
      provider?: string;
      value?: string;
    };
    if (!name || !provider || !value) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: name, provider, value',
      });
      return;
    }
    const cred = await getCredentialStoreService().addApiKey({
      name,
      provider,
      value,
    });
    logger.info('Added api-key credential', { id: cred.id, provider });
    res.status(201).json({ success: true, data: cred });
  } catch (err) {
    logger.error('addApiKey failed', { err });
    next(err);
  }
}

/**
 * PATCH /api/credentials/:id — update metadata (name, status).
 * Body: { name?, status? }
 */
export async function updateCredentialHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { name, status } = (req.body ?? {}) as {
      name?: string;
      status?: 'active' | 'revoked';
    };
    const patch: UpdateCredentialMetadata = {};
    if (name !== undefined) patch.name = name;
    if (status !== undefined) patch.status = status;
    if (Object.keys(patch).length === 0) {
      res.status(400).json({
        success: false,
        error: 'No valid fields to update (expected: name, status)',
      });
      return;
    }
    const cred = await getCredentialStoreService().updateCredential(
      req.params.id,
      patch,
    );
    res.json({ success: true, data: cred });
  } catch (err) {
    if (err instanceof CredentialNotFoundError) {
      res.status(404).json({ success: false, error: err.message });
      return;
    }
    logger.error('updateCredential failed', { err });
    next(err);
  }
}

/**
 * DELETE /api/credentials/:id — delete credential (registry entry + .enc file).
 */
export async function deleteCredentialHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await getCredentialStoreService().deleteCredential(req.params.id);
    res.json({ success: true });
  } catch (err) {
    if (err instanceof CredentialNotFoundError) {
      res.status(404).json({ success: false, error: err.message });
      return;
    }
    logger.error('deleteCredential failed', { err });
    next(err);
  }
}

/**
 * POST /api/credentials/oauth/import-gemini-cli — capture current extension
 * login into a new credential.
 * Body: { name }
 *
 * Precondition: the user has run
 *   `GEMINI_CLI_WORKSPACE_FORCE_FILE_STORAGE=true gemini`
 * and signed in via the workspace extension.
 */
export async function importOAuthFromGeminiCli(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: name',
      });
      return;
    }

    const payload = await getGeminiHelper().captureFromFile();
    const cred = await getCredentialStoreService().addOAuth({
      name,
      provider: 'google',
      helper: 'gemini-cli-workspace',
      payload,
    });
    logger.info('Imported OAuth credential from gemini-cli', {
      id: cred.id,
      accountEmail: cred.accountEmail,
    });
    res.status(201).json({ success: true, data: cred });
  } catch (err) {
    // captureFromFile produces user-friendly Error messages — surface them
    const message =
      err instanceof Error ? err.message : 'Unknown error during import';
    logger.error('importOAuthFromGeminiCli failed', { err: message });
    res.status(400).json({ success: false, error: message });
  }
}

/**
 * POST /api/credentials/oauth/gemini-cli/clear-extension-file —
 * delete the extension's cached token file so the next extension login
 * captures a different account.
 */
export async function clearGeminiCliExtensionFile(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await getGeminiHelper().clearExtensionFile();
    res.json({ success: true });
  } catch (err) {
    logger.error('clearGeminiCliExtensionFile failed', { err });
    next(err);
  }
}

// ============================================================================
// Headless OAuth flow — for remote users (orchestrator over Slack, etc.)
// ============================================================================

/**
 * OAuth client + endpoint details lifted from the Gemini CLI Workspace
 * extension's `workspace-server/src/utils/config.ts`. Using the same
 * client_id + redirect_uri lets us piggyback on their published OAuth app
 * (so grants don't hit the 7-day testing-mode expiry).
 */
const GOOGLE_OAUTH_CLIENT_ID =
  '338689075775-o75k922vn5fdl18qergr96rp8g63e4d7.apps.googleusercontent.com';
const GOOGLE_OAUTH_REDIRECT_URI =
  'https://google-workspace-extension.geminicli.com';
const GOOGLE_OAUTH_AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';

/**
 * Default scopes — a broad Workspace set covering common needs. Agents
 * can override at start time via the request body.
 */
const DEFAULT_GOOGLE_SCOPES = [
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

/**
 * POST /api/credentials/oauth/google/start
 *
 * Build a Google OAuth URL that the caller can send to a remote user (via
 * Slack, email, etc.). The URL opens on the user's device, they sign in,
 * and the gemini-cli cloud function returns a page showing the credentials
 * JSON for the user to copy back.
 *
 * Body: { scopes?: string[] }    (optional override)
 * Returns: { success, data: { authUrl } }
 */
export async function startGoogleOAuth(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const scopesOverride = (req.body?.scopes as string[] | undefined) ?? undefined;
    const scopes = scopesOverride && scopesOverride.length > 0
      ? scopesOverride
      : DEFAULT_GOOGLE_SCOPES;

    // State payload tells the cloud function to render the manual/copy-paste page
    // (instead of redirecting to a localhost URI, which this flow doesn't use).
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
 * Accept the credentials JSON that the user copied from the OAuth success
 * page, verify it, fetch the account email, and save as a new Crewly
 * credential.
 *
 * Body: {
 *   name: string,
 *   credentialsJson: string | object    (the JSON blob the user pasted)
 * }
 * Returns: { success, data: CredentialRegistryEntry }
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

    // Accept either a parsed object or a raw JSON string
    let parsed: Record<string, unknown>;
    if (typeof credentialsJson === 'string') {
      try {
        parsed = JSON.parse(credentialsJson);
      } catch {
        res.status(400).json({
          success: false,
          error:
            'credentialsJson is not valid JSON. Paste the JSON block from the "Success! Credentials Ready" page exactly as shown.',
        });
        return;
      }
    } else if (typeof credentialsJson === 'object' && credentialsJson !== null) {
      parsed = credentialsJson as Record<string, unknown>;
    } else {
      res.status(400).json({
        success: false,
        error: 'credentialsJson must be a JSON string or object',
      });
      return;
    }

    const accessToken = parsed.access_token as string | undefined;
    const refreshToken = parsed.refresh_token as string | undefined;
    const scope = parsed.scope as string | undefined;
    const tokenType = (parsed.token_type as string | undefined) ?? 'Bearer';
    const expiryDate = parsed.expiry_date as number | undefined;

    if (!accessToken || !refreshToken) {
      res.status(400).json({
        success: false,
        error:
          'credentialsJson is missing access_token or refresh_token. Make sure you copied the entire JSON block.',
      });
      return;
    }

    // Fetch account email from Google userinfo (best-effort)
    let accountEmail: string | undefined;
    try {
      const response = await fetch(
        'https://www.googleapis.com/oauth2/v3/userinfo',
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (response.ok) {
        const info = (await response.json()) as { email?: string };
        accountEmail = info.email;
      }
    } catch {
      // best-effort only — credential is still valid without accountEmail
    }

    const scopes = typeof scope === 'string' ? scope.split(' ').filter(Boolean) : [];

    const cred = await getCredentialStoreService().addOAuth({
      name,
      provider: 'google',
      helper: 'gemini-cli-workspace',
      payload: {
        type: 'google-oauth',
        accessToken,
        refreshToken,
        tokenType: tokenType as 'Bearer',
        expiresAt: expiryDate ?? Date.now() + 3600_000,
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
