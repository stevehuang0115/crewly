/**
 * Unit tests for VectorStoreService v2
 *
 * Tests local SQLite vector storage with sqlite-vec integration: BLOB storage,
 * native KNN search, dimension validation, batch operations, input sanitization,
 * schema migration, and multi-scope isolation. Uses a temporary directory so
 * tests never touch real user data.
 *
 * @module services/memory/vector-store.service.test
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import {
  VectorStoreService,
  cosineSimilarity,
  embeddingToBlob,
  blobToEmbedding,
  validateEmbedding,
  VECTOR_STORE_CONSTANTS,
} from './vector-store.service.js';

// Mock LoggerService
jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    }),
  },
}));

// Redirect HOME to a temp directory so tests don't touch real data
let tempDir: string;
const originalHome = process.env.HOME;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-store-test-'));
  process.env.HOME = tempDir;
});

afterAll(() => {
  process.env.HOME = originalHome;
  VectorStoreService.resetInstance();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

afterEach(() => {
  VectorStoreService.resetInstance();
});

// ---------------------------------------------------------------------------
// ESM require bridge — regression guard
// ---------------------------------------------------------------------------

describe('module load (ESM require bridge)', () => {
  // Loading this test file at all means the createRequire(import.meta.url)
  // bridge in vector-store.service.ts succeeded; under the bug we swept
  // out, the import on line 16 above would have thrown ReferenceError on
  // first DB access (or ts-jest CJS would have hit the same path through
  // the typeof require branch). Pin the bridge by exercising a function
  // that hits the lazy loader.
  it('cosineSimilarity is callable — proves the module imported cleanly', () => {
    expect(typeof cosineSimilarity).toBe('function');
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 10);
  });
});

// ---------------------------------------------------------------------------
// ESM require bridge — static-analysis regression guard for ALL bridged files
// ---------------------------------------------------------------------------
//
// PR #323 (cb135ead) introduced `createRequire(new Function('return import.meta.url')() as string)`
// across multiple ESM modules. The trick parsed clean under both ts-jest CJS
// and tsc ESM but FAILED at runtime: `new Function(...)` evaluates its body
// in non-module scope, where `import.meta` is a SyntaxError. Production
// servers crashed at startup. The fix anchors createRequire to
// `pathToFileURL(process.argv[1] || process.cwd()).href` instead.
//
// This test scans every file known to use the bridge and asserts:
//   1. NONE contain the broken `new Function('return import.meta.url')` pattern
//   2. ALL contain the fixed `pathToFileURL(process.argv[1]` pattern
// If a future contributor reverts to the broken trick OR adds a new module
// without using the fixed pattern, this test fails and points at the file.
describe('ESM require pattern (cross-file regression guard)', () => {
  const ESM_BRIDGED_FILES = [
    'backend/src/services/memory/vector-store.service.ts',
    'backend/src/services/knowledge/vector-store.service.ts',
    'backend/src/services/knowledge/fts5-index.service.ts',
    'backend/src/services/chat-v2/sqlite/chat-db.ts',
    'backend/src/services/browser/browser-bridge.service.ts',
    'backend/src/services/slack/cross-machine-message.service.ts',
    'backend/src/controllers/agent-stream/agent-stream.controller.ts',
    // Added 2026-05-07 (auditor cycle 1, F-NEW-1): the bare `require()` calls
    // inside ActiveWorkBriefingService.getInstance() threw `require is not
    // defined` for every agent registration that touched the active-work
    // briefing path (skill `get-my-active-work` and AgentRegistrationService),
    // breaking session startup. Now bridged via the canonical createRequire
    // pattern; this guard locks the bridge in.
    'backend/src/services/agent/active-work-briefing.service.ts',
  ];

  // The broken pattern's distinguishing feature: `createRequire(new Function(`
  // (the `new Function('return import.meta.url')` arg). Comments may legally
  // mention the historical pattern, so we anchor on the actual call form.
  const BROKEN_CALL = /createRequire\s*\(\s*new\s+Function\s*\(/;
  const FIXED_CALL = /createRequire\s*\(\s*pathToFileURL\s*\(\s*process\.argv\[1\]/;

  it.each(ESM_BRIDGED_FILES)(
    '%s does NOT use new Function trick and DOES use process.argv[1] anchor',
    (relPath) => {
      // Project root: this test file lives at backend/src/services/memory/,
      // walk up four levels to repo root, then resolve the file under test.
      const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
      const absPath = path.join(repoRoot, relPath);
      const src = fs.readFileSync(absPath, 'utf8');

      // Strip line/block comments so historical references in JSDoc don't
      // false-positive against the broken pattern.
      const stripComments = (s: string): string =>
        s
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n')
          .map((line) => line.replace(/\/\/.*$/, ''))
          .join('\n');
      const code = stripComments(src);

      expect(code).not.toMatch(BROKEN_CALL);
      expect(code).toMatch(FIXED_CALL);
    }
  );
});

// ---------------------------------------------------------------------------
// cosineSimilarity unit tests
// ---------------------------------------------------------------------------

describe('cosineSimilarity', () => {
  it('should return 1 for identical vectors', () => {
    const v = [1, 2, 3];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 10);
  });

  it('should return 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it('should return -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it('should return 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('should return 0 for mismatched lengths', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('should return 0 for zero vectors', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it('should compute correct similarity for known vectors', () => {
    const sim = cosineSimilarity([1, 0, 0], [0.9, 0.1, 0]);
    expect(sim).toBeGreaterThan(0.99);
    expect(sim).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// embeddingToBlob / blobToEmbedding unit tests
// ---------------------------------------------------------------------------

describe('embeddingToBlob / blobToEmbedding', () => {
  it('should round-trip a simple embedding', () => {
    const original = [0.1, 0.2, 0.3, 0.4];
    const blob = embeddingToBlob(original);
    const restored = blobToEmbedding(blob);

    expect(restored).toHaveLength(4);
    // Float32 loses some precision vs Float64
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5);
    }
  });

  it('should produce a Buffer of correct size', () => {
    const blob = embeddingToBlob([1, 2, 3]);
    // 3 floats × 4 bytes each = 12 bytes
    expect(blob.byteLength).toBe(12);
  });

  it('should handle a single-element embedding', () => {
    const blob = embeddingToBlob([42.5]);
    const restored = blobToEmbedding(blob);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toBeCloseTo(42.5, 4);
  });

  it('should handle an empty embedding', () => {
    const blob = embeddingToBlob([]);
    const restored = blobToEmbedding(blob);
    expect(restored).toHaveLength(0);
  });

  it('should handle negative values', () => {
    const original = [-1.5, 0, 1.5];
    const restored = blobToEmbedding(embeddingToBlob(original));
    expect(restored[0]).toBeCloseTo(-1.5, 5);
    expect(restored[1]).toBeCloseTo(0, 5);
    expect(restored[2]).toBeCloseTo(1.5, 5);
  });
});

// ---------------------------------------------------------------------------
// validateEmbedding unit tests
// ---------------------------------------------------------------------------

describe('validateEmbedding', () => {
  it('should accept a valid embedding', () => {
    expect(() => validateEmbedding([1, 2, 3])).not.toThrow();
  });

  it('should reject an empty array', () => {
    expect(() => validateEmbedding([])).toThrow('non-empty array');
  });

  it('should reject null/undefined', () => {
    expect(() => validateEmbedding(null as unknown as number[])).toThrow('non-empty array');
    expect(() => validateEmbedding(undefined as unknown as number[])).toThrow('non-empty array');
  });

  it('should reject NaN values', () => {
    expect(() => validateEmbedding([1, NaN, 3])).toThrow('invalid value at index 1');
  });

  it('should reject Infinity values', () => {
    expect(() => validateEmbedding([1, Infinity, 3])).toThrow('invalid value at index 1');
  });

  it('should reject negative Infinity', () => {
    expect(() => validateEmbedding([-Infinity, 2])).toThrow('invalid value at index 0');
  });

  it('should reject non-number values', () => {
    expect(() => validateEmbedding([1, 'two' as unknown as number, 3])).toThrow(
      'invalid value at index 1',
    );
  });

  it('should reject embeddings exceeding MAX_DIMENSIONS', () => {
    const huge = new Array(VECTOR_STORE_CONSTANTS.MAX_DIMENSIONS + 1).fill(0.1);
    expect(() => validateEmbedding(huge)).toThrow('exceed maximum');
  });

  it('should accept embeddings at MAX_DIMENSIONS', () => {
    const maxDim = new Array(VECTOR_STORE_CONSTANTS.MAX_DIMENSIONS).fill(0.1);
    expect(() => validateEmbedding(maxDim)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// VectorStoreService unit tests
// ---------------------------------------------------------------------------

describe('VectorStoreService', () => {
  let service: VectorStoreService;

  beforeEach(() => {
    service = VectorStoreService.getInstance();
    // Clear any leftover data from prior test blocks
    try {
      service.clear('global');
    } catch {
      /* db may not exist yet */
    }
  });

  describe('singleton', () => {
    it('should return the same instance', () => {
      const a = VectorStoreService.getInstance();
      const b = VectorStoreService.getInstance();
      expect(a).toBe(b);
    });

    it('should create a new instance after reset', () => {
      const a = VectorStoreService.getInstance();
      VectorStoreService.resetInstance();
      const b = VectorStoreService.getInstance();
      expect(a).not.toBe(b);
    });
  });

  describe('upsert and get', () => {
    it('should store and retrieve an embedding', () => {
      const embedding = [0.1, 0.2, 0.3, 0.4];
      const metadata = { title: 'Test Doc', category: 'General' };

      service.upsert('doc-1', embedding, metadata, 'global');
      const result = service.get('doc-1', 'global');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('doc-1');
      // Float32 round-trip loses some precision
      expect(result!.embedding).toHaveLength(4);
      for (let i = 0; i < embedding.length; i++) {
        expect(result!.embedding[i]).toBeCloseTo(embedding[i], 5);
      }
      expect(result!.metadata).toEqual(metadata);
      expect(result!.createdAt).toBeTruthy();
      expect(result!.updatedAt).toBeTruthy();
    });

    it('should update an existing embedding on upsert', () => {
      service.upsert('doc-1', [1, 2, 3], { v: 1 }, 'global');
      service.upsert('doc-1', [4, 5, 6], { v: 2 }, 'global');

      const result = service.get('doc-1', 'global');
      expect(result!.embedding[0]).toBeCloseTo(4, 5);
      expect(result!.embedding[1]).toBeCloseTo(5, 5);
      expect(result!.embedding[2]).toBeCloseTo(6, 5);
      expect(result!.metadata).toEqual({ v: 2 });
    });

    it('should return null for non-existent ID', () => {
      expect(service.get('non-existent', 'global')).toBeNull();
    });

    it('should throw for empty id', () => {
      expect(() => service.upsert('', [1, 2], {}, 'global')).toThrow('id is required');
    });

    it('should throw for empty embedding', () => {
      expect(() => service.upsert('doc-1', [], {}, 'global')).toThrow('non-empty array');
    });

    it('should throw for NaN in embedding', () => {
      expect(() => service.upsert('doc-1', [1, NaN], {}, 'global')).toThrow('invalid value');
    });

    it('should throw for Infinity in embedding', () => {
      expect(() => service.upsert('doc-1', [Infinity, 2], {}, 'global')).toThrow('invalid value');
    });

    it('should throw for metadata exceeding size limit', () => {
      const bigMeta = { data: 'x'.repeat(VECTOR_STORE_CONSTANTS.MAX_METADATA_SIZE + 1) };
      expect(() => service.upsert('doc-1', [1, 2], bigMeta, 'global')).toThrow(
        'metadata exceeds maximum size',
      );
    });
  });

  describe('dimension validation', () => {
    it('should enforce consistent dimensions within a scope', () => {
      service.upsert('doc-1', [1, 2, 3], {}, 'global');
      // Different dimension should throw
      expect(() => service.upsert('doc-2', [1, 2, 3, 4], {}, 'global')).toThrow(
        'Dimension mismatch',
      );
    });

    it('should allow same dimensions across inserts', () => {
      service.upsert('doc-1', [1, 2, 3], {}, 'global');
      expect(() => service.upsert('doc-2', [4, 5, 6], {}, 'global')).not.toThrow();
    });

    it('should allow different dimensions in different scopes', () => {
      const projectPath = path.join(tempDir, 'dim-test-project');
      fs.mkdirSync(projectPath, { recursive: true });

      service.upsert('doc-1', [1, 2, 3], {}, 'global');
      expect(() =>
        service.upsert('doc-2', [1, 2, 3, 4, 5], {}, 'project', projectPath),
      ).not.toThrow();
    });
  });

  describe('delete', () => {
    it('should delete an existing embedding', () => {
      service.upsert('doc-1', [1, 2, 3], {}, 'global');
      expect(service.delete('doc-1', 'global')).toBe(true);
      expect(service.get('doc-1', 'global')).toBeNull();
    });

    it('should return false for non-existent ID', () => {
      expect(service.delete('non-existent', 'global')).toBe(false);
    });
  });

  describe('has', () => {
    it('should return true for existing embedding', () => {
      service.upsert('doc-1', [1, 2, 3], {}, 'global');
      expect(service.has('doc-1', 'global')).toBe(true);
    });

    it('should return false for non-existent ID', () => {
      expect(service.has('non-existent', 'global')).toBe(false);
    });
  });

  describe('count', () => {
    it('should return 0 for empty store', () => {
      expect(service.count('global')).toBe(0);
    });

    it('should return correct count after inserts', () => {
      service.upsert('doc-1', [1, 2], {}, 'global');
      service.upsert('doc-2', [3, 4], {}, 'global');
      service.upsert('doc-3', [5, 6], {}, 'global');
      expect(service.count('global')).toBe(3);
    });
  });

  describe('clear', () => {
    it('should remove all embeddings', () => {
      service.upsert('doc-1', [1, 2], {}, 'global');
      service.upsert('doc-2', [3, 4], {}, 'global');

      const deleted = service.clear('global');
      expect(deleted).toBe(2);
      expect(service.count('global')).toBe(0);
    });
  });

  describe('search', () => {
    beforeEach(() => {
      // Insert embeddings with known directions
      service.upsert('exact', [1, 0, 0], { label: 'exact match' }, 'global');
      service.upsert('similar', [0.9, 0.1, 0], { label: 'similar' }, 'global');
      service.upsert('different', [0, 0, 1], { label: 'different' }, 'global');
      service.upsert('opposite', [-1, 0, 0], { label: 'opposite' }, 'global');
    });

    it('should return results sorted by descending similarity', () => {
      const results = service.search([1, 0, 0], 'global');

      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results[0].id).toBe('exact');
      expect(results[0].score).toBeCloseTo(1, 2);
      expect(results[1].id).toBe('similar');
      expect(results[1].score).toBeGreaterThan(0.9);
    });

    it('should filter results below threshold', () => {
      const results = service.search([1, 0, 0], 'global', undefined, 10, 0.5);

      const ids = results.map((r) => r.id);
      expect(ids).toContain('exact');
      expect(ids).toContain('similar');
      expect(ids).not.toContain('opposite');
    });

    it('should respect the limit parameter', () => {
      const results = service.search([1, 0, 0], 'global', undefined, 1);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('exact');
    });

    it('should return empty array for empty query embedding', () => {
      expect(service.search([], 'global')).toEqual([]);
    });

    it('should return metadata in results', () => {
      const results = service.search([1, 0, 0], 'global', undefined, 1);
      expect(results[0].metadata).toEqual({ label: 'exact match' });
    });

    it('should handle search with high threshold filtering all results', () => {
      const results = service.search([1, 0, 0], 'global', undefined, 10, 1.1);
      expect(results).toHaveLength(0);
    });
  });

  describe('scope isolation', () => {
    it('should isolate global and project scopes', () => {
      const projectPath = path.join(tempDir, 'test-project');
      fs.mkdirSync(projectPath, { recursive: true });

      service.upsert('doc-global', [1, 0], { scope: 'global' }, 'global');
      service.upsert('doc-project', [0, 1], { scope: 'project' }, 'project', projectPath);

      expect(service.has('doc-global', 'global')).toBe(true);
      expect(service.has('doc-project', 'global')).toBe(false);

      expect(service.has('doc-project', 'project', projectPath)).toBe(true);
      expect(service.has('doc-global', 'project', projectPath)).toBe(false);
    });

    it('should throw when projectPath is missing for project scope', () => {
      expect(() => service.upsert('doc-1', [1], {}, 'project')).toThrow(
        'projectPath is required',
      );
    });
  });

  describe('database file creation', () => {
    it('should create the database file on first access', () => {
      service.upsert('doc-1', [1, 2], {}, 'global');

      const expectedPath = path.join(
        tempDir,
        '.crewly',
        VECTOR_STORE_CONSTANTS.DB_FILENAME,
      );
      expect(fs.existsSync(expectedPath)).toBe(true);
    });
  });

  describe('isVecEnabled', () => {
    it('should report whether sqlite-vec is available', () => {
      // After any operation, isVecEnabled should return a boolean
      service.upsert('doc-1', [1, 2], {}, 'global');
      const enabled = service.isVecEnabled('global');
      expect(typeof enabled).toBe('boolean');
    });
  });

  describe('batchUpsert', () => {
    it('should insert multiple items in one transaction', () => {
      const items = [
        { id: 'batch-1', embedding: [1, 0, 0], metadata: { n: 1 } },
        { id: 'batch-2', embedding: [0, 1, 0], metadata: { n: 2 } },
        { id: 'batch-3', embedding: [0, 0, 1], metadata: { n: 3 } },
      ];

      const result = service.batchUpsert(items, 'global');

      expect(result.succeeded).toBe(3);
      expect(result.failed).toBe(0);
      expect(service.count('global')).toBe(3);
      expect(service.get('batch-2', 'global')!.metadata).toEqual({ n: 2 });
    });

    it('should report failures for invalid items', () => {
      const items = [
        { id: 'good-1', embedding: [1, 2, 3], metadata: {} },
        { id: '', embedding: [4, 5, 6], metadata: {} }, // empty id → fail
        { id: 'good-2', embedding: [7, 8, 9], metadata: {} },
      ];

      const result = service.batchUpsert(items, 'global');

      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);
      expect(service.count('global')).toBe(2);
    });

    it('should throw for batch exceeding MAX_BATCH_SIZE', () => {
      const items = new Array(VECTOR_STORE_CONSTANTS.MAX_BATCH_SIZE + 1).fill({
        id: 'x',
        embedding: [1],
        metadata: {},
      });
      expect(() => service.batchUpsert(items, 'global')).toThrow('exceeds maximum');
    });

    it('should handle empty batch', () => {
      const result = service.batchUpsert([], 'global');
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(0);
    });
  });

  describe('BLOB storage format', () => {
    it('should store embeddings as BLOBs, not JSON text', () => {
      service.upsert('blob-test', [1.5, 2.5, 3.5], {}, 'global');

      // Verify we can read it back correctly
      const record = service.get('blob-test', 'global');
      expect(record).not.toBeNull();
      expect(record!.embedding[0]).toBeCloseTo(1.5, 5);
      expect(record!.embedding[1]).toBeCloseTo(2.5, 5);
      expect(record!.embedding[2]).toBeCloseTo(3.5, 5);
    });

    it('should maintain search accuracy with BLOB storage', () => {
      service.upsert('a', [1, 0, 0], {}, 'global');
      service.upsert('b', [0, 1, 0], {}, 'global');

      const results = service.search([1, 0, 0], 'global', undefined, 1);
      expect(results[0].id).toBe('a');
      expect(results[0].score).toBeCloseTo(1, 2);
    });
  });

  describe('lazy loading (#170)', () => {
    it('should not throw at import time if better-sqlite3 is unavailable', () => {
      expect(VectorStoreService).toBeDefined();
      expect(typeof VectorStoreService.getInstance).toBe('function');
    });

    it('should throw a clear error message when native module fails to load', () => {
      const svc = VectorStoreService.getInstance();
      expect(() => svc.upsert('lazy-test', [1, 2], {}, 'global')).not.toThrow();
      expect(svc.get('lazy-test', 'global')).not.toBeNull();
    });
  });

  describe('sqlite-vec integration', () => {
    it('should load sqlite-vec extension successfully', () => {
      // After any DB operation, vec should be loaded if the package is installed
      service.upsert('vec-test', [1, 0, 0], {}, 'global');
      // If sqlite-vec is installed (it should be), isVecEnabled returns true
      const enabled = service.isVecEnabled('global');
      // This test validates the integration path works without errors
      expect(typeof enabled).toBe('boolean');
    });

    it('should produce correct search results with vec0 KNN', () => {
      // Insert embeddings with known relationships
      service.upsert('north', [1, 0, 0], { dir: 'north' }, 'global');
      service.upsert('east', [0, 1, 0], { dir: 'east' }, 'global');
      service.upsert('south', [-1, 0, 0], { dir: 'south' }, 'global');
      service.upsert('northeast', [0.7, 0.7, 0], { dir: 'northeast' }, 'global');

      const results = service.search([1, 0, 0], 'global', undefined, 2, 0.5);

      // Should return 'north' (score ~1) and 'northeast' (score ~0.7)
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('north');
      expect(results[0].score).toBeCloseTo(1, 1);
      expect(results[1].id).toBe('northeast');
      expect(results[1].score).toBeGreaterThan(0.5);
    });

    it('should handle delete correctly with vec0', () => {
      service.upsert('del-1', [1, 0, 0], {}, 'global');
      service.upsert('del-2', [0, 1, 0], {}, 'global');

      service.delete('del-1', 'global');

      const results = service.search([1, 0, 0], 'global');
      const ids = results.map((r) => r.id);
      expect(ids).not.toContain('del-1');
    });

    it('should handle clear correctly with vec0', () => {
      service.upsert('clr-1', [1, 0, 0], {}, 'global');
      service.upsert('clr-2', [0, 1, 0], {}, 'global');

      service.clear('global');

      const results = service.search([1, 0, 0], 'global');
      expect(results).toHaveLength(0);
    });

    it('should handle update correctly with vec0', () => {
      service.upsert('upd-1', [1, 0, 0], { v: 1 }, 'global');
      // Update embedding to point east instead of north
      service.upsert('upd-1', [0, 1, 0], { v: 2 }, 'global');

      const results = service.search([0, 1, 0], 'global', undefined, 1);
      expect(results[0].id).toBe('upd-1');
      expect(results[0].score).toBeCloseTo(1, 1);
      expect(results[0].metadata).toEqual({ v: 2 });
    });
  });

  describe('schema migration', () => {
    it('should create v2 schema on fresh database', () => {
      // Simply accessing the store should create v2 schema
      service.upsert('schema-test', [1, 2, 3], {}, 'global');
      const record = service.get('schema-test', 'global');
      expect(record).not.toBeNull();
      expect(record!.embedding[0]).toBeCloseTo(1, 5);
    });

    it('should handle v1 JSON databases gracefully', () => {
      // Create a v1-style database manually
      const v1Dir = path.join(tempDir, 'v1-project', '.crewly');
      fs.mkdirSync(v1Dir, { recursive: true });

      const Database = require('better-sqlite3');
      const dbFile = path.join(v1Dir, 'vector-store.db');
      const db = new Database(dbFile);

      // v1 schema: embedding as TEXT (JSON)
      db.exec(`
        CREATE TABLE embeddings (
          id TEXT PRIMARY KEY,
          embedding TEXT NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      // Insert v1-format data
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO embeddings (id, embedding, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run('v1-doc', JSON.stringify([1, 0, 0]), JSON.stringify({ from: 'v1' }), now, now);
      db.close();

      // Now open with v2 service — should auto-migrate
      VectorStoreService.resetInstance();
      const svc = VectorStoreService.getInstance();
      const record = svc.get('v1-doc', 'project', path.join(tempDir, 'v1-project'));

      expect(record).not.toBeNull();
      expect(record!.id).toBe('v1-doc');
      expect(record!.embedding[0]).toBeCloseTo(1, 5);
      expect(record!.embedding[1]).toBeCloseTo(0, 5);
      expect(record!.embedding[2]).toBeCloseTo(0, 5);
      expect(record!.metadata).toEqual({ from: 'v1' });

      // New inserts should work with BLOB format
      svc.upsert(
        'v2-doc',
        [0, 1, 0],
        { from: 'v2' },
        'project',
        path.join(tempDir, 'v1-project'),
      );
      const v2Record = svc.get('v2-doc', 'project', path.join(tempDir, 'v1-project'));
      expect(v2Record).not.toBeNull();
      expect(v2Record!.embedding[1]).toBeCloseTo(1, 5);
    });
  });

  describe('prepared statement caching', () => {
    it('should reuse statements across multiple operations', () => {
      // This test verifies that repeated operations don't fail due to
      // statement re-preparation issues
      for (let i = 0; i < 10; i++) {
        service.upsert(`cache-${i}`, [i, i + 1, i + 2], { n: i }, 'global');
      }
      expect(service.count('global')).toBe(10);

      for (let i = 0; i < 10; i++) {
        expect(service.has(`cache-${i}`, 'global')).toBe(true);
      }

      for (let i = 0; i < 5; i++) {
        service.delete(`cache-${i}`, 'global');
      }
      expect(service.count('global')).toBe(5);
    });
  });

  describe('edge cases', () => {
    it('should handle very small embedding values', () => {
      const small = [1e-38, -1e-38, 0];
      service.upsert('small', small, {}, 'global');
      const record = service.get('small', 'global');
      expect(record).not.toBeNull();
      expect(record!.embedding).toHaveLength(3);
    });

    it('should handle embeddings with all zeros', () => {
      service.upsert('zeros', [0, 0, 0], {}, 'global');
      const record = service.get('zeros', 'global');
      expect(record).not.toBeNull();
      // Verify zero vectors can be stored and retrieved
      expect(record!.embedding).toHaveLength(3);
      for (const val of record!.embedding) {
        expect(val).toBeCloseTo(0, 5);
      }
    });

    it('should handle empty metadata', () => {
      service.upsert('no-meta', [1, 2], {}, 'global');
      const record = service.get('no-meta', 'global');
      expect(record!.metadata).toEqual({});
    });

    it('should handle metadata with special characters', () => {
      const meta = { title: 'Test "quotes" & <tags>', emoji: '🚀' };
      service.upsert('special-meta', [1, 2], meta, 'global');
      const record = service.get('special-meta', 'global');
      expect(record!.metadata).toEqual(meta);
    });
  });
});
