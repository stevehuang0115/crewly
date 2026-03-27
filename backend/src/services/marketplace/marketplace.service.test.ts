/**
 * Tests for MarketplaceService
 * Covers registry fetching, caching, manifest I/O, filtering, sorting, and status enrichment.
 */

import {
  fetchRegistry,
  loadManifest,
  saveManifest,
  getItem,
  listItems,
  getUpdatableItems,
  getInstalledItems,
  searchItems,
  getInstallPath,
  resetRegistryCache,
  getItemReadme,
} from './marketplace.service.js';
import type { InstalledItemsManifest } from '../../types/marketplace.types.js';
import { MARKETPLACE_CONSTANTS } from '../../constants.js';

// Mock fs/promises
jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  writeFile: jest.fn().mockResolvedValue(undefined),
  mkdir: jest.fn().mockResolvedValue(undefined),
}));

const { readFile, writeFile, mkdir } = require('fs/promises') as {
  readFile: jest.Mock;
  writeFile: jest.Mock;
  mkdir: jest.Mock;
};

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

// --- Test fixtures ---

function makeItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'skill-1',
    type: 'skill',
    name: 'Code Reviewer',
    description: 'Automated code review skill',
    author: 'crewly',
    version: '1.2.0',
    category: 'development',
    tags: ['review', 'quality'],
    license: 'MIT',
    downloads: 500,
    rating: 4.5,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-06-01T00:00:00Z',
    assets: {},
    ...overrides,
  };
}

const sampleRegistry = {
  schemaVersion: 1,
  lastUpdated: '2025-06-01T00:00:00Z',
  cdnBaseUrl: 'https://cdn.example.com',
  items: [
    makeItem({ id: 'skill-1', name: 'Code Reviewer', downloads: 500, rating: 4.5, createdAt: '2025-01-01T00:00:00Z' }),
    makeItem({ id: 'skill-2', name: 'Bug Finder', description: 'Finds bugs automatically', downloads: 1000, rating: 3.8, category: 'quality', tags: ['testing', 'bugs'], createdAt: '2025-06-01T00:00:00Z' }),
    makeItem({ id: 'role-1', name: 'Security Auditor', type: 'role', downloads: 200, rating: 4.9, category: 'security', tags: ['security'], createdAt: '2025-03-01T00:00:00Z' }),
  ],
};

const sampleManifest: InstalledItemsManifest = {
  schemaVersion: 1,
  items: [
    { id: 'skill-1', type: 'skill' as const, name: 'Code Reviewer', version: '1.0.0', installedAt: '2025-02-01', installPath: '/path' },
  ],
};

// --- Setup ---

beforeEach(() => {
  jest.clearAllMocks();
  resetRegistryCache();

  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(structuredClone(sampleRegistry)),
  });

  // Default: manifest not found (empty)
  readFile.mockRejectedValue(new Error('ENOENT'));
});

// --- Tests ---

describe('fetchRegistry', () => {
  it('should fetch registry from both public and premium sources', async () => {
    const registry = await fetchRegistry();

    // 2 fetch calls: public (GitHub) + premium (stevesprompt)
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(registry.items).toHaveLength(3);
  });

  it('should return cached registry within TTL', async () => {
    await fetchRegistry();
    await fetchRegistry();

    // Only the first call fetches (2 calls), second is cached
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should bypass cache when forceRefresh is true', async () => {
    await fetchRegistry();
    await fetchRegistry(true);

    // 2 calls per fetch x 2 fetches = 4
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('should fall back to cached registry on fetch failure', async () => {
    // First fetch succeeds (2 calls)
    await fetchRegistry();

    // Second fetch: both public and premium fail
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' })
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' });
    const registry = await fetchRegistry(true);

    expect(registry.items).toHaveLength(3);
  });

  it('should return empty registry when fetch fails with no cache', async () => {
    // Both public and premium fail
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' })
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' });
    // Also mock readFile for local-registry.json to return nothing
    readFile.mockRejectedValue(new Error('ENOENT'));

    const registry = await fetchRegistry();
    expect(registry.schemaVersion).toBe(MARKETPLACE_CONSTANTS.SCHEMA_VERSION);
    expect(registry.items).toHaveLength(0);
  });
});

describe('loadManifest', () => {
  it('should return empty manifest when file does not exist', async () => {
    readFile.mockRejectedValue(new Error('ENOENT'));

    const manifest = await loadManifest();

    expect(manifest).toEqual({ schemaVersion: 1, items: [] });
  });

  it('should return empty manifest when JSON is invalid', async () => {
    readFile.mockResolvedValue('{ invalid json }');

    const manifest = await loadManifest();

    expect(manifest).toEqual({ schemaVersion: 1, items: [] });
  });

  it('should parse manifest from disk', async () => {
    readFile.mockResolvedValue(JSON.stringify(sampleManifest));

    const manifest = await loadManifest();

    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0].id).toBe('skill-1');
  });
});

describe('saveManifest', () => {
  it('should create directory and write manifest', async () => {
    await saveManifest(sampleManifest);

    expect(mkdir).toHaveBeenCalledWith(expect.stringContaining('marketplace'), { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('manifest.json'),
      expect.stringContaining('"schemaVersion": 1'),
    );
  });
});

describe('enrichWithStatus (via getItem)', () => {
  it('should return not_installed when item is not in manifest', async () => {
    const item = await getItem('skill-2');

    expect(item).not.toBeNull();
    expect(item!.installStatus).toBe('not_installed');
    expect(item!.installedVersion).toBeUndefined();
  });

  it('should return update_available when versions differ', async () => {
    // skill-1 is v1.2.0 in registry, v1.0.0 in manifest
    readFile.mockResolvedValue(JSON.stringify(sampleManifest));

    const item = await getItem('skill-1');

    expect(item!.installStatus).toBe('update_available');
    expect(item!.installedVersion).toBe('1.0.0');
  });

  it('should return installed when versions match', async () => {
    const manifest: InstalledItemsManifest = {
      schemaVersion: 1,
      items: [{ id: 'skill-1', type: 'skill' as const, name: 'Code Reviewer', version: '1.2.0', installedAt: '2025-02-01', installPath: '/path' }],
    };
    readFile.mockResolvedValue(JSON.stringify(manifest));

    const item = await getItem('skill-1');

    expect(item!.installStatus).toBe('installed');
    expect(item!.installedVersion).toBe('1.2.0');
  });

  it('should return null for non-existent item', async () => {
    const item = await getItem('does-not-exist');
    expect(item).toBeNull();
  });
});

describe('listItems', () => {
  it('should return all items with no filter', async () => {
    const items = await listItems();

    expect(items).toHaveLength(3);
  });

  it('should filter by type', async () => {
    const items = await listItems({ type: 'role' });

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('role-1');
  });

  it('should filter by category', async () => {
    const items = await listItems({ category: 'quality' });

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('skill-2');
  });

  it('should filter by search query matching name', async () => {
    const items = await listItems({ search: 'bug' });

    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('Bug Finder');
  });

  it('should filter by search query matching tags', async () => {
    const items = await listItems({ search: 'security' });

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('role-1');
  });

  it('should sort by popular (downloads) by default', async () => {
    const items = await listItems();

    expect(items[0].downloads).toBeGreaterThanOrEqual(items[1].downloads);
    expect(items[1].downloads).toBeGreaterThanOrEqual(items[2].downloads);
  });

  it('should sort by rating', async () => {
    const items = await listItems({ sortBy: 'rating' });

    expect(items[0].rating).toBeGreaterThanOrEqual(items[1].rating);
  });

  it('should sort by newest', async () => {
    const items = await listItems({ sortBy: 'newest' });

    expect(new Date(items[0].createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(items[1].createdAt).getTime()
    );
  });

  it('should combine type and search filters', async () => {
    const items = await listItems({ type: 'skill', search: 'review' });

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('skill-1');
  });
});

describe('getUpdatableItems', () => {
  it('should return items that have updates available', async () => {
    readFile.mockResolvedValue(JSON.stringify(sampleManifest));

    const items = await getUpdatableItems();

    expect(items.length).toBeGreaterThanOrEqual(1);
    items.forEach((item) => {
      expect(item.installStatus).toBe('update_available');
    });
  });
});

describe('getInstalledItems', () => {
  it('should return manifest items', async () => {
    readFile.mockResolvedValue(JSON.stringify(sampleManifest));

    const items = await getInstalledItems();

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('skill-1');
  });

  it('should return empty array when no manifest exists', async () => {
    const items = await getInstalledItems();
    expect(items).toHaveLength(0);
  });
});

describe('searchItems', () => {
  it('should delegate to listItems with search filter', async () => {
    const items = await searchItems('bug');

    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('Bug Finder');
  });
});

describe('getInstallPath', () => {
  it('should map skill type to skills directory', () => {
    const p = getInstallPath('skill', 'my-skill');
    expect(p).toContain('skills');
    expect(p).toContain('my-skill');
  });

  it('should map model type to models directory', () => {
    const p = getInstallPath('model', 'my-model');
    expect(p).toContain('models');
  });

  it('should map role type to roles directory', () => {
    const p = getInstallPath('role', 'my-role');
    expect(p).toContain('roles');
  });

  it('should throw on path traversal attempt', () => {
    expect(() => getInstallPath('skill', '../etc/passwd')).toThrow('Invalid marketplace item ID');
  });

  it('should throw on IDs with special characters', () => {
    expect(() => getInstallPath('skill', 'my skill')).toThrow('Invalid marketplace item ID');
  });

  it('should throw on IDs starting with hyphen', () => {
    expect(() => getInstallPath('skill', '-bad-id')).toThrow('Invalid marketplace item ID');
  });
});

describe('getItemReadme', () => {
  beforeEach(() => {
    readFile.mockReset();
  });

  it('should return README.md content when file exists', async () => {
    readFile.mockImplementation(async (filePath: string) => {
      if (filePath.includes('skills') && filePath.endsWith('README.md')) {
        return '# Test Skill\n\nDoes great things.';
      }
      throw new Error('ENOENT');
    });

    const result = await getItemReadme('test-skill');
    expect(result).toBe('# Test Skill\n\nDoes great things.');
  });

  it('should return null when no README exists', async () => {
    readFile.mockRejectedValue(new Error('ENOENT'));

    const result = await getItemReadme('no-readme');
    expect(result).toBeNull();
  });

  it('should try SKILL.md as fallback', async () => {
    readFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('SKILL.md')) {
        return '# Skill Instructions';
      }
      throw new Error('ENOENT');
    });

    const result = await getItemReadme('fallback-skill');
    expect(result).toBe('# Skill Instructions');
  });

  it('should throw on invalid item ID', async () => {
    await expect(getItemReadme('../evil')).rejects.toThrow('Invalid marketplace item ID');
  });
});
