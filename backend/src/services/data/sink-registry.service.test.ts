/**
 * Tests for SinkRegistryService
 *
 * Covers: loading from _sinks.json, getSink, listSinks, matchSink,
 * registerSink (in-memory + persistence).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { SinkRegistryService } from './sink-registry.service.js';
import type { SinkDefinition } from '../../types/data-object.types.js';

// Mock fs modules
vi.mock('fs/promises');
vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

// Mock atomicWriteFile
vi.mock('../../utils/file-io.utils.js', () => ({
  atomicWriteFile: vi.fn().mockResolvedValue(undefined),
}));

// Mock logger
vi.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        warn: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
      }),
    }),
  },
}));

/**
 * Build a sample sink for testing.
 */
function makeSteveInputsSink(): SinkDefinition {
  return {
    id: 'steve-inputs',
    name: 'CEO Inputs',
    description: 'Raw inputs from CEO',
    schema_id: 'schema-steve-input-v1',
    tags: ['strategy', 'ceo', 'direction'],
    directory: 'steve-inputs',
  };
}

/**
 * Build a second sample sink for testing.
 */
function makeMarketingSink(): SinkDefinition {
  return {
    id: 'marketing-briefs',
    name: 'Marketing Briefs',
    description: 'Marketing content briefs',
    schema_id: 'schema-marketing-v1',
    tags: ['marketing', 'content', 'strategy'],
    directory: 'marketing-briefs',
  };
}

describe('SinkRegistryService', () => {
  let service: SinkRegistryService;

  beforeEach(() => {
    SinkRegistryService.resetInstance();
    service = SinkRegistryService.getInstance();
    vi.clearAllMocks();
  });

  afterEach(() => {
    SinkRegistryService.resetInstance();
  });

  // -----------------------------------------------------------------------
  // Singleton
  // -----------------------------------------------------------------------

  describe('singleton', () => {
    it('returns the same instance', () => {
      const a = SinkRegistryService.getInstance();
      const b = SinkRegistryService.getInstance();
      expect(a).toBe(b);
    });

    it('returns a fresh instance after reset', () => {
      const a = SinkRegistryService.getInstance();
      SinkRegistryService.resetInstance();
      const b = SinkRegistryService.getInstance();
      expect(a).not.toBe(b);
    });
  });

  // -----------------------------------------------------------------------
  // Loading
  // -----------------------------------------------------------------------

  describe('loadSinks', () => {
    it('loads sinks from _sinks.json', async () => {
      const registry = {
        version: 1,
        sinks: [makeSteveInputsSink(), makeMarketingSink()],
      };
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(registry));

      await service.loadSinks('/project');

      expect(service.listSinks()).toHaveLength(2);
      expect(service.getSink('steve-inputs')).toEqual(makeSteveInputsSink());
    });

    it('handles non-existent _sinks.json gracefully', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      await service.loadSinks('/project');

      expect(service.listSinks()).toHaveLength(0);
    });

    it('skips entries without id', async () => {
      const registry = {
        version: 1,
        sinks: [{ name: 'No ID', tags: [], directory: 'x', schema_id: 'x' }],
      };
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(registry));

      await service.loadSinks('/project');

      expect(service.listSinks()).toHaveLength(0);
    });

    it('handles missing sinks array gracefully', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ version: 1 }));

      await service.loadSinks('/project');

      expect(service.listSinks()).toHaveLength(0);
    });

    it('handles malformed JSON gracefully', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue('broken json {{');

      await service.loadSinks('/project');

      expect(service.listSinks()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  describe('getSink / listSinks', () => {
    it('returns null for unknown sink', () => {
      expect(service.getSink('nonexistent')).toBeNull();
    });

    it('lists all registered sinks', async () => {
      const registry = {
        version: 1,
        sinks: [makeSteveInputsSink(), makeMarketingSink()],
      };
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(registry));

      await service.loadSinks('/project');

      const sinks = service.listSinks();
      expect(sinks).toHaveLength(2);
      expect(sinks.map((s) => s.id)).toContain('steve-inputs');
      expect(sinks.map((s) => s.id)).toContain('marketing-briefs');
    });
  });

  // -----------------------------------------------------------------------
  // Matching
  // -----------------------------------------------------------------------

  describe('matchSink', () => {
    beforeEach(async () => {
      const registry = {
        version: 1,
        sinks: [makeSteveInputsSink(), makeMarketingSink()],
      };
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(registry));
      await service.loadSinks('/project');
    });

    it('matches by tag overlap', () => {
      // steve-inputs has ['strategy', 'ceo', 'direction']
      // marketing has ['marketing', 'content', 'strategy']
      const result = service.matchSink(['ceo', 'direction']);
      expect(result?.id).toBe('steve-inputs');
    });

    it('matches marketing sink when marketing tags dominate', () => {
      const result = service.matchSink(['marketing', 'content']);
      expect(result?.id).toBe('marketing-briefs');
    });

    it('breaks ties with content matching', () => {
      // Both sinks share 'strategy' tag (score=1 each)
      // Content mentions 'CEO Inputs' which matches steve-inputs name
      const result = service.matchSink(['strategy'], 'This came from CEO Inputs channel');
      expect(result?.id).toBe('steve-inputs');
    });

    it('returns null when no tags match', () => {
      const result = service.matchSink(['engineering', 'devops']);
      expect(result).toBeNull();
    });

    it('returns null for empty tags and no content', () => {
      const result = service.matchSink([]);
      expect(result).toBeNull();
    });

    it('handles empty sink registry', () => {
      SinkRegistryService.resetInstance();
      const empty = SinkRegistryService.getInstance();
      const result = empty.matchSink(['anything']);
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  describe('registerSink', () => {
    it('adds a new sink to the in-memory registry', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      const sink = makeSteveInputsSink();
      await service.registerSink('/project', sink);

      expect(service.getSink('steve-inputs')).toEqual(sink);
    });

    it('creates sinks directory and sink data directory', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      await service.registerSink('/project', makeSteveInputsSink());

      expect(fs.mkdir).toHaveBeenCalledWith('/project/sinks', { recursive: true });
      expect(fs.mkdir).toHaveBeenCalledWith('/project/sinks/steve-inputs', { recursive: true });
    });

    it('persists the registry via atomicWriteFile', async () => {
      const { atomicWriteFile } = await import('../../utils/file-io.utils.js');
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      await service.registerSink('/project', makeSteveInputsSink());

      expect(atomicWriteFile).toHaveBeenCalledWith(
        '/project/sinks/_sinks.json',
        expect.any(String),
      );

      // Verify the written content is valid JSON with our sink
      const writtenContent = vi.mocked(atomicWriteFile).mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenContent);
      expect(parsed.version).toBe(1);
      expect(parsed.sinks).toHaveLength(1);
      expect(parsed.sinks[0].id).toBe('steve-inputs');
    });

    it('overwrites an existing sink with the same id', async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      const sink = makeSteveInputsSink();
      await service.registerSink('/project', sink);

      const updated = { ...sink, name: 'Updated Name' };
      await service.registerSink('/project', updated);

      expect(service.getSink('steve-inputs')?.name).toBe('Updated Name');
      expect(service.listSinks()).toHaveLength(1);
    });
  });
});
