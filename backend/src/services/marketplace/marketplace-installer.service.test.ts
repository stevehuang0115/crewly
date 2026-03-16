/**
 * Tests for the Marketplace Installer Service.
 *
 * Validates tar.gz extraction, checksum verification, _common/lib.sh
 * provisioning, manifest updates, and uninstall/update flows.
 */

import path from 'path';
import { mkdtemp, rm, readdir, readFile, mkdir, writeFile } from 'fs/promises';
import { tmpdir, homedir } from 'os';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import * as tar from 'tar';
import type { MarketplaceItem } from '../../types/marketplace.types.js';

// ---------------------------------------------------------------------------
// Mock setup — must come before importing the module under test
// ---------------------------------------------------------------------------

// Redirect install paths to a temp directory during tests
let tempDir: string;

jest.mock('./marketplace.service.js', () => {
  const manifestItems: Array<Record<string, unknown>> = [];
  return {
    getInstallPath: (type: string, id: string) => {
      const typeDir = type === 'skill' ? 'skills' : type === 'model' ? 'models' : 'roles';
      // tempDir is set in beforeEach
      return path.join(tempDir, 'marketplace', typeDir, id);
    },
    loadManifest: jest.fn(async () => ({ schemaVersion: 1, items: [...manifestItems] })),
    saveManifest: jest.fn(async (manifest: { items: Array<Record<string, unknown>> }) => {
      manifestItems.length = 0;
      manifestItems.push(...manifest.items);
    }),
  };
});

// Mock findPackageRoot so ensureCommonLibs copies from our temp fixtures
const findPackageRootSpy = jest.fn((_dir: string) => tempDir);
jest.mock('../../utils/package-root.js', () => ({
  findPackageRoot: (dir: string) => findPackageRootSpy(dir),
}));

// Mock skill service and catalog service used by refreshSkillRegistrations
jest.mock('../skill/skill.service.js', () => ({
  getSkillService: () => ({ refresh: jest.fn().mockResolvedValue(undefined) }),
}));

jest.mock('../skill/skill-catalog.service.js', () => ({
  SkillCatalogService: {
    getInstance: () => ({ generateAgentCatalog: jest.fn().mockResolvedValue(undefined) }),
  },
}));

// We import after mocks are set up
import { installItem, uninstallItem, updateItem, ensureCommonLibs } from './marketplace-installer.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a tar.gz buffer from a map of relative filenames to file contents.
 */
async function createTarGz(files: Record<string, string>, baseDir?: string): Promise<Buffer> {
  const dir = baseDir || await mkdtemp(path.join(tmpdir(), 'tar-src-'));
  // Write files into a subdirectory so strip:1 works correctly
  const innerDir = path.join(dir, 'skill');
  await mkdir(innerDir, { recursive: true });

  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(innerDir, name);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }

  const archivePath = path.join(dir, 'archive.tar.gz');
  await tar.c({ gzip: true, file: archivePath, cwd: dir }, ['skill']);

  return readFile(archivePath);
}

/**
 * Convert string to ArrayBuffer for fetch mock (proper Node Buffer to ArrayBuffer conversion).
 */
function toArrayBuffer(str: string): ArrayBuffer {
  const buf = Buffer.from(str);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function makeFakeItem(overrides: Partial<MarketplaceItem> = {}): MarketplaceItem {
  return {
    id: 'test-skill',
    type: 'skill',
    name: 'Test Skill',
    description: 'A test skill',
    author: 'test',
    version: '1.0.0',
    category: 'development',
    tags: ['test'],
    license: 'MIT',
    downloads: 0,
    rating: 5,
    createdAt: '2025-01-01',
    updatedAt: '2025-01-01',
    assets: {
      archive: 'skills/test-skill/test-skill-1.0.0.tar.gz',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('marketplace-installer.service', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'mp-test-'));
    // Reset manifest
    const { loadManifest, saveManifest } = jest.requireMock('./marketplace.service.js');
    loadManifest.mockClear();
    saveManifest.mockClear();
    await saveManifest({ schemaVersion: 1, items: [] });
    findPackageRootSpy.mockClear();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('installItem — tar.gz extraction', () => {
    it('extracts tar.gz archives into the install directory', async () => {
      const archiveBuffer = await createTarGz({
        'execute.sh': '#!/bin/bash\necho hello',
        'skill.json': '{"id":"test-skill"}',
        'instructions.md': '# Test',
      });

      const checksum = 'sha256:' + createHash('sha256').update(archiveBuffer).digest('hex');
      const item = makeFakeItem({
        assets: { archive: 'skills/test-skill/test-skill-1.0.0.tar.gz', checksum },
      });

      // Mock fetch to return our archive
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(archiveBuffer.buffer.slice(
          archiveBuffer.byteOffset,
          archiveBuffer.byteOffset + archiveBuffer.byteLength
        )),
      });

      const result = await installItem(item);
      expect(result.success).toBe(true);
      expect(result.message).toContain('Installed Test Skill v1.0.0');

      // Verify files were extracted (not a raw .tar.gz sitting on disk)
      const installDir = path.join(tempDir, 'marketplace', 'skills', 'test-skill');
      const files = await readdir(installDir);
      expect(files).toContain('execute.sh');
      expect(files).toContain('skill.json');
      expect(files).toContain('instructions.md');

      // Verify content
      const content = await readFile(path.join(installDir, 'execute.sh'), 'utf-8');
      expect(content).toBe('#!/bin/bash\necho hello');
    });

    it('rejects archives with checksum mismatch', async () => {
      const archiveBuffer = await createTarGz({ 'execute.sh': 'echo hi' });

      const item = makeFakeItem({
        assets: {
          archive: 'skills/test-skill/test-skill-1.0.0.tar.gz',
          checksum: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        },
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(archiveBuffer.buffer.slice(
          archiveBuffer.byteOffset,
          archiveBuffer.byteOffset + archiveBuffer.byteLength
        )),
      });

      const result = await installItem(item);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Checksum mismatch');
    });

    it('returns error when no downloadable asset', async () => {
      const item = makeFakeItem({ assets: {} });
      const result = await installItem(item);
      expect(result.success).toBe(false);
      expect(result.message).toContain('No downloadable asset');
    });

    it('returns error on download failure', async () => {
      const item = makeFakeItem();
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      const result = await installItem(item);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Download failed: 404');
    });
  });

  describe('installItem — manifest updates', () => {
    it('adds the installed item to the manifest', async () => {
      const archiveBuffer = await createTarGz({ 'execute.sh': 'echo ok' });
      const item = makeFakeItem();

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(archiveBuffer.buffer.slice(
          archiveBuffer.byteOffset,
          archiveBuffer.byteOffset + archiveBuffer.byteLength
        )),
      });

      const result = await installItem(item);
      expect(result.success).toBe(true);
      expect(result.item).toBeDefined();
      expect(result.item?.id).toBe('test-skill');
      expect(result.item?.version).toBe('1.0.0');

      const { saveManifest } = jest.requireMock('./marketplace.service.js');
      expect(saveManifest).toHaveBeenCalled();
      const savedManifest = saveManifest.mock.calls[saveManifest.mock.calls.length - 1][0];
      expect(savedManifest.items.length).toBe(1);
      expect(savedManifest.items[0].id).toBe('test-skill');
    });
  });

  describe('uninstallItem', () => {
    it('removes directory and manifest entry', async () => {
      // First install an item
      const archiveBuffer = await createTarGz({ 'execute.sh': 'echo ok' });
      const item = makeFakeItem();

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(archiveBuffer.buffer.slice(
          archiveBuffer.byteOffset,
          archiveBuffer.byteOffset + archiveBuffer.byteLength
        )),
      });

      await installItem(item);

      const installDir = path.join(tempDir, 'marketplace', 'skills', 'test-skill');
      expect(existsSync(installDir)).toBe(true);

      // Now uninstall
      const result = await uninstallItem('test-skill');
      expect(result.success).toBe(true);
      expect(existsSync(installDir)).toBe(false);
    });

    it('returns error for non-installed items', async () => {
      const result = await uninstallItem('nonexistent');
      expect(result.success).toBe(false);
      expect(result.message).toContain('not installed');
    });
  });

  describe('updateItem', () => {
    it('uninstalls then reinstalls with new version', async () => {
      const archiveBuffer = await createTarGz({ 'execute.sh': 'echo v1' });
      const item = makeFakeItem();

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(archiveBuffer.buffer.slice(
          archiveBuffer.byteOffset,
          archiveBuffer.byteOffset + archiveBuffer.byteLength
        )),
      });

      await installItem(item);

      // Update with v2
      const archiveV2 = await createTarGz({ 'execute.sh': 'echo v2' });
      const itemV2 = makeFakeItem({ version: '2.0.0' });

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(archiveV2.buffer.slice(
          archiveV2.byteOffset,
          archiveV2.byteOffset + archiveV2.byteLength
        )),
      });

      const result = await updateItem(itemV2);
      expect(result.success).toBe(true);
      expect(result.message).toContain('v2.0.0');
    });
  });

  describe('installItem — local asset loading', () => {
    const localAssetsBase = path.join(homedir(), '.crewly', 'marketplace', 'assets');
    const localAssetDir = path.join(localAssetsBase, 'skills', 'local-skill');
    const localAssetFile = path.join(localAssetDir, 'local-skill-1.0.0.tar.gz');

    afterEach(async () => {
      await rm(localAssetDir, { recursive: true, force: true });
    });

    it('installs from local assets when file exists on disk', async () => {
      // Create a tar.gz archive and place it in the local assets directory
      const archiveBuffer = await createTarGz({
        'execute.sh': '#!/bin/bash\necho local',
        'skill.json': '{"id":"local-skill"}',
      });

      await mkdir(localAssetDir, { recursive: true });
      await writeFile(localAssetFile, archiveBuffer);

      const item = makeFakeItem({
        id: 'local-skill',
        name: 'Local Skill',
        assets: { archive: 'skills/local-skill/local-skill-1.0.0.tar.gz' },
      });

      // Set up fetch to fail — should NOT be called
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      const result = await installItem(item);
      expect(result.success).toBe(true);
      expect(result.message).toContain('Installed Local Skill');

      // Verify fetch was NOT called (asset loaded from local disk)
      expect(global.fetch).not.toHaveBeenCalled();

      // Verify files were extracted
      const installDir = path.join(tempDir, 'marketplace', 'skills', 'local-skill');
      const files = await readdir(installDir);
      expect(files).toContain('execute.sh');
    });

    it('falls back to remote download when local asset does not exist', async () => {
      const archiveBuffer = await createTarGz({ 'execute.sh': 'echo remote' });
      const item = makeFakeItem({
        assets: { archive: 'skills/test-skill/test-skill-1.0.0.tar.gz' },
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(archiveBuffer.buffer.slice(
          archiveBuffer.byteOffset,
          archiveBuffer.byteOffset + archiveBuffer.byteLength
        )),
      });

      const result = await installItem(item);
      expect(result.success).toBe(true);

      // Verify fetch WAS called (no local asset)
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe('ensureCommonLibs', () => {
    it('copies agent and root _common/lib.sh to marketplace directory', async () => {
      // Set up source files in temp dir (our mocked package root)
      const agentCommonDir = path.join(tempDir, 'config', 'skills', 'agent', '_common');
      const rootCommonDir = path.join(tempDir, 'config', 'skills', '_common');
      await mkdir(agentCommonDir, { recursive: true });
      await mkdir(rootCommonDir, { recursive: true });
      await writeFile(path.join(agentCommonDir, 'lib.sh'), '#!/bin/bash\n# agent common');
      await writeFile(path.join(rootCommonDir, 'lib.sh'), '#!/bin/bash\n# root common');

      await ensureCommonLibs();

      // Verify findPackageRoot was called to resolve the package root
      expect(findPackageRootSpy).toHaveBeenCalled();
    });
  });

  describe('installItem — GitHub-sourced skills', () => {
    it('successfully installs by downloading SKILL.md and execute.sh individually', async () => {
      const item = makeFakeItem({
        id: 'github-skill',
        name: 'GitHub Skill',
        assets: { archive: 'config/skills/agent/github-skill' },
      });

      // Mock fetch to return individual files
      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('SKILL.md')) {
          return Promise.resolve({
            ok: true,
            arrayBuffer: () => Promise.resolve(toArrayBuffer('---\nname: GitHub Skill\n---\n# GitHub Skill')),
          });
        }
        if (url.includes('execute.sh')) {
          return Promise.resolve({
            ok: true,
            arrayBuffer: () => Promise.resolve(toArrayBuffer('#!/bin/bash\necho github')),
          });
        }
        return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' });
      });

      const result = await installItem(item);
      expect(result.success).toBe(true);
      expect(result.message).toContain('Installed GitHub Skill v1.0.0');

      // Verify files were downloaded
      const installDir = path.join(tempDir, 'marketplace', 'skills', 'github-skill');
      const files = await readdir(installDir);
      expect(files).toContain('SKILL.md');
      expect(files).toContain('execute.sh');

      // Verify content
      const executeContent = await readFile(path.join(installDir, 'execute.sh'), 'utf-8');
      expect(executeContent).toBe('#!/bin/bash\necho github');
    });

    it('installs with only SKILL.md when execute.sh is missing but not required', async () => {
      const item = makeFakeItem({
        id: 'minimal-skill',
        name: 'Minimal Skill',
        assets: { archive: 'config/skills/agent/minimal-skill' },
        metadata: { skillType: 'mcp', files: ['SKILL.md'] },
      });

      // Mock fetch to return only SKILL.md
      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('SKILL.md')) {
          return Promise.resolve({
            ok: true,
            arrayBuffer: () => Promise.resolve(toArrayBuffer('---\nname: Minimal\n---')),
          });
        }
        return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' });
      });

      const result = await installItem(item);
      expect(result.success).toBe(true);
      expect(result.message).toContain('Installed Minimal Skill v1.0.0');

      // Verify only SKILL.md exists
      const installDir = path.join(tempDir, 'marketplace', 'skills', 'minimal-skill');
      const files = await readdir(installDir);
      expect(files).toContain('SKILL.md');
    });

    it('fails if SKILL.md returns 404', async () => {
      const item = makeFakeItem({
        id: 'broken-skill',
        name: 'Broken Skill',
        assets: { archive: 'config/skills/agent/broken-skill' },
      });

      // Mock fetch to fail on SKILL.md
      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('SKILL.md')) {
          return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' });
        }
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(toArrayBuffer('content')),
        });
      });

      const result = await installItem(item);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to download SKILL.md');
    });

    it('fails if execute.sh returns 404', async () => {
      const item = makeFakeItem({
        id: 'no-exec-skill',
        name: 'No Exec Skill',
        assets: { archive: 'config/skills/agent/no-exec-skill' },
      });

      // Mock fetch to fail on execute.sh
      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('execute.sh')) {
          return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' });
        }
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(toArrayBuffer('content')),
        });
      });

      const result = await installItem(item);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to download execute.sh');
    });
  });

  describe('installItem — checksum validation edge cases', () => {
    it('returns error for invalid checksum format (no colon separator)', async () => {
      const archiveBuffer = await createTarGz({ 'execute.sh': 'echo hi' });

      const item = makeFakeItem({
        assets: {
          archive: 'skills/test-skill/test-skill-1.0.0.tar.gz',
          checksum: 'invalidformatwithnocolon',
        },
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(archiveBuffer.buffer.slice(
          archiveBuffer.byteOffset,
          archiveBuffer.byteOffset + archiveBuffer.byteLength
        )),
      });

      const result = await installItem(item);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid checksum format');
      expect(result.message).toContain('expected "algo:hash"');
    });

    it('returns error for unsupported checksum algorithm (e.g., "md5:abc123")', async () => {
      const archiveBuffer = await createTarGz({ 'execute.sh': 'echo hi' });

      const item = makeFakeItem({
        assets: {
          archive: 'skills/test-skill/test-skill-1.0.0.tar.gz',
          checksum: 'md5:5d41402abc4b2a76b9719d911017c592',
        },
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(archiveBuffer.buffer.slice(
          archiveBuffer.byteOffset,
          archiveBuffer.byteOffset + archiveBuffer.byteLength
        )),
      });

      const result = await installItem(item);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unsupported checksum algorithm "md5"');
      expect(result.message).toContain('Only sha256 is supported');
    });
  });

  describe('installItem — non-archive assets (model files)', () => {
    it('writes raw file instead of extracting when item type is model with no .tar.gz in assetPath', async () => {
      const modelData = Buffer.from('MOCK_MODEL_BINARY_DATA');

      const item = makeFakeItem({
        id: 'test-model',
        name: 'Test Model',
        type: 'model',
        assets: {
          model: 'models/test-model/model.bin',
        },
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(modelData.buffer.slice(
          modelData.byteOffset,
          modelData.byteOffset + modelData.byteLength
        )),
      });

      const result = await installItem(item);
      expect(result.success).toBe(true);
      expect(result.message).toContain('Installed Test Model v1.0.0');

      // Verify raw file was written (not extracted as archive)
      const installDir = path.join(tempDir, 'marketplace', 'models', 'test-model');
      const files = await readdir(installDir);
      expect(files).toContain('model.bin');

      // Verify content is exactly what we sent
      const content = await readFile(path.join(installDir, 'model.bin'));
      expect(content.toString()).toBe('MOCK_MODEL_BINARY_DATA');
    });

    it('writes raw file for skill asset with non-.tar.gz extension', async () => {
      const rawData = Buffer.from('#!/bin/bash\necho raw install');

      const item = makeFakeItem({
        id: 'raw-skill',
        name: 'Raw Skill',
        assets: {
          archive: 'skills/raw-skill/install.sh',
        },
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(rawData.buffer.slice(
          rawData.byteOffset,
          rawData.byteOffset + rawData.byteLength
        )),
      });

      const result = await installItem(item);
      expect(result.success).toBe(true);

      // Verify raw file exists
      const installDir = path.join(tempDir, 'marketplace', 'skills', 'raw-skill');
      const files = await readdir(installDir);
      expect(files).toContain('install.sh');

      const content = await readFile(path.join(installDir, 'install.sh'), 'utf-8');
      expect(content).toBe('#!/bin/bash\necho raw install');
    });
  });
});
