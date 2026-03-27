/**
 * Marketplace REST Routes
 *
 * Router configuration for marketplace-related endpoints. Provides REST access
 * to the marketplace service for browsing, installing, updating, and
 * uninstalling marketplace items.
 *
 * @module controllers/marketplace/marketplace.routes
 */

import { Router } from 'express';
import {
  handleListItems,
  handleListInstalled,
  handleListUpdates,
  handleGetItem,
  handleRefresh,
  handleInstall,
  handleUninstall,
  handleUpdate,
  handleSubmit,
  handleListSubmissions,
  handleGetSubmission,
  handleReviewSubmission,
  handleGetItemReadme,
} from './marketplace.controller.js';
import { createTemplateMarketplaceRouter } from './template-marketplace.routes.js';

/**
 * Creates the marketplace router with all marketplace endpoints.
 *
 * Endpoints:
 * - GET  /              - List marketplace items with optional filters
 * - GET  /installed     - List locally installed items
 * - GET  /updates       - List items with available updates
 * - POST /refresh       - Force refresh the registry cache
 * - GET  /:id           - Get single item detail
 * - POST /:id/install   - Install a marketplace item
 * - POST /:id/uninstall - Uninstall a marketplace item
 * - POST /:id/update    - Update a marketplace item
 *
 * Note: Parameterized routes (/:id) are registered after static routes
 * to prevent path conflicts (e.g., /installed matching /:id).
 *
 * @returns Express router configured with marketplace routes
 */
export function createMarketplaceRouter(): Router {
  const router = Router();

  // Static routes first to avoid /:id matching "installed", "updates", "refresh", "submissions"
  router.get('/', handleListItems);
  router.get('/installed', handleListInstalled);
  router.get('/updates', handleListUpdates);
  router.post('/refresh', handleRefresh);

  // Submission routes (static paths, must come before /:id)
  router.post('/submit', handleSubmit);
  router.get('/submissions', handleListSubmissions);
  router.get('/submissions/:id', handleGetSubmission);
  router.post('/submissions/:id/review', handleReviewSubmission);

  // Template marketplace routes (mounted at /templates, must come before /:id)
  router.use('/templates', createTemplateMarketplaceRouter());

  // Parameterized routes after static routes
  router.get('/:id', handleGetItem);
  router.get('/:id/readme', handleGetItemReadme);
  router.post('/:id/install', handleInstall);
  router.post('/:id/uninstall', handleUninstall);
  router.post('/:id/update', handleUpdate);

  return router;
}
