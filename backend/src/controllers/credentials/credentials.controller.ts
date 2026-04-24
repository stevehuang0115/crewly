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
    const body = (req.body ?? {}) as {
      name?: unknown;
      provider?: unknown;
      value?: unknown;
    };
    if (
      typeof body.name !== 'string' ||
      body.name.length === 0 ||
      typeof body.provider !== 'string' ||
      body.provider.length === 0 ||
      typeof body.value !== 'string' ||
      body.value.length === 0
    ) {
      res.status(400).json({
        success: false,
        error:
          'Missing or invalid required fields: name (string), provider (string), value (string)',
      });
      return;
    }
    const cred = await getCredentialStoreService().addApiKey({
      name: body.name,
      provider: body.provider,
      value: body.value,
    });
    logger.info('Added api-key credential', { id: cred.id, provider: body.provider });
    res.status(201).json({ success: true, data: cred });
  } catch (err) {
    logger.error('addApiKey failed', { err });
    next(err);
  }
}

/** Lifecycle statuses a client may assign via PATCH. */
const ALLOWED_STATUSES: ReadonlySet<string> = new Set(['active', 'revoked']);

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
    const body = (req.body ?? {}) as { name?: unknown; status?: unknown };
    const patch: UpdateCredentialMetadata = {};

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.length === 0) {
        res.status(400).json({
          success: false,
          error: 'name must be a non-empty string',
        });
        return;
      }
      patch.name = body.name;
    }

    if (body.status !== undefined) {
      if (
        typeof body.status !== 'string' ||
        !ALLOWED_STATUSES.has(body.status)
      ) {
        res.status(400).json({
          success: false,
          error: `status must be one of: ${[...ALLOWED_STATUSES].join(', ')}`,
        });
        return;
      }
      patch.status = body.status as 'active' | 'revoked';
    }

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

// Headless OAuth endpoints (startGoogleOAuth, completeGoogleOAuth) live in
// ./google-oauth.controller.ts — wired into the router below.
