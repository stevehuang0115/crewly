/**
 * Tests for Marketplace Controller
 *
 * Validates the REST handlers for marketplace endpoints including
 * list, detail, install, uninstall, update, refresh, tier gating, and error handling (50 tests).
 *
 * @module controllers/marketplace/marketplace.controller.test
 */

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

// Mock marketplace service
const mockListItems = jest.fn();
const mockGetItem = jest.fn();
const mockGetInstalledItems = jest.fn();
const mockGetUpdatableItems = jest.fn();
const mockFetchRegistry = jest.fn();
const mockInstallItem = jest.fn();
const mockUninstallItem = jest.fn();
const mockUpdateItem = jest.fn();
const mockSubmitSkill = jest.fn();
const mockListSubmissions = jest.fn();
const mockGetSubmission = jest.fn();
const mockReviewSubmission = jest.fn();
const mockGetItemReadme = jest.fn();

jest.mock('../../services/marketplace/index.js', () => ({
  listItems: (...args: unknown[]) => mockListItems(...args),
  getItem: (...args: unknown[]) => mockGetItem(...args),
  getInstalledItems: (...args: unknown[]) => mockGetInstalledItems(...args),
  getUpdatableItems: (...args: unknown[]) => mockGetUpdatableItems(...args),
  fetchRegistry: (...args: unknown[]) => mockFetchRegistry(...args),
  installItem: (...args: unknown[]) => mockInstallItem(...args),
  uninstallItem: (...args: unknown[]) => mockUninstallItem(...args),
  updateItem: (...args: unknown[]) => mockUpdateItem(...args),
  submitSkill: (...args: unknown[]) => mockSubmitSkill(...args),
  listSubmissions: (...args: unknown[]) => mockListSubmissions(...args),
  getSubmission: (...args: unknown[]) => mockGetSubmission(...args),
  reviewSubmission: (...args: unknown[]) => mockReviewSubmission(...args),
  getItemReadme: (...args: unknown[]) => mockGetItemReadme(...args),
}));

// Mock CloudClientService for tier checks
const mockGetTier = jest.fn().mockReturnValue('free');

jest.mock('../../services/cloud/cloud-client.service.js', () => ({
  CloudClientService: {
    getInstance: () => ({
      getTier: mockGetTier,
    }),
  },
}));

// Mock SkillTierService for tier hierarchy comparison
const mockIsTierSufficient = jest.fn().mockReturnValue(false);

jest.mock('../../services/skill/skill-tier.service.js', () => ({
  SkillTierService: {
    getInstance: () => ({
      isTierSufficient: mockIsTierSufficient,
    }),
  },
}));

describe('MarketplaceController', () => {
  let mockRes: { json: jest.Mock; status: jest.Mock };
  const next = jest.fn();

  beforeEach(() => {
    mockRes = {
      json: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
    };

    mockListItems.mockReset();
    mockGetItem.mockReset();
    mockGetInstalledItems.mockReset();
    mockGetUpdatableItems.mockReset();
    mockFetchRegistry.mockReset();
    mockInstallItem.mockReset();
    mockUninstallItem.mockReset();
    mockUpdateItem.mockReset();
    mockGetTier.mockReset().mockReturnValue('free');
    mockIsTierSufficient.mockReset().mockReturnValue(false);
  });

  // ========================= handleListItems =========================

  describe('handleListItems', () => {
    it('should return items with accessible annotation', async () => {
      const items = [{ id: 'skill-1', name: 'Deploy Skill' }];
      mockListItems.mockResolvedValue(items);

      await handleListItems(
        { query: {} } as any,
        mockRes as any,
        next,
      );

      expect(mockListItems).toHaveBeenCalledWith({
        type: undefined,
        category: undefined,
        search: undefined,
        sortBy: undefined,
      });
      const data = mockRes.json.mock.calls[0][0].data;
      expect(data).toHaveLength(1);
      expect(data[0].accessible).toBe(true);
    });

    it('should mark premium items as inaccessible for free users', async () => {
      const items = [{ id: 'premium-skill', name: 'Premium', metadata: { premium: true } }];
      mockListItems.mockResolvedValue(items);
      mockGetTier.mockReturnValue('free');

      await handleListItems(
        { query: {} } as any,
        mockRes as any,
        next,
      );

      const data = mockRes.json.mock.calls[0][0].data;
      expect(data[0].accessible).toBe(false);
    });

    it('should mark premium items as accessible for pro users', async () => {
      const items = [{ id: 'premium-skill', name: 'Premium', metadata: { premium: true } }];
      mockListItems.mockResolvedValue(items);
      mockGetTier.mockReturnValue('pro');
      mockIsTierSufficient.mockReturnValue(true);

      await handleListItems(
        { query: {} } as any,
        mockRes as any,
        next,
      );

      const data = mockRes.json.mock.calls[0][0].data;
      expect(data[0].accessible).toBe(true);
    });

    it('should pass filter parameters from query string', async () => {
      mockListItems.mockResolvedValue([]);

      await handleListItems(
        { query: { type: 'skill', category: 'development', search: 'deploy', sort: 'popular' } } as any,
        mockRes as any,
        next,
      );

      expect(mockListItems).toHaveBeenCalledWith({
        type: 'skill',
        category: 'development',
        search: 'deploy',
        sortBy: 'popular',
      });
    });

    it('should return 400 for invalid type parameter', async () => {
      await handleListItems(
        { query: { type: 'invalid' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 for invalid sort parameter', async () => {
      await handleListItems(
        { query: { sort: 'invalid' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should return 500 on service error', async () => {
      mockListItems.mockRejectedValue(new Error('Registry fetch failed'));

      await handleListItems(
        { query: {} } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Registry fetch failed',
      });
    });

    it('should handle non-Error thrown values', async () => {
      mockListItems.mockRejectedValue('string error');

      await handleListItems(
        { query: {} } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'string error',
      });
    });
  });

  // ========================= handleListInstalled =========================

  describe('handleListInstalled', () => {
    it('should return installed items', async () => {
      const installed = [{ id: 'skill-1', version: '1.0.0' }];
      mockGetInstalledItems.mockResolvedValue(installed);

      await handleListInstalled(
        {} as any,
        mockRes as any,
        next,
      );

      expect(mockGetInstalledItems).toHaveBeenCalled();
      expect(mockRes.json).toHaveBeenCalledWith({ success: true, data: installed });
    });

    it('should return 500 on service error', async () => {
      mockGetInstalledItems.mockRejectedValue(new Error('Manifest read failed'));

      await handleListInstalled(
        {} as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Manifest read failed',
      });
    });
  });

  // ========================= handleListUpdates =========================

  describe('handleListUpdates', () => {
    it('should return updatable items', async () => {
      const updatable = [{ id: 'skill-1', installStatus: 'update_available' }];
      mockGetUpdatableItems.mockResolvedValue(updatable);

      await handleListUpdates(
        {} as any,
        mockRes as any,
        next,
      );

      expect(mockGetUpdatableItems).toHaveBeenCalled();
      expect(mockRes.json).toHaveBeenCalledWith({ success: true, data: updatable });
    });

    it('should return 500 on service error', async () => {
      mockGetUpdatableItems.mockRejectedValue(new Error('Version comparison failed'));

      await handleListUpdates(
        {} as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Version comparison failed',
      });
    });
  });

  // ========================= handleGetItem =========================

  describe('handleGetItem', () => {
    it('should return item when found', async () => {
      const item = { id: 'skill-deploy', name: 'Deploy Skill' };
      mockGetItem.mockResolvedValue(item);

      await handleGetItem(
        { params: { id: 'skill-deploy' } } as any,
        mockRes as any,
        next,
      );

      expect(mockGetItem).toHaveBeenCalledWith('skill-deploy');
      expect(mockRes.json).toHaveBeenCalledWith({ success: true, data: item });
    });

    it('should return 404 when item not found', async () => {
      mockGetItem.mockResolvedValue(null);

      await handleGetItem(
        { params: { id: 'nonexistent' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Item not found',
      });
    });

    it('should return 404 when item is undefined', async () => {
      mockGetItem.mockResolvedValue(undefined);

      await handleGetItem(
        { params: { id: 'nonexistent' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(404);
    });

    it('should return 500 on service error', async () => {
      mockGetItem.mockRejectedValue(new Error('Registry error'));

      await handleGetItem(
        { params: { id: 'skill-deploy' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Registry error',
      });
    });
  });

  // ========================= handleRefresh =========================

  describe('handleRefresh', () => {
    it('should refresh registry and return summary', async () => {
      mockFetchRegistry.mockResolvedValue({
        items: [{ id: '1' }, { id: '2' }, { id: '3' }],
        lastUpdated: '2026-02-17T00:00:00Z',
      });

      await handleRefresh(
        {} as any,
        mockRes as any,
        next,
      );

      expect(mockFetchRegistry).toHaveBeenCalledWith(true);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        data: { itemCount: 3, lastUpdated: '2026-02-17T00:00:00Z' },
      });
    });

    it('should return 500 on fetch error', async () => {
      mockFetchRegistry.mockRejectedValue(new Error('Network timeout'));

      await handleRefresh(
        {} as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Network timeout',
      });
    });
  });

  // ========================= handleInstall =========================

  describe('handleInstall', () => {
    it('should install item and return result', async () => {
      const item = { id: 'skill-deploy', name: 'Deploy Skill' };
      const result = { success: true, message: 'Installed successfully', item: { id: 'skill-deploy', version: '1.0.0' } };
      mockGetItem.mockResolvedValue(item);
      mockInstallItem.mockResolvedValue(result);

      await handleInstall(
        { params: { id: 'skill-deploy' } } as any,
        mockRes as any,
        next,
      );

      expect(mockGetItem).toHaveBeenCalledWith('skill-deploy');
      expect(mockInstallItem).toHaveBeenCalledWith(item);
      expect(mockRes.json).toHaveBeenCalledWith(result);
    });

    it('should return 404 when item not found for install', async () => {
      mockGetItem.mockResolvedValue(null);

      await handleInstall(
        { params: { id: 'nonexistent' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Item not found',
      });
      expect(mockInstallItem).not.toHaveBeenCalled();
    });

    it('should return 500 on install error', async () => {
      const item = { id: 'skill-deploy', name: 'Deploy Skill' };
      mockGetItem.mockResolvedValue(item);
      mockInstallItem.mockRejectedValue(new Error('Disk full'));

      await handleInstall(
        { params: { id: 'skill-deploy' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Disk full',
      });
    });

    it('should return 500 when getItem throws during install', async () => {
      mockGetItem.mockRejectedValue(new Error('Registry offline'));

      await handleInstall(
        { params: { id: 'skill-deploy' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockInstallItem).not.toHaveBeenCalled();
    });

    it('should return 403 when free user tries to install premium item', async () => {
      const premiumItem = { id: 'pro-skill', name: 'Pro Skill', metadata: { premium: true } };
      mockGetItem.mockResolvedValue(premiumItem);
      mockGetTier.mockReturnValue('free');

      await handleInstall(
        { params: { id: 'pro-skill' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('premium item'),
      });
      expect(mockInstallItem).not.toHaveBeenCalled();
    });

    it('should allow pro user to install premium item', async () => {
      const premiumItem = { id: 'pro-skill', name: 'Pro Skill', metadata: { premium: true } };
      const result = { success: true, message: 'Installed' };
      mockGetItem.mockResolvedValue(premiumItem);
      mockGetTier.mockReturnValue('pro');
      mockIsTierSufficient.mockReturnValue(true);
      mockInstallItem.mockResolvedValue(result);

      await handleInstall(
        { params: { id: 'pro-skill' } } as any,
        mockRes as any,
        next,
      );

      expect(mockInstallItem).toHaveBeenCalledWith(premiumItem);
      expect(mockRes.json).toHaveBeenCalledWith(result);
    });

    it('should allow free user to install non-premium item', async () => {
      const freeItem = { id: 'free-skill', name: 'Free Skill' };
      const result = { success: true, message: 'Installed' };
      mockGetItem.mockResolvedValue(freeItem);
      mockGetTier.mockReturnValue('free');
      mockInstallItem.mockResolvedValue(result);

      await handleInstall(
        { params: { id: 'free-skill' } } as any,
        mockRes as any,
        next,
      );

      expect(mockInstallItem).toHaveBeenCalledWith(freeItem);
    });
  });

  // ========================= handleUninstall =========================

  describe('handleUninstall', () => {
    it('should uninstall item and return result', async () => {
      const result = { success: true, message: 'Uninstalled successfully' };
      mockUninstallItem.mockResolvedValue(result);

      await handleUninstall(
        { params: { id: 'skill-deploy' } } as any,
        mockRes as any,
        next,
      );

      expect(mockUninstallItem).toHaveBeenCalledWith('skill-deploy');
      expect(mockRes.json).toHaveBeenCalledWith(result);
    });

    it('should return 500 on uninstall error', async () => {
      mockUninstallItem.mockRejectedValue(new Error('Permission denied'));

      await handleUninstall(
        { params: { id: 'skill-deploy' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Permission denied',
      });
    });
  });

  // ========================= handleUpdate =========================

  describe('handleUpdate', () => {
    it('should update item and return result', async () => {
      const item = { id: 'skill-deploy', name: 'Deploy Skill' };
      const result = { success: true, message: 'Updated to 2.0.0', item: { id: 'skill-deploy', version: '2.0.0' } };
      mockGetItem.mockResolvedValue(item);
      mockUpdateItem.mockResolvedValue(result);

      await handleUpdate(
        { params: { id: 'skill-deploy' } } as any,
        mockRes as any,
        next,
      );

      expect(mockGetItem).toHaveBeenCalledWith('skill-deploy');
      expect(mockUpdateItem).toHaveBeenCalledWith(item);
      expect(mockRes.json).toHaveBeenCalledWith(result);
    });

    it('should return 404 when item not found for update', async () => {
      mockGetItem.mockResolvedValue(null);

      await handleUpdate(
        { params: { id: 'nonexistent' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Item not found',
      });
      expect(mockUpdateItem).not.toHaveBeenCalled();
    });

    it('should return 500 on update error', async () => {
      const item = { id: 'skill-deploy', name: 'Deploy Skill' };
      mockGetItem.mockResolvedValue(item);
      mockUpdateItem.mockRejectedValue(new Error('Download failed'));

      await handleUpdate(
        { params: { id: 'skill-deploy' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Download failed',
      });
    });

    it('should return 500 when getItem throws during update', async () => {
      mockGetItem.mockRejectedValue(new Error('Registry offline'));

      await handleUpdate(
        { params: { id: 'skill-deploy' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockUpdateItem).not.toHaveBeenCalled();
    });

    it('should return 403 when free user tries to update premium item', async () => {
      const premiumItem = { id: 'pro-skill', name: 'Pro Skill', metadata: { premium: true } };
      mockGetItem.mockResolvedValue(premiumItem);
      mockGetTier.mockReturnValue('free');

      await handleUpdate(
        { params: { id: 'pro-skill' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockUpdateItem).not.toHaveBeenCalled();
    });

    it('should allow pro user to update premium item', async () => {
      const premiumItem = { id: 'pro-skill', name: 'Pro Skill', metadata: { premium: true } };
      const result = { success: true, message: 'Updated' };
      mockGetItem.mockResolvedValue(premiumItem);
      mockGetTier.mockReturnValue('pro');
      mockIsTierSufficient.mockReturnValue(true);
      mockUpdateItem.mockResolvedValue(result);

      await handleUpdate(
        { params: { id: 'pro-skill' } } as any,
        mockRes as any,
        next,
      );

      expect(mockUpdateItem).toHaveBeenCalledWith(premiumItem);
      expect(mockRes.json).toHaveBeenCalledWith(result);
    });
  });

  // ========================= handleSubmit =========================

  describe('handleSubmit', () => {
    it('should submit skill and return result', async () => {
      const result = { success: true, message: 'Submitted', submission: { id: 'sub-1' } };
      mockSubmitSkill.mockResolvedValue(result);

      // Use process.cwd()-relative path which is always in the allowed dirs
      const archivePath = require('path').join(process.cwd(), 'test-archive.tar.gz');
      await handleSubmit(
        { body: { archivePath } } as any,
        mockRes as any,
        next,
      );

      expect(mockSubmitSkill).toHaveBeenCalledWith(archivePath);
      expect(mockRes.json).toHaveBeenCalledWith(result);
    });

    it('should return 400 when archivePath is missing', async () => {
      await handleSubmit(
        { body: {} } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'archivePath is required',
      });
    });

    it('should return 400 when archivePath is outside allowed directories', async () => {
      await handleSubmit(
        { body: { archivePath: '/etc/passwd' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'archivePath must be within the project directory, ~/.crewly, or /tmp',
      });
    });

    it('should return 500 on service error', async () => {
      mockSubmitSkill.mockRejectedValue(new Error('IO error'));

      const archivePath = require('path').join(process.cwd(), 'test-archive.tar.gz');
      await handleSubmit(
        { body: { archivePath } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(500);
    });
  });

  // ========================= handleListSubmissions =========================

  describe('handleListSubmissions', () => {
    it('should list all submissions', async () => {
      const submissions = [{ id: 'sub-1' }, { id: 'sub-2' }];
      mockListSubmissions.mockResolvedValue(submissions);

      await handleListSubmissions(
        { query: {} } as any,
        mockRes as any,
        next,
      );

      expect(mockListSubmissions).toHaveBeenCalledWith(undefined);
      expect(mockRes.json).toHaveBeenCalledWith({ success: true, data: submissions });
    });

    it('should filter by status', async () => {
      mockListSubmissions.mockResolvedValue([]);

      await handleListSubmissions(
        { query: { status: 'pending' } } as any,
        mockRes as any,
        next,
      );

      expect(mockListSubmissions).toHaveBeenCalledWith('pending');
    });

    it('should return 400 for invalid status', async () => {
      await handleListSubmissions(
        { query: { status: 'invalid' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should return 500 on error', async () => {
      mockListSubmissions.mockRejectedValue(new Error('IO'));

      await handleListSubmissions(
        { query: {} } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(500);
    });
  });

  // ========================= handleGetSubmission =========================

  describe('handleGetSubmission', () => {
    it('should return submission by ID', async () => {
      const submission = { id: 'sub-1', skillId: 'test' };
      mockGetSubmission.mockResolvedValue(submission);

      await handleGetSubmission(
        { params: { id: 'sub-1' } } as any,
        mockRes as any,
        next,
      );

      expect(mockGetSubmission).toHaveBeenCalledWith('sub-1');
      expect(mockRes.json).toHaveBeenCalledWith({ success: true, data: submission });
    });

    it('should return 404 when not found', async () => {
      mockGetSubmission.mockResolvedValue(null);

      await handleGetSubmission(
        { params: { id: 'nonexistent' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(404);
    });
  });

  // ========================= handleReviewSubmission =========================

  describe('handleReviewSubmission', () => {
    it('should approve a submission', async () => {
      const result = { success: true, message: 'Approved' };
      mockReviewSubmission.mockResolvedValue(result);

      await handleReviewSubmission(
        { params: { id: 'sub-1' }, body: { action: 'approve' } } as any,
        mockRes as any,
        next,
      );

      expect(mockReviewSubmission).toHaveBeenCalledWith('sub-1', 'approve', undefined);
      expect(mockRes.json).toHaveBeenCalledWith(result);
    });

    it('should reject a submission with notes', async () => {
      const result = { success: true, message: 'Rejected' };
      mockReviewSubmission.mockResolvedValue(result);

      await handleReviewSubmission(
        { params: { id: 'sub-1' }, body: { action: 'reject', notes: 'Needs work' } } as any,
        mockRes as any,
        next,
      );

      expect(mockReviewSubmission).toHaveBeenCalledWith('sub-1', 'reject', 'Needs work');
    });

    it('should return 400 for invalid action', async () => {
      await handleReviewSubmission(
        { params: { id: 'sub-1' }, body: { action: 'invalid' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'action must be "approve" or "reject"',
      });
    });

    it('should return 404 when submission not found', async () => {
      mockReviewSubmission.mockResolvedValue({ success: false, message: 'Submission not found: x' });

      await handleReviewSubmission(
        { params: { id: 'x' }, body: { action: 'approve' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(404);
    });
  });

  describe('handleGetItemReadme', () => {
    it('should return README content when found', async () => {
      const readmeContent = '# My Skill\n\nThis skill does great things.';
      mockGetItemReadme.mockResolvedValue(readmeContent);

      await handleGetItemReadme(
        { params: { id: 'my-skill' } } as any,
        mockRes as any,
        next,
      );

      expect(mockGetItemReadme).toHaveBeenCalledWith('my-skill');
      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        data: { content: readmeContent },
      });
    });

    it('should return 404 when README not found', async () => {
      mockGetItemReadme.mockResolvedValue(null);

      await handleGetItemReadme(
        { params: { id: 'no-readme-skill' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(404);
    });

    it('should return 400 for invalid item ID', async () => {
      mockGetItemReadme.mockRejectedValue(new Error('Invalid marketplace item ID "../evil": must match /^[a-z0-9][a-z0-9\\-]*$/'));

      await handleGetItemReadme(
        { params: { id: '../evil' } } as any,
        mockRes as any,
        next,
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });
  });
});
