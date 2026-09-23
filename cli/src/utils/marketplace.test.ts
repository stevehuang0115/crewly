/**
 * Tests for CLI marketplace utilities.
 *
 * Validates registry fetching, manifest management, download/install flow,
 * and byte formatting.
 */

import path from 'path';
import { mkdtemp, rm, readdir, readFile, mkdir, writeFile } from 'fs/promises';
import { tmpdir, homedir } from 'os';
import { mkdtempSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import * as tar from 'tar';

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

// Initialize tempDir before module import (os.homedir is called lazily, so this works)
let tempDir: string = mkdtempSync(path.join(tmpdir(), 'mp-cli-init-'));

// Mock os.homedir to use temp dir for marketplace paths
jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return {
    ...actual,
    homedir: () => tempDir,
  };
});

import {
  fetchRegistry,
  loadManifest,
  saveManifest,
  downloadAndInstall,
  getInstallPath,
  formatBytes,
  checkSkillsInstalled,
  installAllSkills,
  countBundledSkills,
  type MarketplaceItem,
} from './marketplace.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTarGz(files: Record<string, string>): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'tar-src-'));
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
 * Converts a text string to a proper ArrayBuffer for fetch mocking.
 * This ensures we don't have shared buffer issues.
 */
function textToArrayBuffer(text: string): ArrayBuffer {
  const buf = Buffer.from(text);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Creates a mock fetch response that returns a JSON registry.
 * Used as a default mock for tests that call fetchRegistry() internally.
 */
function makeRegistryResponse(items: MarketplaceItem[]) {
  return {
    ok: true,
    json: () => Promise.resolve({
      schemaVersion: 1,
      lastUpdated: '2025-01-01',
      cdnBaseUrl: '',
      items,
    }),
  };
}

function makeFakeItem(overrides: Partial<MarketplaceItem> = {}): MarketplaceItem {
  return {
    id: 'skill-test',
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
      archive: 'skills/skill-test/skill-test-1.0.0.tar.gz',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cli/utils/marketplace', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'mp-cli-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  describe('fetchRegistry', () => {
    it('returns the registry from the API', async () => {
      const fakeRegistry = {
        schemaVersion: 1,
        lastUpdated: '2025-01-01',
        cdnBaseUrl: 'https://crewlyai.com',
        items: [makeFakeItem()],
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(fakeRegistry),
      });

      const result = await fetchRegistry();
      expect(result.items.length).toBe(1);
      expect(result.items[0].id).toBe('skill-test');
    });

    it('throws on fetch failure', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(fetchRegistry()).rejects.toThrow('Failed to fetch registry');
    });

    it('merges registries with premium items taking priority', async () => {
      global.fetch = jest.fn()
        // First call: public registry (fetched in parallel)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            schemaVersion: 1,
            lastUpdated: '2025-01-01',
            cdnBaseUrl: '',
            items: [
              makeFakeItem({ id: 'skill-public', name: 'Public Skill', version: '1.0.0' }),
              makeFakeItem({ id: 'skill-shared', name: 'Public Version', version: '1.0.0' }),
            ],
          }),
        })
        // Second call: premium registry (fetched in parallel)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            schemaVersion: 1,
            lastUpdated: '2025-01-01',
            cdnBaseUrl: '',
            items: [
              makeFakeItem({ id: 'skill-premium', name: 'Premium Skill', version: '2.0.0' }),
              makeFakeItem({ id: 'skill-shared', name: 'Premium Version', version: '2.0.0' }),
            ],
          }),
        });

      const result = await fetchRegistry();

      // Should have 3 total items (1 public, 1 premium, 1 shared)
      expect(result.items.length).toBe(3);

      // Premium version of shared skill should override public
      const sharedSkill = result.items.find(i => i.id === 'skill-shared');
      expect(sharedSkill?.name).toBe('Premium Version');
      expect(sharedSkill?.version).toBe('2.0.0');

      // Other skills should be present
      expect(result.items.find(i => i.id === 'skill-public')).toBeDefined();
      expect(result.items.find(i => i.id === 'skill-premium')).toBeDefined();
    });

    it('succeeds when only one source is available', async () => {
      global.fetch = jest.fn()
        // Public registry fails
        .mockRejectedValueOnce(new Error('network error'))
        // Premium registry succeeds
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            schemaVersion: 1,
            lastUpdated: '2025-01-01',
            cdnBaseUrl: '',
            items: [makeFakeItem({ id: 'premium-only', name: 'Premium Only' })],
          }),
        });

      const result = await fetchRegistry();
      expect(result.items.length).toBe(1);
      expect(result.items[0].id).toBe('premium-only');
    });
  });

  describe('manifest management', () => {
    it('returns empty manifest when none exists', async () => {
      const manifest = await loadManifest();
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.items).toEqual([]);
    });

    it('saves and loads manifest', async () => {
      const manifest = {
        schemaVersion: 1,
        items: [{ id: 'test', type: 'skill', name: 'Test', version: '1.0.0', installedAt: '', installPath: '' }],
      };
      await saveManifest(manifest);
      const loaded = await loadManifest();
      expect(loaded.items.length).toBe(1);
      expect(loaded.items[0].id).toBe('test');
    });
  });

  describe('getInstallPath', () => {
    it('maps skill type to skills directory', () => {
      const p = getInstallPath('skill', 'my-skill');
      expect(p).toContain(path.join('marketplace', 'skills', 'my-skill'));
    });

    it('maps model type to models directory', () => {
      const p = getInstallPath('model', 'my-model');
      expect(p).toContain(path.join('marketplace', 'models', 'my-model'));
    });

    it('throws on path traversal attempt', () => {
      expect(() => getInstallPath('skill', '../etc/passwd')).toThrow('Invalid marketplace item ID');
    });

    it('throws on IDs with special characters', () => {
      expect(() => getInstallPath('skill', 'my skill')).toThrow('Invalid marketplace item ID');
      expect(() => getInstallPath('skill', 'UPPERCASE')).toThrow('Invalid marketplace item ID');
      expect(() => getInstallPath('skill', '-starts-with-hyphen')).toThrow('Invalid marketplace item ID');
    });

    it('accepts valid IDs with hyphens and numbers', () => {
      expect(() => getInstallPath('skill', 'my-skill-2')).not.toThrow();
      expect(() => getInstallPath('skill', 'a')).not.toThrow();
      expect(() => getInstallPath('skill', '1-test')).not.toThrow();
    });
  });

  describe('downloadAndInstall', () => {
    it('extracts tar.gz and updates manifest', async () => {
      const archiveBuffer = await createTarGz({
        'execute.sh': '#!/bin/bash\necho hello',
        'skill.json': '{"id":"skill-test"}',
      });

      const checksum = 'sha256:' + createHash('sha256').update(archiveBuffer).digest('hex');
      const item = makeFakeItem({
        assets: { archive: 'skills/skill-test/skill-test-1.0.0.tar.gz', checksum },
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(
          archiveBuffer.buffer.slice(archiveBuffer.byteOffset, archiveBuffer.byteOffset + archiveBuffer.byteLength)
        ),
      });

      const result = await downloadAndInstall(item);
      expect(result.success).toBe(true);

      // Verify files extracted
      const installDir = getInstallPath('skill', 'skill-test');
      const files = await readdir(installDir);
      expect(files).toContain('execute.sh');
      expect(files).toContain('skill.json');

      // Verify manifest updated
      const manifest = await loadManifest();
      expect(manifest.items.length).toBe(1);
      expect(manifest.items[0].id).toBe('skill-test');
    });

    it('returns error on checksum mismatch', async () => {
      const archiveBuffer = await createTarGz({ 'execute.sh': 'echo hi' });
      const item = makeFakeItem({
        assets: {
          archive: 'skills/skill-test/skill-test-1.0.0.tar.gz',
          checksum: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        },
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(
          archiveBuffer.buffer.slice(archiveBuffer.byteOffset, archiveBuffer.byteOffset + archiveBuffer.byteLength)
        ),
      });

      const result = await downloadAndInstall(item);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Checksum mismatch');
    });

    it('returns error for invalid checksum format', async () => {
      const archiveBuffer = await createTarGz({ 'execute.sh': 'echo hi' });
      const item = makeFakeItem({
        assets: {
          archive: 'skills/skill-test/skill-test-1.0.0.tar.gz',
          checksum: 'nocolonhere',
        },
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(
          archiveBuffer.buffer.slice(archiveBuffer.byteOffset, archiveBuffer.byteOffset + archiveBuffer.byteLength)
        ),
      });

      const result = await downloadAndInstall(item);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid checksum format');
    });

    it('returns error for unsupported checksum algorithm', async () => {
      const archiveBuffer = await createTarGz({ 'execute.sh': 'echo hi' });
      const item = makeFakeItem({
        assets: {
          archive: 'skills/skill-test/skill-test-1.0.0.tar.gz',
          checksum: 'md5:abc123',
        },
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(
          archiveBuffer.buffer.slice(archiveBuffer.byteOffset, archiveBuffer.byteOffset + archiveBuffer.byteLength)
        ),
      });

      const result = await downloadAndInstall(item);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unsupported checksum algorithm');
      expect(result.message).toContain('md5');
    });

    it('cleans up install directory on download failure', async () => {
      const item = makeFakeItem({
        assets: {
          archive: 'skills/skill-test/skill-test-1.0.0.tar.gz',
        },
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Server Error',
      });

      const installDir = getInstallPath('skill', 'skill-test');
      const result = await downloadAndInstall(item);
      expect(result.success).toBe(false);

      // Install directory should be cleaned up
      expect(existsSync(installDir)).toBe(false);
    });

    it('installs GitHub-sourced skill by downloading individual files', async () => {
      const item = makeFakeItem({
        id: 'github-skill',
        assets: { archive: 'config/skills/agent/core/github-skill' }, // GitHub path, no .tar.gz
      });

      const mockFiles: Record<string, string> = {
        'skill.json': '{"id":"github-skill"}',
        'execute.sh': '#!/bin/bash\necho github',
        'instructions.md': '# Instructions',
      };

      global.fetch = jest.fn().mockImplementation(async (url: string) => {
        const filename = url.split('/').pop();
        if (filename && mockFiles[filename]) {
          return {
            ok: true,
            arrayBuffer: () => Promise.resolve(textToArrayBuffer(mockFiles[filename])),
          };
        }
        return { ok: false, status: 404, statusText: 'Not Found' };
      });

      const result = await downloadAndInstall(item);
      expect(result.success).toBe(true);

      // Verify all files were written
      const installDir = getInstallPath('skill', 'github-skill');
      const files = await readdir(installDir);
      expect(files).toContain('skill.json');
      expect(files).toContain('execute.sh');
      expect(files).toContain('instructions.md');

      const skillJsonContent = await readFile(path.join(installDir, 'skill.json'), 'utf-8');
      expect(skillJsonContent).toBe('{"id":"github-skill"}');
    });

    it('skips instructions.md on 404 for GitHub-sourced skills', async () => {
      const item = makeFakeItem({
        id: 'github-skill-no-docs',
        assets: { archive: 'config/skills/agent/core/github-skill-no-docs' },
      });

      global.fetch = jest.fn().mockImplementation(async (url: string) => {
        const filename = url.split('/').pop();
        if (filename === 'skill.json') {
          return {
            ok: true,
            arrayBuffer: () => Promise.resolve(textToArrayBuffer('{"id":"test"}')),
          };
        }
        if (filename === 'execute.sh') {
          return {
            ok: true,
            arrayBuffer: () => Promise.resolve(textToArrayBuffer('#!/bin/bash')),
          };
        }
        // instructions.md returns 404
        return { ok: false, status: 404, statusText: 'Not Found' };
      });

      const result = await downloadAndInstall(item);
      expect(result.success).toBe(true); // Should succeed even without instructions.md

      const installDir = getInstallPath('skill', 'github-skill-no-docs');
      const files = await readdir(installDir);
      expect(files).toContain('skill.json');
      expect(files).toContain('execute.sh');
      expect(files).not.toContain('instructions.md');
    });

    it('succeeds when execute.sh returns 404 for GitHub-sourced skills (MCP/prompt-only skills)', async () => {
      const item = makeFakeItem({
        id: 'github-skill-no-exec',
        assets: { archive: 'config/skills/agent/core/github-skill-no-exec' },
      });

      global.fetch = jest.fn().mockImplementation(async (url: string) => {
        const filename = url.split('/').pop();
        if (filename === 'skill.json') {
          return {
            ok: true,
            arrayBuffer: () => Promise.resolve(textToArrayBuffer('{"id":"test"}')),
          };
        }
        // execute.sh and instructions.md return 404 — only skill.json is required
        return { ok: false, status: 404, statusText: 'Not Found' };
      });

      const result = await downloadAndInstall(item);
      expect(result.success).toBe(true);
    });

    it('fails loudly, naming both manifests, when a GitHub skill has neither SKILL.md nor skill.json', async () => {
      const item = makeFakeItem({
        id: 'github-skill-missing',
        assets: { archive: 'config/skills/agent/core/github-skill-missing' },
      });

      global.fetch = jest.fn().mockImplementation(async () => {
        return { ok: false, status: 404, statusText: 'Not Found' };
      });

      const result = await downloadAndInstall(item);
      expect(result.success).toBe(false);
      expect(result.message).toContain('No skill manifest');
      expect(result.message).toContain('config/skills/agent/core/github-skill-missing');
      expect(result.message).toContain('SKILL.md: 404');
      expect(result.message).toContain('skill.json: 404');
    });

    it('returns error for items with no downloadable asset', async () => {
      const item = makeFakeItem({
        id: 'no-asset-skill',
        assets: {}, // No archive, no model
      });

      const result = await downloadAndInstall(item);
      expect(result.success).toBe(false);
      expect(result.message).toBe('No downloadable asset for no-asset-skill');
    });
  });

  describe('formatBytes', () => {
    it('formats bytes', () => {
      expect(formatBytes(500)).toBe('500 B');
    });

    it('formats kilobytes', () => {
      expect(formatBytes(18841)).toBe('18.4 KB');
    });

    it('formats megabytes', () => {
      expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
    });
  });

  describe('checkSkillsInstalled', () => {
    it('returns correct installed and total counts', async () => {
      // Save a manifest with one installed skill
      await saveManifest({
        schemaVersion: 1,
        items: [
          { id: 'skill-a', type: 'skill', name: 'A', version: '1.0.0', installedAt: '', installPath: '' },
        ],
      });

      // Mock registry with two skills and a model (both parallel fetches return same data)
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          schemaVersion: 1,
          lastUpdated: '2025-01-01',
          cdnBaseUrl: '',
          items: [
            makeFakeItem({ id: 'skill-a', name: 'Skill A' }),
            makeFakeItem({ id: 'skill-b', name: 'Skill B' }),
            makeFakeItem({ id: 'model-c', type: 'model', name: 'Model C' }),
          ],
        }),
      });

      const result = await checkSkillsInstalled();
      expect(result.installed).toBe(1);
      expect(result.total).toBe(2); // Only skills, not models
    });

    it('returns zero when no manifest exists', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          schemaVersion: 1,
          lastUpdated: '2025-01-01',
          cdnBaseUrl: '',
          items: [makeFakeItem()],
        }),
      });

      const result = await checkSkillsInstalled();
      expect(result.installed).toBe(0);
      expect(result.total).toBe(1);
    });
  });

  describe('installAllSkills', () => {
    it('installs all skills and returns count', async () => {
      const archiveBuffer = await createTarGz({
        'execute.sh': '#!/bin/bash\necho hello',
      });

      const registryResponse = makeRegistryResponse([
        makeFakeItem({ id: 'skill-a', name: 'Skill A' }),
        makeFakeItem({ id: 'skill-b', name: 'Skill B' }),
      ]);

      global.fetch = jest.fn()
        // First two calls: parallel fetchRegistry (public + premium)
        .mockResolvedValueOnce(registryResponse)
        .mockResolvedValueOnce(registryResponse)
        // Subsequent calls: downloadAndInstall fetch
        .mockResolvedValue({
          ok: true,
          arrayBuffer: () => Promise.resolve(
            archiveBuffer.buffer.slice(archiveBuffer.byteOffset, archiveBuffer.byteOffset + archiveBuffer.byteLength),
          ),
        });

      const progress: Array<{ name: string; index: number; total: number }> = [];
      const result = await installAllSkills((name, index, total) => {
        progress.push({ name, index, total });
      });

      expect(result).toEqual({ total: 2, installed: 2, failed: [] });
      expect(progress).toHaveLength(2);
      expect(progress[0]).toEqual({ name: 'Skill A', index: 1, total: 2 });
      expect(progress[1]).toEqual({ name: 'Skill B', index: 2, total: 2 });
    });

    it('calls onProgress even when install fails', async () => {
      const registryResponse = makeRegistryResponse([
        makeFakeItem({ id: 'skill-fail', name: 'Fail Skill', assets: {} }),
      ]);

      global.fetch = jest.fn()
        // Both parallel fetchRegistry calls
        .mockResolvedValueOnce(registryResponse)
        .mockResolvedValueOnce(registryResponse);

      const progress: string[] = [];
      const result = await installAllSkills((name) => { progress.push(name); });

      expect(result.installed).toBe(0);
      expect(result.failed).toEqual([
        { id: 'skill-fail', name: 'Fail Skill', message: 'No downloadable asset for skill-fail' },
      ]);
      expect(progress).toEqual(['Fail Skill']);
    });
  });

  describe('countBundledSkills', () => {
    it('returns a number >= 0', () => {
      const count = countBundledSkills();
      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Skill manifests and loud failures (29 of 31 marketplace skills 404'd:
// the CLI required skill.json after skills moved to SKILL.md, premium
// archives were missing, and the wizard hid every failure).
// ---------------------------------------------------------------------------

describe('marketplace skill installs: SKILL.md, skill.json, fallback, loud failures', () => {
  const CDN = 'https://raw.githubusercontent.com/stevehuang0115/crewly/main';

  /** Serve these URL -> body pairs; everything else is a 404. Records every URL asked. */
  function serve(files: Record<string, string>): string[] {
    const asked: string[] = [];
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      asked.push(url);
      if (url in files) {
        const buf = Buffer.from(files[url]);
        return { ok: true, status: 200, statusText: 'OK', arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)) };
      }
      return { ok: false, status: 404, statusText: 'Not Found' };
    });
    return asked;
  }

  async function installedFiles(id: string): Promise<string[]> {
    return (await readdir(getInstallPath('skill', id))).sort();
  }

  it('installs a skill that ships SKILL.md and no skill.json (agent-send-pdf-to-slack shape)', async () => {
    const dir = 'config/skills/agent/send-pdf-to-slack';
    serve({ [`${CDN}/${dir}/SKILL.md`]: '# Send PDF', [`${CDN}/${dir}/execute.sh`]: '#!/bin/bash' });

    const result = await downloadAndInstall(makeFakeItem({ id: 'agent-send-pdf-to-slack', assets: { archive: dir } }));

    expect(result.success).toBe(true);
    expect(await installedFiles('agent-send-pdf-to-slack')).toEqual(['SKILL.md', 'execute.sh']);
  });

  it('still installs an older skill that ships only skill.json', async () => {
    const dir = 'config/skills/agent/legacy-skill';
    serve({ [`${CDN}/${dir}/skill.json`]: '{"id":"legacy-skill"}', [`${CDN}/${dir}/instructions.md`]: 'do it' });

    const result = await downloadAndInstall(makeFakeItem({ id: 'legacy-skill', assets: { archive: dir } }));

    expect(result.success).toBe(true);
    expect(await installedFiles('legacy-skill')).toEqual(['instructions.md', 'skill.json']);
  });

  it('installs from SKILL.md even when the entry lists stale files (ai-studio shape)', async () => {
    const dir = 'config/skills/agent/ai-studio';
    serve({ [`${CDN}/${dir}/SKILL.md`]: '# AI Studio' });

    const result = await downloadAndInstall(
      makeFakeItem({ id: 'ai-studio', assets: { archive: dir }, metadata: { files: ['skill.json', 'instructions.md'] } }),
    );

    expect(result.success).toBe(true);
    expect(await installedFiles('ai-studio')).toEqual(['SKILL.md']);
  });

  it('falls back to the public copy when the premium archive 404s, and says so', async () => {
    const dir = 'config/skills/agent/code-review';
    const publicItem = makeFakeItem({ id: 'code-review', name: 'Code Review', assets: { archive: dir } });
    const premiumItem = makeFakeItem({ id: 'code-review', name: 'Code Review', assets: { archive: 'skills/code-review/code-review-1.0.0.tar.gz' } });

    global.fetch = jest.fn()
      .mockResolvedValueOnce(makeRegistryResponse([publicItem]))
      .mockResolvedValueOnce(makeRegistryResponse([premiumItem]));
    const registry = await fetchRegistry();
    const merged = registry.items.find((i) => i.id === 'code-review')!;
    expect(merged.assets.archive).toBe('skills/code-review/code-review-1.0.0.tar.gz');
    expect(merged.fallback?.assets.archive).toBe(dir);

    serve({ [`${CDN}/${dir}/SKILL.md`]: '# Code review', [`${CDN}/${dir}/execute.sh`]: '#!/bin/bash' });
    const result = await downloadAndInstall(merged);

    expect(result.success).toBe(true);
    expect(result.message).toContain('from the public registry');
    expect(result.message).toContain('premium source failed: Download failed: 404');
    expect(await installedFiles('code-review')).toEqual(['SKILL.md', 'execute.sh']);
  });

  it('does not attach a fallback that points at the same source', async () => {
    const item = makeFakeItem({ id: 'dup', assets: { archive: 'config/skills/agent/dup' } });
    global.fetch = jest.fn()
      .mockResolvedValueOnce(makeRegistryResponse([item]))
      .mockResolvedValueOnce(makeRegistryResponse([item]));

    const registry = await fetchRegistry();

    expect(registry.items.find((i) => i.id === 'dup')?.fallback).toBeUndefined();
  });

  it('fails with the URL when a premium-only archive is missing', async () => {
    serve({});
    const result = await downloadAndInstall(
      makeFakeItem({ id: 'skill-nano-banana', assets: { archive: 'skills/nano-banana/nano-banana-1.1.0.tar.gz' } }),
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('404');
    expect(result.message).toContain('skills/nano-banana/nano-banana-1.1.0.tar.gz');
  });

  it('reports every failed skill by name from installAllSkills instead of only counting successes', async () => {
    const ok = makeFakeItem({ id: 'good-skill', name: 'Good Skill', assets: { archive: 'config/skills/agent/good-skill' } });
    const missing = makeFakeItem({ id: 'gone-skill', name: 'Gone Skill', assets: { archive: 'config/skills/agent/gone-skill' } });
    const premiumOnly = makeFakeItem({ id: 'paid-skill', name: 'Paid Skill', assets: { archive: 'skills/paid/paid-1.0.0.tar.gz' } });
    const files: Record<string, string> = { [`${CDN}/config/skills/agent/good-skill/SKILL.md`]: '# ok' };
    const body = (text: string) => {
      const buf = Buffer.from(text);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    };
    global.fetch = jest.fn()
      .mockResolvedValueOnce(makeRegistryResponse([ok, missing, premiumOnly]))
      .mockResolvedValueOnce(makeRegistryResponse([]))
      .mockImplementation(async (url: string) => (url in files
        ? { ok: true, status: 200, statusText: 'OK', arrayBuffer: () => Promise.resolve(body(files[url])) }
        : { ok: false, status: 404, statusText: 'Not Found' }));

    const result = await installAllSkills();

    // Guard: the run must actually have exercised skills.
    expect(result.total).toBe(3);
    expect(result.installed).toBe(1);
    expect(result.failed.map((f) => f.name)).toEqual(['Gone Skill', 'Paid Skill']);
    expect(result.failed[0].message).toContain('No skill manifest');
    expect(result.failed[1].message).toContain('404');
  });
});

