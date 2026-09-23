/**
 * Tests for the CLI install command.
 *
 * Validates install-all and single-install flows, error handling,
 * and user-facing output.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock chalk (ESM-only)
jest.mock('chalk', () => ({
  __esModule: true,
  default: new Proxy({}, {
    get: () => {
      const fn = (s: string) => s;
      return new Proxy(fn, { get: () => fn, apply: (_t: unknown, _this: unknown, args: string[]) => args[0] });
    },
  }),
}));

const mockFetchRegistry = jest.fn();
const mockDownloadAndInstall = jest.fn();

jest.mock('../utils/marketplace.js', () => ({
  fetchRegistry: (...args: unknown[]) => mockFetchRegistry(...args),
  downloadAndInstall: (...args: unknown[]) => mockDownloadAndInstall(...args),
  formatBytes: (b: number) => `${b} B`,
}));

import { installCommand } from './install.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeItem(id: string, name: string, type = 'skill') {
  return {
    id,
    type,
    name,
    description: 'A test item',
    author: 'test',
    version: '1.0.0',
    category: 'development',
    tags: [],
    license: 'MIT',
    downloads: 0,
    rating: 5,
    createdAt: '2025-01-01',
    updatedAt: '2025-01-01',
    assets: { archive: `skills/${id}/${id}-1.0.0.tar.gz`, sizeBytes: 1024 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('installCommand', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation();
    errorSpy = jest.spyOn(console, 'error').mockImplementation();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    mockFetchRegistry.mockReset();
    mockDownloadAndInstall.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with error when no id and no --all flag', async () => {
    await expect(installCommand(undefined, {})).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('installs a single skill by ID', async () => {
    const item = makeFakeItem('skill-banana', 'Banana Skill');
    mockFetchRegistry.mockResolvedValue({
      schemaVersion: 1,
      lastUpdated: '2025-01-01',
      cdnBaseUrl: '',
      items: [item],
    });
    mockDownloadAndInstall.mockResolvedValue({
      success: true,
      message: 'Installed Banana Skill v1.0.0',
    });

    await installCommand('skill-banana');

    expect(mockDownloadAndInstall).toHaveBeenCalledWith(item);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Done'));
  });

  it('exits with error for unknown skill ID', async () => {
    mockFetchRegistry.mockResolvedValue({
      schemaVersion: 1,
      lastUpdated: '2025-01-01',
      cdnBaseUrl: '',
      items: [],
    });

    await expect(installCommand('nonexistent')).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('installs all skills with --all flag', async () => {
    const items = [
      makeFakeItem('skill-a', 'Skill A'),
      makeFakeItem('skill-b', 'Skill B'),
      makeFakeItem('model-c', 'Model C', 'model'),
    ];
    mockFetchRegistry.mockResolvedValue({
      schemaVersion: 1,
      lastUpdated: '2025-01-01',
      cdnBaseUrl: '',
      items,
    });
    mockDownloadAndInstall.mockResolvedValue({ success: true, message: 'Installed' });

    await installCommand(undefined, { all: true });

    // Should only install skills (not the model)
    expect(mockDownloadAndInstall).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('2 skills installed'));
  });

  it('reports failures during --all install', async () => {
    const items = [makeFakeItem('skill-a', 'Skill A')];
    mockFetchRegistry.mockResolvedValue({
      schemaVersion: 1,
      lastUpdated: '2025-01-01',
      cdnBaseUrl: '',
      items,
    });
    mockDownloadAndInstall.mockResolvedValue({ success: false, message: 'Download failed' });

    await installCommand(undefined, { all: true });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('0 installed'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('1 failed'));
  });

  it('exits non-zero when any skill in --all fails', async () => {
    const items = [makeFakeItem('skill-a', 'Skill A'), makeFakeItem('skill-b', 'Skill B')];
    mockFetchRegistry.mockResolvedValue({ schemaVersion: 1, lastUpdated: '2025-01-01', cdnBaseUrl: '', items });
    mockDownloadAndInstall
      .mockResolvedValueOnce({ success: true, message: 'ok' })
      .mockResolvedValueOnce({ success: false, message: 'Download failed: 404 Not Found' });
    const before = process.exitCode;
    try {
      await installCommand(undefined, { all: true });
      expect(mockDownloadAndInstall).toHaveBeenCalledTimes(2);
      expect(process.exitCode).toBe(1);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Skill B: Download failed: 404'));
    } finally {
      process.exitCode = before;
    }
  });

  it('exits zero when every skill in --all installs', async () => {
    const items = [makeFakeItem('skill-a', 'Skill A')];
    mockFetchRegistry.mockResolvedValue({ schemaVersion: 1, lastUpdated: '2025-01-01', cdnBaseUrl: '', items });
    mockDownloadAndInstall.mockResolvedValue({ success: true, message: 'ok' });
    const before = process.exitCode;
    try {
      process.exitCode = undefined;
      await installCommand(undefined, { all: true });
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = before;
    }
  });
});
