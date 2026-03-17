/**
 * Relay REST Routes
 *
 * Router configuration for relay client endpoints.
 * Server-side relay management has been moved to the cloud services repository.
 *
 * Client-side endpoints (require cloud connection + Pro plan):
 * - POST /connect     - Connect to a remote relay server
 * - POST /disconnect  - Disconnect from the relay server
 * - GET  /devices     - List paired/connected devices
 * - POST /send        - Send a message to the paired peer
 *
 * @module controllers/cloud/relay.routes
 */

import { Router } from 'express';
import {
  connectToRelay,
  disconnectFromRelay,
  getRelayDevices,
  getCloudDevices,
  sendRelayMessage,
} from './relay.controller.js';
import { requireCloudConnection, requireTier } from '../../services/cloud/cloud-auth.middleware.js';

/**
 * Creates the relay router with client-side relay endpoints.
 *
 * All endpoints require a cloud connection and a Pro plan,
 * since Cloud Relay is a paid feature.
 *
 * @returns Express router configured with relay routes
 */
export function createRelayRouter(): Router {
  const router = Router();

  router.post('/connect', requireCloudConnection, requireTier('pro'), connectToRelay);
  router.post('/disconnect', requireCloudConnection, requireTier('pro'), disconnectFromRelay);
  router.get('/devices', requireCloudConnection, requireTier('pro'), getRelayDevices);
  router.post('/send', requireCloudConnection, requireTier('pro'), sendRelayMessage);
  router.get('/cloud-devices', requireCloudConnection, getCloudDevices);

  return router;
}
