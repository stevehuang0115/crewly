/**
 * Marketplace Types Tests
 *
 * Unit tests for marketplace type guards and utility functions.
 *
 * @module types/marketplace.types.test
 */

import { describe, it, expect } from 'vitest';
import {
  MARKETPLACE_ITEM_TYPES,
  SORT_OPTIONS,
  INSTALL_STATUSES,
  isValidMarketplaceItemType,
  isValidSortOption,
  getMarketplaceItemTypeLabel,
  getSortOptionLabel,
  type MarketplaceItemType,
  type SortOption,
  type MarketplaceItem,
  type MarketplaceItemWithStatus,
  type MarketplaceItemAssets,
} from './marketplace.types';

describe('Marketplace Types', () => {
  describe('MARKETPLACE_ITEM_TYPES constant', () => {
    it('should contain all expected item types', () => {
      expect(MARKETPLACE_ITEM_TYPES).toContain('skill');
      expect(MARKETPLACE_ITEM_TYPES).toContain('model');
      expect(MARKETPLACE_ITEM_TYPES).toContain('role');
      expect(MARKETPLACE_ITEM_TYPES).toContain('mcp_tool');
    });

    it('should have exactly 4 item types', () => {
      expect(MARKETPLACE_ITEM_TYPES).toHaveLength(4);
    });
  });

  describe('SORT_OPTIONS constant', () => {
    it('should contain all expected sort options', () => {
      expect(SORT_OPTIONS).toContain('popular');
      expect(SORT_OPTIONS).toContain('rating');
      expect(SORT_OPTIONS).toContain('newest');
    });

    it('should have exactly 3 sort options', () => {
      expect(SORT_OPTIONS).toHaveLength(3);
    });
  });

  describe('INSTALL_STATUSES constant', () => {
    it('should contain all expected install statuses', () => {
      expect(INSTALL_STATUSES).toContain('not_installed');
      expect(INSTALL_STATUSES).toContain('installed');
      expect(INSTALL_STATUSES).toContain('update_available');
    });

    it('should have exactly 3 statuses', () => {
      expect(INSTALL_STATUSES).toHaveLength(3);
    });
  });

  describe('isValidMarketplaceItemType', () => {
    it('should return true for valid item types', () => {
      expect(isValidMarketplaceItemType('skill')).toBe(true);
      expect(isValidMarketplaceItemType('model')).toBe(true);
      expect(isValidMarketplaceItemType('role')).toBe(true);
      expect(isValidMarketplaceItemType('mcp_tool')).toBe(true);
    });

    it('should return false for invalid item types', () => {
      expect(isValidMarketplaceItemType('invalid')).toBe(false);
      expect(isValidMarketplaceItemType('')).toBe(false);
      expect(isValidMarketplaceItemType('Skill')).toBe(false);
      expect(isValidMarketplaceItemType('SKILL')).toBe(false);
      expect(isValidMarketplaceItemType('plugin')).toBe(false);
    });

    it('should work as a type guard', () => {
      const value: string = 'skill';
      if (isValidMarketplaceItemType(value)) {
        const itemType: MarketplaceItemType = value;
        expect(itemType).toBe('skill');
      }
    });
  });

  describe('isValidSortOption', () => {
    it('should return true for valid sort options', () => {
      expect(isValidSortOption('popular')).toBe(true);
      expect(isValidSortOption('rating')).toBe(true);
      expect(isValidSortOption('newest')).toBe(true);
    });

    it('should return false for invalid sort options', () => {
      expect(isValidSortOption('invalid')).toBe(false);
      expect(isValidSortOption('')).toBe(false);
      expect(isValidSortOption('Popular')).toBe(false);
      expect(isValidSortOption('oldest')).toBe(false);
      expect(isValidSortOption('name')).toBe(false);
    });

    it('should work as a type guard', () => {
      const value: string = 'popular';
      if (isValidSortOption(value)) {
        const sort: SortOption = value;
        expect(sort).toBe('popular');
      }
    });
  });

  describe('getMarketplaceItemTypeLabel', () => {
    it('should return correct labels for all item types', () => {
      expect(getMarketplaceItemTypeLabel('skill')).toBe('Skill');
      expect(getMarketplaceItemTypeLabel('model')).toBe('3D Model');
      expect(getMarketplaceItemTypeLabel('role')).toBe('Role');
      expect(getMarketplaceItemTypeLabel('mcp_tool')).toBe('MCP Tool');
    });

    it('should return the type itself as fallback for unknown values', () => {
      expect(getMarketplaceItemTypeLabel('unknown' as MarketplaceItemType)).toBe('unknown');
    });
  });

  describe('getSortOptionLabel', () => {
    it('should return correct labels for all sort options', () => {
      expect(getSortOptionLabel('popular')).toBe('Popular');
      expect(getSortOptionLabel('rating')).toBe('Highest Rated');
      expect(getSortOptionLabel('newest')).toBe('Newest');
    });

    it('should return the sort value itself as fallback for unknown values', () => {
      expect(getSortOptionLabel('unknown' as SortOption)).toBe('unknown');
    });
  });

  describe('Type Interfaces', () => {
    it('should allow creating a valid MarketplaceItemAssets object', () => {
      const assets: MarketplaceItemAssets = {
        archive: 'https://example.com/archive.tar.gz',
        checksum: 'sha256:abc123',
        sizeBytes: 1024000,
        preview: 'https://example.com/preview.png',
        model: 'https://example.com/model.glb',
      };

      expect(assets.archive).toBe('https://example.com/archive.tar.gz');
      expect(assets.sizeBytes).toBe(1024000);
    });

    it('should allow creating MarketplaceItemAssets with optional fields omitted', () => {
      const assets: MarketplaceItemAssets = {};

      expect(assets.archive).toBeUndefined();
      expect(assets.checksum).toBeUndefined();
      expect(assets.sizeBytes).toBeUndefined();
      expect(assets.preview).toBeUndefined();
      expect(assets.model).toBeUndefined();
    });

    it('should allow creating a valid MarketplaceItem object', () => {
      const item: MarketplaceItem = {
        id: 'item-001',
        type: 'skill',
        name: 'Code Review Skill',
        description: 'Automates code review',
        author: 'Crewly Team',
        version: '1.0.0',
        category: 'development',
        tags: ['code', 'review', 'quality'],
        license: 'MIT',
        icon: 'code-review-icon',
        downloads: 1500,
        rating: 4.5,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-06-01T00:00:00Z',
        assets: {
          archive: 'https://example.com/skill.tar.gz',
          checksum: 'sha256:abc123',
        },
        metadata: { complexity: 'medium' },
      };

      expect(item.id).toBe('item-001');
      expect(item.type).toBe('skill');
      expect(item.name).toBe('Code Review Skill');
      expect(item.rating).toBe(4.5);
      expect(item.tags).toContain('code');
    });

    it('should allow creating a MarketplaceItem with minimal optional fields', () => {
      const item: MarketplaceItem = {
        id: 'item-002',
        type: 'model',
        name: 'Robot Model',
        description: 'A 3D robot model',
        author: 'Artist',
        version: '1.0.0',
        category: 'visualization',
        tags: [],
        license: 'Apache-2.0',
        downloads: 0,
        rating: 0,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        assets: {},
      };

      expect(item.id).toBe('item-002');
      expect(item.icon).toBeUndefined();
      expect(item.metadata).toBeUndefined();
    });

    it('should allow creating a valid MarketplaceItemWithStatus object', () => {
      const item: MarketplaceItemWithStatus = {
        id: 'item-003',
        type: 'role',
        name: 'Senior Developer',
        description: 'Senior developer role definition',
        author: 'Crewly Team',
        version: '2.0.0',
        category: 'engineering',
        tags: ['developer', 'senior'],
        license: 'MIT',
        downloads: 500,
        rating: 4.8,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-06-01T00:00:00Z',
        assets: {},
        installStatus: 'installed',
        installedVersion: '2.0.0',
      };

      expect(item.installStatus).toBe('installed');
      expect(item.installedVersion).toBe('2.0.0');
    });

    it('should allow creating a MarketplaceItemWithStatus with not_installed status', () => {
      const item: MarketplaceItemWithStatus = {
        id: 'item-004',
        type: 'skill',
        name: 'Test Skill',
        description: 'A test skill',
        author: 'Test Author',
        version: '1.0.0',
        category: 'testing',
        tags: [],
        license: 'MIT',
        downloads: 0,
        rating: 0,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        assets: {},
        installStatus: 'not_installed',
      };

      expect(item.installStatus).toBe('not_installed');
      expect(item.installedVersion).toBeUndefined();
    });

    it('should allow creating a MarketplaceItemWithStatus with update_available status', () => {
      const item: MarketplaceItemWithStatus = {
        id: 'item-005',
        type: 'model',
        name: 'Updated Model',
        description: 'A model with an update',
        author: 'Artist',
        version: '2.0.0',
        category: 'visualization',
        tags: ['3d'],
        license: 'MIT',
        downloads: 100,
        rating: 3.5,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-06-01T00:00:00Z',
        assets: { model: 'model.glb' },
        installStatus: 'update_available',
        installedVersion: '1.0.0',
      };

      expect(item.installStatus).toBe('update_available');
      expect(item.installedVersion).toBe('1.0.0');
      expect(item.version).toBe('2.0.0');
    });
  });
});
