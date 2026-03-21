/**
 * Cloud REST Routes
 *
 * Router configuration for CrewlyAI Cloud integration endpoints.
 *
 * Endpoints:
 * - POST /connect              - Connect to CrewlyAI Cloud
 * - POST /disconnect           - Disconnect from CrewlyAI Cloud
 * - POST /validate             - Validate JWT (local verification + optional proxy)
 * - GET  /status               - Get connection status and subscription tier
 * - GET  /devices              - Get device list from CloudSync (or fallback to legacy)
 * - GET  /templates            - Fetch premium templates (requires connection)
 * - GET  /google/start         - Redirect to Google OAuth consent screen
 * - GET  /google/callback      - Handle Google OAuth callback, issue JWT, redirect to frontend
 * - POST /google/url           - Return Google OAuth URL as JSON (SPA client flow)
 * - POST /google/callback      - Exchange code for JWT, return JSON (SPA client flow)
 *
 * @module controllers/cloud/cloud.routes
 */

import { Router } from 'express';
import {
  connectToCloud,
  disconnectFromCloud,
  getCloudStatus,
  getCloudTemplates,
  validateCloudToken,
  refreshCloudToken,
} from './cloud.controller.js';
import { getDevicesFromSync } from './relay.controller.js';
import {
  cloudGoogleStart,
  cloudGoogleCallback,
  cloudGoogleUrl,
  cloudGoogleCallbackPost,
} from './cloud-google-auth.controller.js';

/**
 * Creates the cloud router with all CrewlyAI Cloud endpoints.
 *
 * @returns Express router configured with cloud routes
 */
export function createCloudRouter(): Router {
  const router = Router();

  router.post('/connect', connectToCloud);
  router.post('/disconnect', disconnectFromCloud);
  router.post('/validate', validateCloudToken);
  router.post('/refresh', refreshCloudToken);
  router.get('/status', getCloudStatus);
  router.get('/devices', getDevicesFromSync);
  router.get('/templates', getCloudTemplates);

  // Google OAuth login flow — browser-redirect (GET)
  router.get('/google/start', cloudGoogleStart);
  router.get('/google/callback', cloudGoogleCallback);

  // Google OAuth login flow — SPA JSON API (POST)
  router.post('/google/url', cloudGoogleUrl);
  router.post('/google/callback', cloudGoogleCallbackPost);

  return router;
}
