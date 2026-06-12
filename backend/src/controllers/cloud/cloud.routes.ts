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
 * - GET  /device-id            - Get persistent device UUID and hostname
 * - GET  /devices              - Get device list from CloudSync (or fallback to legacy)
 * - GET  /templates            - Fetch premium templates (requires connection)
 * - GET  /license/verify       - Verify license and return tier + features
 * - POST /send                 - Send a message to another device via Cloud Sync
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
  sendCloudMessage,
  getDeviceId,
  getDevicesFromSync,
  verifyLicense,
  mobilePair,
} from './cloud.controller.js';
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
  router.get('/device-id', getDeviceId);
  router.get('/devices', getDevicesFromSync);
  router.post('/send', sendCloudMessage);
  router.get('/templates', getCloudTemplates);
  router.get('/license/verify', verifyLicense);
  // Mobile-app LAN pairing — adopt this OSS's cloud session (see mobilePair).
  router.post('/mobile-pair', mobilePair);

  // Google OAuth login flow — browser-redirect (GET)
  router.get('/google/start', cloudGoogleStart);
  router.get('/google/callback', cloudGoogleCallback);

  // Google OAuth login flow — SPA JSON API (POST)
  router.post('/google/url', cloudGoogleUrl);
  router.post('/google/callback', cloudGoogleCallbackPost);

  return router;
}
