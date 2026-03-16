import {
  MarketplaceItem,
  MarketplaceRegistry,
  MarketplaceFilter,
  MarketplaceItemWithStatus,
  InstalledItemRecord,
  InstalledItemsManifest,
  MarketplaceOperationResult,
  MarketplaceTemplate,
  TemplateVersion,
  TemplatePricing,
  TemplateFilter,
  TemplateOperationResult,
  TemplateStore,
  TemplateVersionStore,
} from './marketplace.types.js';
import type { PublishStatus, TemplateCategory } from './marketplace.types.js';

describe('Marketplace Types', () => {
  it('should create a valid MarketplaceItem', () => {
    const item: MarketplaceItem = {
      id: 'skill-test',
      type: 'skill',
      name: 'Test Skill',
      description: 'A test skill',
      author: 'test',
      version: '1.0.0',
      category: 'development',
      tags: ['test'],
      license: 'MIT',
      downloads: 100,
      rating: 4.5,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-02-01T00:00:00Z',
      assets: {
        archive: 'skills/test/test-1.0.0.tar.gz',
        sizeBytes: 1024,
      },
    };
    expect(item.type).toBe('skill');
    expect(item.category).toBe('development');
  });

  it('should create a valid MCP tool MarketplaceItem', () => {
    const item: MarketplaceItem = {
      id: 'mcp-filesystem',
      type: 'mcp_tool',
      name: 'Filesystem Server',
      description: 'Read and write files via MCP protocol',
      author: 'Anthropic',
      version: '1.2.0',
      category: 'integration',
      tags: ['mcp', 'filesystem', 'io'],
      license: 'MIT',
      downloads: 5000,
      rating: 4.8,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
      assets: {},
      metadata: { command: 'npx', args: ['-y', '@anthropic/mcp-filesystem'] },
    };
    expect(item.type).toBe('mcp_tool');
    expect(item.metadata?.command).toBe('npx');
  });

  it('should create a valid MarketplaceRegistry', () => {
    const registry: MarketplaceRegistry = {
      schemaVersion: 1,
      lastUpdated: '2026-02-17T00:00:00Z',
      cdnBaseUrl: 'https://crewlyai.com/api/assets',
      items: [],
    };
    expect(registry.schemaVersion).toBe(1);
    expect(registry.items).toHaveLength(0);
  });

  it('should create a valid MarketplaceFilter', () => {
    const filter: MarketplaceFilter = {
      type: 'skill',
      search: 'code review',
      sortBy: 'popular',
    };
    expect(filter.type).toBe('skill');
  });

  it('should create a valid MarketplaceItemWithStatus', () => {
    const item: MarketplaceItemWithStatus = {
      id: 'skill-test',
      type: 'skill',
      name: 'Test',
      description: 'Test',
      author: 'test',
      version: '1.0.0',
      category: 'development',
      tags: [],
      license: 'MIT',
      downloads: 0,
      rating: 0,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      assets: {},
      installStatus: 'installed',
      installedVersion: '1.0.0',
    };
    expect(item.installStatus).toBe('installed');
  });

  it('should create a valid InstalledItemsManifest', () => {
    const manifest: InstalledItemsManifest = {
      schemaVersion: 1,
      items: [{
        id: 'skill-test',
        type: 'skill',
        name: 'Test',
        version: '1.0.0',
        installedAt: '2026-02-17T00:00:00Z',
        installPath: '/home/user/.crewly/marketplace/skills/skill-test',
      }],
    };
    expect(manifest.items).toHaveLength(1);
  });

  it('should create a valid MarketplaceOperationResult', () => {
    const result: MarketplaceOperationResult = {
      success: true,
      message: 'Installed successfully',
    };
    expect(result.success).toBe(true);
  });
});

// ========================= Template Marketplace Types =========================

describe('Template Marketplace Types', () => {
  it('should create a valid MarketplaceTemplate', () => {
    const template: MarketplaceTemplate = {
      id: 'tpl-1',
      name: 'E-Commerce UGC Video Team',
      description: 'Team template for UGC content creation',
      author: 'Crewly',
      category: 'content-creation',
      tags: ['ugc', 'video', 'ecommerce'],
      pricing: { isFree: true, priceUsdCents: 0, requiredTier: 'free' },
      status: 'draft',
      currentVersion: '1.0.0',
      downloads: 0,
      rating: 0,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    expect(template.status).toBe('draft');
    expect(template.category).toBe('content-creation');
    expect(template.pricing.isFree).toBe(true);
  });

  it('should create a valid TemplateVersion', () => {
    const version: TemplateVersion = {
      versionId: 'v-1',
      templateId: 'tpl-1',
      semver: '1.0.0',
      config: { roles: ['director', 'editor'], skills: ['video-edit'] },
      changelog: 'Initial version',
      createdAt: '2026-01-01T00:00:00Z',
    };
    expect(version.semver).toBe('1.0.0');
    expect(version.config).toHaveProperty('roles');
  });

  it('should create a valid TemplatePricing', () => {
    const pricing: TemplatePricing = {
      isFree: false,
      priceUsdCents: 999,
      requiredTier: 'pro',
    };
    expect(pricing.priceUsdCents).toBe(999);
    expect(pricing.requiredTier).toBe('pro');
  });

  it('should create a valid TemplateFilter', () => {
    const filter: TemplateFilter = {
      category: 'development',
      status: 'published',
      search: 'ugc',
      author: 'Crewly',
      sortBy: 'popular',
    };
    expect(filter.category).toBe('development');
    expect(filter.sortBy).toBe('popular');
  });

  it('should create a valid TemplateOperationResult', () => {
    const result: TemplateOperationResult = {
      success: true,
      message: 'Template created',
      template: {
        id: 'tpl-1',
        name: 'Test',
        description: 'Test',
        author: 'Test',
        category: 'custom',
        tags: [],
        pricing: { isFree: true, priceUsdCents: 0, requiredTier: 'free' },
        status: 'draft',
        currentVersion: '1.0.0',
        downloads: 0,
        rating: 0,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    };
    expect(result.success).toBe(true);
    expect(result.template).toBeDefined();
  });

  it('should create a valid TemplateStore', () => {
    const store: TemplateStore = {
      schemaVersion: 1,
      templates: [],
    };
    expect(store.schemaVersion).toBe(1);
    expect(store.templates).toHaveLength(0);
  });

  it('should create a valid TemplateVersionStore', () => {
    const store: TemplateVersionStore = {
      schemaVersion: 1,
      versions: [{
        versionId: 'v-1',
        templateId: 'tpl-1',
        semver: '1.0.0',
        config: {},
        changelog: 'Init',
        createdAt: '2026-01-01T00:00:00Z',
      }],
    };
    expect(store.versions).toHaveLength(1);
  });

  it('should support all PublishStatus values', () => {
    const statuses: PublishStatus[] = ['draft', 'review', 'published', 'archived'];
    expect(statuses).toHaveLength(4);
  });

  it('should support all TemplateCategory values', () => {
    const categories: TemplateCategory[] = [
      'content-creation', 'development', 'marketing', 'operations',
      'research', 'support', 'design', 'sales', 'custom',
    ];
    expect(categories).toHaveLength(9);
  });

  it('should support template with metadata for content-type', () => {
    const template: MarketplaceTemplate = {
      id: 'tpl-2',
      name: 'UGC Video Production',
      description: 'Specialized for e-commerce UGC video production',
      author: 'Crewly',
      category: 'content-creation',
      tags: ['ugc', 'video'],
      pricing: { isFree: false, priceUsdCents: 1999, requiredTier: 'pro' },
      status: 'published',
      currentVersion: '2.0.0',
      downloads: 150,
      rating: 4.5,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
      icon: '🎬',
      metadata: {
        contentType: 'ugc-video',
        platform: 'tiktok',
        teamSize: 4,
      },
    };
    expect(template.metadata?.contentType).toBe('ugc-video');
    expect(template.icon).toBe('🎬');
  });
});
