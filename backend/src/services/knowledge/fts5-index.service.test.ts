/**
 * Unit tests for Fts5IndexService
 *
 * Tests SQLite FTS5 full-text search index operations: upsert, remove,
 * search with BM25 ranking, category filtering, rebuild, and close.
 * Uses a temporary directory so tests never touch real user data.
 *
 * better-sqlite3 is a native module that may not be available in all
 * test environments. If it fails to load, tests are skipped gracefully.
 *
 * @module services/knowledge/fts5-index.service.test
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import { Fts5IndexService, type FtsDocument } from './fts5-index.service.js';

// ---------------------------------------------------------------------------
// Mock LoggerService
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Native module availability check
// ---------------------------------------------------------------------------

let nativeModuleAvailable = true;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Db = require('better-sqlite3');
  // Also verify the native binary loads correctly (arch mismatch fails here)
  const testDb = new Db(':memory:');
  testDb.close();
} catch {
  nativeModuleAvailable = false;
}

const describeIfNative = nativeModuleAvailable ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fts5-index-test-'));
});

afterAll(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

/**
 * Create a test FtsDocument with sensible defaults.
 *
 * @param overrides - Optional field overrides
 * @returns A complete FtsDocument
 */
function createDoc(overrides: Partial<FtsDocument> = {}): FtsDocument {
  return {
    id: 'doc-1',
    title: 'Getting Started',
    tags: 'setup onboarding',
    content: 'This is a guide to getting started with the platform.',
    category: 'Onboarding',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeIfNative('Fts5IndexService', () => {
  let service: Fts5IndexService;
  let testDir: string;

  beforeEach(() => {
    // Create a unique subdirectory for each test to avoid DB locking issues
    testDir = path.join(tempDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    service = new Fts5IndexService(testDir);
  });

  afterEach(() => {
    service.close();
  });

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('creates the database file at the correct path', () => {
      // Trigger lazy initialization by performing an operation
      service.upsertDocument(createDoc());

      const expectedPath = path.join(testDir, 'index.fts5.db');
      expect(fs.existsSync(expectedPath)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // upsertDocument
  // -------------------------------------------------------------------------

  describe('upsertDocument', () => {
    it('adds a document and it becomes searchable', () => {
      const doc = createDoc({ id: 'setup-guide', content: 'deployment instructions' });
      service.upsertDocument(doc);

      const results = service.search('deployment');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('setup-guide');
      expect(results[0].title).toBe('Getting Started');
    });

    it('updates an existing document on re-upsert', () => {
      service.upsertDocument(createDoc({ id: 'doc-1', title: 'Version 1' }));
      service.upsertDocument(createDoc({ id: 'doc-1', title: 'Version 2' }));

      const results = service.search('getting started');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Version 2');
    });
  });

  // -------------------------------------------------------------------------
  // removeDocument
  // -------------------------------------------------------------------------

  describe('removeDocument', () => {
    it('removes a document from the index', () => {
      service.upsertDocument(createDoc({ id: 'to-remove' }));
      expect(service.search('getting started')).toHaveLength(1);

      service.removeDocument('to-remove');
      expect(service.search('getting started')).toHaveLength(0);
    });

    it('does not throw when removing a non-existent document', () => {
      expect(() => service.removeDocument('nonexistent')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // search
  // -------------------------------------------------------------------------

  describe('search', () => {
    beforeEach(() => {
      service.upsertDocument(createDoc({
        id: 'deploy-guide',
        title: 'Deployment Guide',
        tags: 'devops deployment',
        content: 'Step by step deployment instructions for production.',
        category: 'SOPs',
      }));
      service.upsertDocument(createDoc({
        id: 'onboarding',
        title: 'New Engineer Onboarding',
        tags: 'onboarding setup',
        content: 'Welcome to the team! Here is how to set up your machine.',
        category: 'Onboarding',
      }));
      service.upsertDocument(createDoc({
        id: 'architecture',
        title: 'System Architecture',
        tags: 'architecture design',
        content: 'The system uses a microservices architecture with event sourcing.',
        category: 'Architecture',
      }));
    });

    it('returns BM25-ranked results', () => {
      const results = service.search('deployment');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].id).toBe('deploy-guide');
      // BM25 rank is present (negative values in FTS5)
      expect(typeof results[0].rank).toBe('number');
    });

    it('filters results by category', () => {
      const results = service.search('set up', { category: 'Onboarding' });
      for (const result of results) {
        expect(result.category).toBe('Onboarding');
      }
    });

    it('respects the limit option', () => {
      const results = service.search('the', { limit: 1 });
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it('returns empty array for empty query', () => {
      expect(service.search('')).toEqual([]);
    });

    it('returns empty array for whitespace-only query', () => {
      expect(service.search('   ')).toEqual([]);
    });

    it('returns empty array for query with only special characters', () => {
      expect(service.search('***')).toEqual([]);
    });

    it('returns empty array when no documents match', () => {
      const results = service.search('xyznonexistentterm');
      expect(results).toEqual([]);
    });

    it('sanitizes special FTS5 characters in query', () => {
      // Should not throw despite special chars
      expect(() => service.search('"quoted" AND (nested)')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // rebuildIndex
  // -------------------------------------------------------------------------

  describe('rebuildIndex', () => {
    it('clears existing index and inserts new documents', () => {
      service.upsertDocument(createDoc({ id: 'old-doc', content: 'old content' }));
      expect(service.search('old content')).toHaveLength(1);

      service.rebuildIndex([
        createDoc({ id: 'new-1', content: 'brand new first document' }),
        createDoc({ id: 'new-2', content: 'brand new second document' }),
      ]);

      // Old document should be gone
      expect(service.search('old content')).toHaveLength(0);
      // New documents should be present
      expect(service.search('brand new')).toHaveLength(2);
    });

    it('handles empty document array', () => {
      service.upsertDocument(createDoc({ id: 'to-clear' }));
      service.rebuildIndex([]);

      expect(service.search('getting started')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  describe('close', () => {
    it('closes the database cleanly', () => {
      service.upsertDocument(createDoc());
      expect(() => service.close()).not.toThrow();
    });

    it('can be called multiple times without error', () => {
      service.upsertDocument(createDoc());
      service.close();
      expect(() => service.close()).not.toThrow();
    });
  });
});
