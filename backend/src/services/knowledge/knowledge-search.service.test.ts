/**
 * Unit tests for KnowledgeSearchService
 *
 * Tests keyword search strategy, Gemini embedding strategy, FTS5 strategy,
 * and the KnowledgeSearchService factory logic.
 *
 * @module services/knowledge/knowledge-search.service.test
 */

import {
  KeywordSearchStrategy,
  GeminiEmbeddingStrategy,
  Fts5SearchStrategy,
  KnowledgeSearchService,
  applyTemporalDecay,
} from './knowledge-search.service.js';
import type { KnowledgeDocumentSummary } from '../../types/knowledge.types.js';

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

// Mock KnowledgeService
const mockListDocuments = jest.fn();
jest.mock('./knowledge.service.js', () => ({
  KnowledgeService: {
    getInstance: () => ({
      listDocuments: mockListDocuments,
    }),
  },
}));

// Mock Fts5IndexService
const mockFts5Search = jest.fn();
jest.mock('./fts5-index.service.js', () => ({
  Fts5IndexService: jest.fn().mockImplementation(() => ({
    search: mockFts5Search,
  })),
}));

/** Access the mocked Fts5IndexService constructor for call-arg assertions. */
function getFts5IndexServiceMock(): jest.Mock {
  const mod = jest.requireMock('./fts5-index.service.js') as {
    Fts5IndexService: jest.Mock;
  };
  return mod.Fts5IndexService;
}

/** Helper to create a test document summary */
function makeDoc(
  overrides: Partial<KnowledgeDocumentSummary> = {},
): KnowledgeDocumentSummary {
  return {
    id: overrides.id ?? 'doc-1',
    title: overrides.title ?? 'Test Document',
    category: overrides.category ?? 'General',
    tags: overrides.tags ?? [],
    preview: overrides.preview ?? 'Some preview text',
    scope: overrides.scope ?? 'global',
    createdBy: overrides.createdBy ?? 'user',
    updatedBy: overrides.updatedBy ?? 'user',
    createdAt: overrides.createdAt ?? '2024-01-01T00:00:00Z',
    updatedAt: overrides.updatedAt ?? '2024-01-01T00:00:00Z',
  };
}

describe('KeywordSearchStrategy', () => {
  const strategy = new KeywordSearchStrategy();

  it('should return empty array for empty query', async () => {
    const docs = [makeDoc()];
    const results = await strategy.search('', docs);
    expect(results).toHaveLength(0);
  });

  it('should return empty array for single-character words', async () => {
    const docs = [makeDoc()];
    const results = await strategy.search('a b c', docs);
    expect(results).toHaveLength(0);
  });

  it('should match title with 3x weight', async () => {
    const doc = makeDoc({ title: 'Deploy Runbook', preview: 'other content', tags: [] });
    const results = await strategy.search('deploy', [doc]);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(3);
  });

  it('should match tags with 2x weight', async () => {
    const doc = makeDoc({ title: 'Other', tags: ['deployment'], preview: 'other' });
    const results = await strategy.search('deployment', [doc]);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(2);
  });

  it('should match preview with 1x weight', async () => {
    const doc = makeDoc({ title: 'Other', tags: [], preview: 'contains deployment info' });
    const results = await strategy.search('deployment', [doc]);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(1);
  });

  it('should accumulate scores across fields', async () => {
    const doc = makeDoc({
      title: 'Deployment Guide',
      tags: ['deployment'],
      preview: 'How to deployment',
    });
    const results = await strategy.search('deployment', [doc]);
    expect(results).toHaveLength(1);
    // title: 3 + tag: 2 + preview: 1 = 6
    expect(results[0].score).toBe(6);
  });

  it('should sort results by score descending', async () => {
    const docs = [
      makeDoc({ id: 'low', title: 'Other', tags: [], preview: 'deploy info' }),
      makeDoc({ id: 'high', title: 'Deploy Guide', tags: ['deploy'], preview: 'deploy' }),
    ];
    const results = await strategy.search('deploy', docs);
    expect(results[0].document.id).toBe('high');
    expect(results[1].document.id).toBe('low');
  });

  it('should exclude documents with zero score', async () => {
    const docs = [
      makeDoc({ id: 'match', title: 'Deploy', tags: [], preview: '' }),
      makeDoc({ id: 'no-match', title: 'Cooking Recipes', tags: ['food'], preview: 'pasta' }),
    ];
    const results = await strategy.search('deploy', docs);
    expect(results).toHaveLength(1);
    expect(results[0].document.id).toBe('match');
  });

  it('should handle multiple query words', async () => {
    const doc = makeDoc({ title: 'Deploy API', tags: [], preview: '' });
    const results = await strategy.search('deploy api', [doc]);
    // 'deploy' in title: 3, 'api' in title: 3 => 6
    expect(results[0].score).toBe(6);
  });
});

describe('Fts5SearchStrategy', () => {
  let strategy: Fts5SearchStrategy;

  beforeEach(() => {
    strategy = new Fts5SearchStrategy();
    mockFts5Search.mockReset();
  });

  it('constructs its global index under the user home directory, not /tmp (R1.1)', () => {
    // Ensure HOME/USERPROFILE are unset to prove the ctor now uses
    // os.homedir() — the old fallback would have landed on /tmp.
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    try {
      const ctorMock = getFts5IndexServiceMock();
      ctorMock.mockClear();
      new Fts5SearchStrategy();
      const globalPathArg = ctorMock.mock.calls[0][0] as string;
      expect(globalPathArg).not.toMatch(/^\/tmp\b/);
      expect(globalPathArg).toContain('.crewly');
      expect(globalPathArg).toContain('knowledge');
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      if (savedUserProfile !== undefined) process.env.USERPROFILE = savedUserProfile;
    }
  });

  it('should use FTS5 index for searching', async () => {
    mockFts5Search.mockReturnValue([
      { id: 'fts-1', title: 'FTS Result', tags: 'tag1', content: 'content', category: 'General', rank: -1.5 },
    ]);

    const results = await strategy.search('query', []);
    expect(mockFts5Search).toHaveBeenCalledWith('query', { category: undefined, limit: undefined });
    expect(results).toHaveLength(1);
    expect(results[0].document.id).toBe('fts-1');
  });

  it('should preserve real createdAt/updatedAt from the candidate list (R2.2)', async () => {
    // Pin an FTS5 hit that has a matching candidate with real dates.
    mockFts5Search.mockReturnValue([
      { id: 'doc-real', title: 'Old Doc', tags: '', content: 'hello', category: 'General', rank: -2 },
    ]);

    const realCreatedAt = '2020-01-01T00:00:00.000Z';
    const candidate = makeDoc({ id: 'doc-real', createdAt: realCreatedAt, updatedAt: realCreatedAt });

    const results = await strategy.search('q', [candidate]);
    expect(results).toHaveLength(1);
    // Must carry through real metadata, not "now" — otherwise temporal
    // decay becomes a no-op for every FTS5 hit.
    expect(results[0].document.createdAt).toBe(realCreatedAt);
    expect(results[0].document.updatedAt).toBe(realCreatedAt);
  });

  it('should fall back to keyword search when FTS5 returns no results', async () => {
    mockFts5Search.mockReturnValue([]);
    const docs = [makeDoc({ id: 'kw-1', title: 'Keyword Match' })];
    
    const results = await strategy.search('keyword', docs);
    expect(results).toHaveLength(1);
    expect(results[0].document.id).toBe('kw-1');
  });
});

describe('GeminiEmbeddingStrategy', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('should fall back to keyword search when embedding fails', async () => {
    fetchSpy.mockRejectedValue(new Error('Network error'));

    const strategy = new GeminiEmbeddingStrategy('fake-key');
    const doc = makeDoc({ title: 'Deploy Guide', tags: [], preview: '' });
    const results = await strategy.search('deploy', [doc]);

    // Should fall back to keyword strategy and still find the doc
    expect(results).toHaveLength(1);
    expect(results[0].document.id).toBe('doc-1');
  });

  it('should fall back when API returns non-OK status', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 401,
    } as Response);

    const strategy = new GeminiEmbeddingStrategy('bad-key');
    const doc = makeDoc({ title: 'Deploy Guide', tags: [], preview: '' });
    const results = await strategy.search('deploy', [doc]);

    expect(results).toHaveLength(1);
  });

  it('should use cosine similarity when embeddings succeed', async () => {
    // Mock fetch to return embeddings
    let callCount = 0;
    fetchSpy.mockImplementation(async () => {
      callCount++;
      // First call: query embedding. Second call: doc embedding.
      // Use vectors with known cosine similarity
      const values = callCount === 1 ? [1, 0, 0] : [0.9, 0.1, 0];
      return {
        ok: true,
        json: async () => ({ embedding: { values } }),
      } as unknown as Response;
    });

    const strategy = new GeminiEmbeddingStrategy('good-key');
    const doc = makeDoc({ title: 'Deploy', tags: [], preview: 'guide' });
    const results = await strategy.search('deploy', [doc]);

    expect(results).toHaveLength(1);
    expect(results[0].score).toBeGreaterThan(0);
  });
});

describe('KnowledgeSearchService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    KnowledgeSearchService.resetInstance();
    mockListDocuments.mockReset();
    mockFts5Search.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
    KnowledgeSearchService.resetInstance();
  });

  it('should return singleton instance', () => {
    const a = KnowledgeSearchService.getInstance();
    const b = KnowledgeSearchService.getInstance();
    expect(a).toBe(b);
  });

  it('should use FTS5 strategy by default', async () => {
    const service = KnowledgeSearchService.getInstance();
    const docs = [makeDoc({ title: 'Deploy Runbook' })];
    mockListDocuments.mockResolvedValue(docs);
    mockFts5Search.mockReturnValue([]); // Fallback to keyword

    const results = await service.search('deploy', 'global');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Deploy Runbook');
  });

  it('hits FTS5 before the keyword fallback (pins the docstring contract from Q3.1)', async () => {
    const service = KnowledgeSearchService.getInstance();
    mockListDocuments.mockResolvedValue([]);
    mockFts5Search.mockReturnValue([]);

    await service.search('anything', 'global');
    // Docstring says FTS5 is default; proving it means mockFts5Search
    // must be consulted on every search.
    expect(mockFts5Search).toHaveBeenCalledTimes(1);
  });

  it('should return empty array when no documents exist', async () => {
    const service = KnowledgeSearchService.getInstance();
    mockListDocuments.mockResolvedValue([]);
    mockFts5Search.mockReturnValue([]);

    const results = await service.search('deploy', 'global');
    expect(results).toHaveLength(0);
  });

  it('should respect limit parameter', async () => {
    const service = KnowledgeSearchService.getInstance();
    const docs = [
      makeDoc({ id: '1', title: 'Deploy A' }),
      makeDoc({ id: '2', title: 'Deploy B' }),
      makeDoc({ id: '3', title: 'Deploy C' }),
    ];
    mockListDocuments.mockResolvedValue(docs);
    mockFts5Search.mockReturnValue([]); // Fallback

    const results = await service.search('deploy', 'global', undefined, undefined, 2);
    expect(results).toHaveLength(2);
  });

  it('should pass category filter to listDocuments', async () => {
    const service = KnowledgeSearchService.getInstance();
    mockListDocuments.mockResolvedValue([]);
    mockFts5Search.mockReturnValue([]);

    await service.search('deploy', 'global', undefined, 'Runbooks');
    expect(mockListDocuments).toHaveBeenCalledWith('global', undefined, { category: 'Runbooks' });
  });

  it('should pass projectPath for project scope', async () => {
    const service = KnowledgeSearchService.getInstance();
    mockListDocuments.mockResolvedValue([]);
    mockFts5Search.mockReturnValue([]);

    await service.search('deploy', 'project', '/path/to/project');
    expect(mockListDocuments).toHaveBeenCalledWith('project', '/path/to/project', { category: undefined });
  });
});

describe('#154: applyTemporalDecay', () => {
  it('should decay score based on age', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const decayed = applyTemporalDecay(10, thirtyDaysAgo, []);
    // After exactly 1 half-life (30 days), score should be ~5
    expect(decayed).toBeCloseTo(5, 0);
  });

  it('should return full score for recent documents', () => {
    const now = new Date().toISOString();
    const decayed = applyTemporalDecay(10, now, []);
    expect(decayed).toBeCloseTo(10, 1);
  });

  it('should bypass decay for evergreen tags', () => {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    expect(applyTemporalDecay(10, sixtyDaysAgo, ['evergreen'])).toBe(10);
    expect(applyTemporalDecay(10, sixtyDaysAgo, ['Decision'])).toBe(10);
    expect(applyTemporalDecay(10, sixtyDaysAgo, ['architecture'])).toBe(10);
    expect(applyTemporalDecay(10, sixtyDaysAgo, ['SOP'])).toBe(10);
    expect(applyTemporalDecay(10, sixtyDaysAgo, ['runbook'])).toBe(10);
  });

  it('should not bypass decay for non-evergreen tags', () => {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const decayed = applyTemporalDecay(10, sixtyDaysAgo, ['general', 'learning']);
    // After 60 days (2 half-lives), score should be ~2.5
    expect(decayed).toBeCloseTo(2.5, 0);
  });

  it('should handle future dates gracefully', () => {
    const future = new Date(Date.now() + 10000).toISOString();
    expect(applyTemporalDecay(10, future, [])).toBe(10);
  });

  it('should re-rank results by temporal decay in KnowledgeSearchService', async () => {
    KnowledgeSearchService.resetInstance();
    const service = KnowledgeSearchService.getInstance();

    const recentDoc = makeDoc({
      id: 'recent',
      title: 'deploy instructions new',
      createdAt: new Date().toISOString(),
    });
    const oldDoc = makeDoc({
      id: 'old',
      title: 'deploy instructions old',
      createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    });

    // Both docs match "deploy" equally, but recent doc should rank higher
    mockListDocuments.mockResolvedValue([oldDoc, recentDoc]);
    mockFts5Search.mockReturnValue([]);

    const results = await service.search('deploy instructions', 'global');
    expect(results[0].id).toBe('recent');
  });
});
