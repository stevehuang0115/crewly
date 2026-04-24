/**
 * Credentials REST Routes
 *
 * Wires `/api/credentials/*` endpoints to their controller handlers.
 *
 * @module controllers/credentials/credentials.routes
 */

import { Router } from 'express';
import {
  listCredentials,
  getCredentialById,
  addApiKey,
  updateCredentialHandler,
  deleteCredentialHandler,
  importOAuthFromGeminiCli,
  clearGeminiCliExtensionFile,
} from './credentials.controller.js';
import {
  startGoogleOAuth,
  completeGoogleOAuth,
} from './google-oauth.controller.js';

/**
 * Create the credentials router.
 *
 * Endpoints:
 * - GET    /                                     — list all credentials (metadata only)
 * - GET    /:id                                  — get one credential (metadata only)
 * - POST   /api-key                              — add an api-key credential
 * - PATCH  /:id                                  — update name/status
 * - DELETE /:id                                  — delete credential
 * - POST   /oauth/import-gemini-cli              — import from gemini-cli workspace extension
 * - POST   /oauth/gemini-cli/clear-extension-file — clear the extension's cached token (to enable next-account login)
 *
 * Mounted at `/api/credentials` in `api.routes.ts`.
 *
 * @returns Express router with all credential endpoints
 */
export function createCredentialsRouter(): Router {
  const router = Router();

  router.get('/', listCredentials);

  // Specific routes before /:id to avoid pattern conflicts
  router.post('/api-key', addApiKey);
  router.post('/oauth/import-gemini-cli', importOAuthFromGeminiCli);
  router.post('/oauth/gemini-cli/clear-extension-file', clearGeminiCliExtensionFile);
  router.post('/oauth/google/start', startGoogleOAuth);
  router.post('/oauth/google/complete', completeGoogleOAuth);

  router.get('/:id', getCredentialById);
  router.patch('/:id', updateCredentialHandler);
  router.delete('/:id', deleteCredentialHandler);

  return router;
}
