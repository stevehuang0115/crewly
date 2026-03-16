/**
 * Marketplace REST Controller
 *
 * Exposes marketplace operations via REST API for browsing, installing,
 * updating, and uninstalling marketplace items (skills, roles, 3D models).
 * Wraps the marketplace service to provide HTTP endpoints for registry
 * management and local item lifecycle.
 *
 * @module controllers/marketplace/marketplace.controller
 */

import type { Request, Response } from 'express';
import path from 'path';
import { homedir } from 'os';
import {
  listItems,
  getItem,
  getInstalledItems,
  getUpdatableItems,
  fetchRegistry,
  installItem,
  uninstallItem,
  updateItem,
  submitSkill,
  listSubmissions,
  getSubmission,
  reviewSubmission,
} from '../../services/marketplace/index.js';
import type { MarketplaceItemType, MarketplaceCategory, SortOption, SubmissionStatus } from '../../types/marketplace.types.js';
import { asyncHandler } from '../../utils/async-handler.js';

const VALID_TYPES: MarketplaceItemType[] = ['skill', 'model', 'role', 'mcp_tool'];
const VALID_SORTS: SortOption[] = ['popular', 'rating', 'newest'];
const VALID_SUBMISSION_STATUSES: SubmissionStatus[] = ['pending', 'approved', 'rejected'];

/**
 * GET /api/marketplace - List marketplace items with optional filters.
 *
 * Accepts optional query parameters to filter and sort the registry:
 * - type: Filter by item type (skill, model, role)
 * - search: Full-text search across name, description, and tags
 * - sort: Sort order (popular, rating, newest)
 *
 * @param req - Express request with optional query params: type, search, sort
 * @param res - Express response returning { success, data: MarketplaceItemWithStatus[] }
 *
 * @example
 * ```
 * GET /api/marketplace?type=skill&search=deploy&sort=popular
 * ```
 */
export const handleListItems = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const typeParam = req.query.type as string | undefined;
  if (typeParam && !VALID_TYPES.includes(typeParam as MarketplaceItemType)) {
    res.status(400).json({ success: false, error: `Invalid type "${typeParam}". Must be one of: ${VALID_TYPES.join(', ')}` });
    return;
  }

  const sortParam = req.query.sort as string | undefined;
  if (sortParam && !VALID_SORTS.includes(sortParam as SortOption)) {
    res.status(400).json({ success: false, error: `Invalid sort "${sortParam}". Must be one of: ${VALID_SORTS.join(', ')}` });
    return;
  }

  const items = await listItems({
    type: typeParam as MarketplaceItemType | undefined,
    category: req.query.category as MarketplaceCategory | undefined,
    search: req.query.search as string | undefined,
    sortBy: sortParam as SortOption | undefined,
  });
  res.json({ success: true, data: items });
});

/**
 * GET /api/marketplace/installed - List locally installed marketplace items.
 *
 * Returns all items that have been installed to the local system,
 * regardless of whether updates are available.
 *
 * @param _req - Express request (unused)
 * @param res - Express response returning { success, data: InstalledItemRecord[] }
 *
 * @example
 * ```
 * GET /api/marketplace/installed
 * ```
 */
export const handleListInstalled = asyncHandler(async (_req: Request, res: Response): Promise<void> => {
  const items = await getInstalledItems();
  res.json({ success: true, data: items });
});

/**
 * GET /api/marketplace/updates - List items with available updates.
 *
 * Compares locally installed item versions against the registry to
 * identify items that have newer versions available.
 *
 * @param _req - Express request (unused)
 * @param res - Express response returning { success, data: MarketplaceItemWithStatus[] }
 *
 * @example
 * ```
 * GET /api/marketplace/updates
 * ```
 */
export const handleListUpdates = asyncHandler(async (_req: Request, res: Response): Promise<void> => {
  const items = await getUpdatableItems();
  res.json({ success: true, data: items });
});

/**
 * GET /api/marketplace/:id - Get a single marketplace item by ID.
 *
 * Returns full item detail including assets, metadata, and install status.
 * Returns 404 if the item does not exist in the registry.
 *
 * @param req - Express request with params.id
 * @param res - Express response returning { success, data: MarketplaceItemWithStatus } or 404
 *
 * @example
 * ```
 * GET /api/marketplace/skill-deploy-aws
 * ```
 */
export const handleGetItem = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const item = await getItem(req.params.id);
  if (!item) {
    res.status(404).json({ success: false, error: 'Item not found' });
    return;
  }
  res.json({ success: true, data: item });
});

/**
 * POST /api/marketplace/refresh - Force refresh the registry cache.
 *
 * Fetches the latest registry from the remote CDN, bypassing any
 * local cache. Returns the updated item count and timestamp.
 *
 * @param _req - Express request (unused)
 * @param res - Express response returning { success, data: { itemCount, lastUpdated } }
 *
 * @example
 * ```
 * POST /api/marketplace/refresh
 * ```
 */
export const handleRefresh = asyncHandler(async (_req: Request, res: Response): Promise<void> => {
  const registry = await fetchRegistry(true);
  res.json({
    success: true,
    data: { itemCount: registry.items.length, lastUpdated: registry.lastUpdated },
  });
});

/**
 * POST /api/marketplace/:id/install - Install a marketplace item.
 *
 * Downloads and installs the item identified by :id from the registry.
 * Returns 404 if the item does not exist. The result includes the
 * installed record with path and version information.
 *
 * @param req - Express request with params.id
 * @param res - Express response returning MarketplaceOperationResult
 *
 * @example
 * ```
 * POST /api/marketplace/skill-deploy-aws/install
 * ```
 */
export const handleInstall = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const item = await getItem(req.params.id);
  if (!item) {
    res.status(404).json({ success: false, error: 'Item not found' });
    return;
  }
  const result = await installItem(item);
  res.json(result);
});

/**
 * POST /api/marketplace/:id/uninstall - Uninstall a marketplace item.
 *
 * Removes the locally installed item identified by :id. Cleans up
 * the installation directory and removes the manifest entry.
 *
 * @param req - Express request with params.id
 * @param res - Express response returning MarketplaceOperationResult
 *
 * @example
 * ```
 * POST /api/marketplace/skill-deploy-aws/uninstall
 * ```
 */
export const handleUninstall = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const result = await uninstallItem(req.params.id);
  res.json(result);
});

/**
 * POST /api/marketplace/:id/update - Update a marketplace item.
 *
 * Downloads and installs the latest version of the item identified by :id.
 * Returns 404 if the item does not exist in the registry.
 *
 * @param req - Express request with params.id
 * @param res - Express response returning MarketplaceOperationResult
 *
 * @example
 * ```
 * POST /api/marketplace/skill-deploy-aws/update
 * ```
 */
export const handleUpdate = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const item = await getItem(req.params.id);
  if (!item) {
    res.status(404).json({ success: false, error: 'Item not found' });
    return;
  }
  const result = await updateItem(item);
  res.json(result);
});

/**
 * POST /api/marketplace/submit - Submit a skill for marketplace review.
 *
 * Accepts a JSON body with `archivePath` pointing to a local tar.gz archive.
 * Validates the archive contents, stores a copy, and creates a pending
 * submission record.
 *
 * @param req - Express request with body: { archivePath: string }
 * @param res - Express response returning submission result
 *
 * @example
 * ```
 * POST /api/marketplace/submit
 * { "archivePath": "/path/to/my-skill-1.0.0.tar.gz" }
 * ```
 */
export const handleSubmit = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { archivePath } = req.body as { archivePath?: string };
  if (!archivePath) {
    res.status(400).json({ success: false, error: 'archivePath is required' });
    return;
  }

  // Validate archivePath is within allowed directories to prevent path traversal
  const resolvedPath = path.resolve(archivePath);
  const allowedDirs = [
    path.resolve(homedir(), '.crewly'),
    path.resolve(process.cwd()),
    path.resolve('/tmp'),
  ];
  const isAllowed = allowedDirs.some((dir) => {
    const normalizedDir = dir.endsWith(path.sep) ? dir : dir + path.sep;
    return resolvedPath === dir || resolvedPath.startsWith(normalizedDir);
  });
  if (!isAllowed) {
    res.status(400).json({
      success: false,
      error: 'archivePath must be within the project directory, ~/.crewly, or /tmp',
    });
    return;
  }

  const result = await submitSkill(archivePath);
  res.json(result);
});

/**
 * GET /api/marketplace/submissions - List all submissions.
 *
 * Accepts an optional `status` query parameter to filter by submission status.
 *
 * @param req - Express request with optional query: status (pending|approved|rejected)
 * @param res - Express response returning { success, data: MarketplaceSubmission[] }
 *
 * @example
 * ```
 * GET /api/marketplace/submissions?status=pending
 * ```
 */
export const handleListSubmissions = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const statusParam = req.query.status as string | undefined;
  if (statusParam && !VALID_SUBMISSION_STATUSES.includes(statusParam as SubmissionStatus)) {
    res.status(400).json({
      success: false,
      error: `Invalid status "${statusParam}". Must be one of: ${VALID_SUBMISSION_STATUSES.join(', ')}`,
    });
    return;
  }
  const submissions = await listSubmissions(statusParam as SubmissionStatus | undefined);
  res.json({ success: true, data: submissions });
});

/**
 * GET /api/marketplace/submissions/:id - Get a single submission.
 *
 * @param req - Express request with params.id
 * @param res - Express response returning { success, data: MarketplaceSubmission } or 404
 *
 * @example
 * ```
 * GET /api/marketplace/submissions/abc-123
 * ```
 */
export const handleGetSubmission = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const submission = await getSubmission(req.params.id);
  if (!submission) {
    res.status(404).json({ success: false, error: 'Submission not found' });
    return;
  }
  res.json({ success: true, data: submission });
});

/**
 * POST /api/marketplace/submissions/:id/review - Approve or reject a submission.
 *
 * @param req - Express request with params.id and body: { action: 'approve'|'reject', notes?: string }
 * @param res - Express response returning operation result
 *
 * @example
 * ```
 * POST /api/marketplace/submissions/abc-123/review
 * { "action": "approve" }
 * ```
 */
export const handleReviewSubmission = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { action, notes } = req.body as { action?: string; notes?: string };
  if (action !== 'approve' && action !== 'reject') {
    res.status(400).json({ success: false, error: 'action must be "approve" or "reject"' });
    return;
  }
  const result = await reviewSubmission(req.params.id, action, notes);
  if (!result.success && result.message.startsWith('Submission not found')) {
    res.status(404).json(result);
    return;
  }
  res.json(result);
});
