/**
 * Unit tests for WikiCompilerService
 *
 * Tests YAML frontmatter parsing, markdown file indexing, reindex operations,
 * and search delegation to the FTS5 index service. Uses temporary directories
 * with test .md files and mocks better-sqlite3/FTS5 dependencies.
 *
 * @module services/knowledge/wiki-compiler.service.test
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import { parseFrontmatter, WikiCompilerService } from './wiki-compiler.service.js';

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
// Mock Fts5IndexService
// ---------------------------------------------------------------------------

const mockUpsertDocument = jest.fn();
const mockRebuildIndex = jest.fn();
const mockSearch = jest.fn().mockReturnValue([]);
const mockClose = jest.fn();

jest.mock('./fts5-index.service.js', () => ({
  Fts5IndexService: jest.fn().mockImplementation(() => ({
    upsertDocument: mockUpsertDocument,
    rebuildIndex: mockRebuildIndex,
    search: mockSearch,
    close: mockClose,
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-compiler-test-'));
});

afterAll(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

beforeEach(() => {
  jest.clearAllMocks();
});

/**
 * Create a markdown file with optional frontmatter in a given directory.
 *
 * @param dir - Directory to write the file in
 * @param filename - Filename (should end with .md)
 * @param frontmatter - YAML frontmatter key-value pairs
 * @param body - Markdown body content
 * @returns Absolute path to the created file
 */
function createMdFile(
  dir: string,
  filename: string,
  frontmatter: Record<string, string> = {},
  body: string = 'Default body content.',
): string {
  fs.mkdirSync(dir, { recursive: true });

  let content = '';
  const fmKeys = Object.keys(frontmatter);
  if (fmKeys.length > 0) {
    content += '---\n';
    for (const key of fmKeys) {
      content += `${key}: ${frontmatter[key]}\n`;
    }
    content += '---\n';
  }
  content += body;

  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// ---------------------------------------------------------------------------
// parseFrontmatter tests
// ---------------------------------------------------------------------------

describe('parseFrontmatter', () => {
  it('extracts YAML frontmatter correctly', () => {
    const content = '---\ntitle: My Document\ncategory: SOPs\ntags: devops, deploy\n---\nBody text here.';
    const result = parseFrontmatter(content);

    expect(result.frontmatter.title).toBe('My Document');
    expect(result.frontmatter.category).toBe('SOPs');
    expect(result.frontmatter.tags).toBe('devops, deploy');
    expect(result.body).toBe('Body text here.');
  });

  it('handles files without frontmatter', () => {
    const content = 'Just a plain markdown file with no frontmatter.';
    const result = parseFrontmatter(content);

    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(content);
  });

  it('handles array values in frontmatter', () => {
    const content = '---\ntags: ["tag1", "tag2", "tag3"]\n---\nBody.';
    const result = parseFrontmatter(content);

    expect(result.frontmatter.tags).toBe('tag1, tag2, tag3');
    expect(result.body).toBe('Body.');
  });

  it('handles single-quoted array values', () => {
    const content = "---\ntags: ['alpha', 'beta']\n---\nContent.";
    const result = parseFrontmatter(content);

    expect(result.frontmatter.tags).toBe('alpha, beta');
  });

  it('strips surrounding quotes from values', () => {
    const content = '---\ntitle: "Quoted Title"\n---\nBody.';
    const result = parseFrontmatter(content);

    expect(result.frontmatter.title).toBe('Quoted Title');
  });

  it('handles empty frontmatter block', () => {
    const content = '---\n\n---\nBody only.';
    const result = parseFrontmatter(content);

    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe('Body only.');
  });

  it('handles values containing colons', () => {
    const content = '---\ntitle: Step 1: Configure the server\n---\nBody.';
    const result = parseFrontmatter(content);

    expect(result.frontmatter.title).toBe('Step 1: Configure the server');
  });
});

// ---------------------------------------------------------------------------
// WikiCompilerService tests
// ---------------------------------------------------------------------------

describe('WikiCompilerService', () => {
  let knowledgeDir: string;
  let service: WikiCompilerService;

  beforeEach(() => {
    knowledgeDir = path.join(
      tempDir,
      `knowledge-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(knowledgeDir, { recursive: true });
    service = new WikiCompilerService(knowledgeDir);
  });

  afterEach(() => {
    service.close();
  });

  // -----------------------------------------------------------------------
  // reindex
  // -----------------------------------------------------------------------

  describe('reindex', () => {
    it('returns correct count of indexed files', async () => {
      createMdFile(knowledgeDir, 'doc1.md', { title: 'Doc One', category: 'SOPs' }, 'First doc.');
      createMdFile(knowledgeDir, 'doc2.md', { title: 'Doc Two', category: 'General' }, 'Second doc.');
      createMdFile(knowledgeDir, 'doc3.md', { title: 'Doc Three' }, 'Third doc.');

      const result = await service.reindex();

      expect(result.indexed).toBe(3);
      expect(result.errors).toHaveLength(0);
      expect(mockRebuildIndex).toHaveBeenCalledTimes(1);
      expect(mockRebuildIndex).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ title: 'Doc One' }),
          expect.objectContaining({ title: 'Doc Two' }),
          expect.objectContaining({ title: 'Doc Three' }),
        ]),
      );
    });

    it('handles empty directory gracefully', async () => {
      const result = await service.reindex();

      expect(result.indexed).toBe(0);
      expect(result.errors).toHaveLength(0);
      // rebuildIndex should not be called when there are no files
      expect(mockRebuildIndex).not.toHaveBeenCalled();
    });

    it('indexes files in subdirectories recursively', async () => {
      const subDir = path.join(knowledgeDir, 'sub', 'nested');
      createMdFile(subDir, 'nested-doc.md', { title: 'Nested' }, 'Deep content.');
      createMdFile(knowledgeDir, 'root-doc.md', { title: 'Root' }, 'Root content.');

      const result = await service.reindex();

      expect(result.indexed).toBe(2);
    });

    it('derives ID from filename when frontmatter has no id', async () => {
      createMdFile(knowledgeDir, 'My Setup Guide.md', {}, 'Content.');

      await service.reindex();

      expect(mockRebuildIndex).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'my-setup-guide' }),
        ]),
      );
    });

    it('uses frontmatter id when present', async () => {
      createMdFile(knowledgeDir, 'some-file.md', { id: 'custom-id', title: 'Custom' }, 'Content.');

      await service.reindex();

      expect(mockRebuildIndex).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'custom-id' }),
        ]),
      );
    });
  });

  // -----------------------------------------------------------------------
  // indexFile
  // -----------------------------------------------------------------------

  describe('indexFile', () => {
    it('indexes a single file via upsertDocument', async () => {
      const filePath = createMdFile(
        knowledgeDir,
        'single.md',
        { title: 'Single Doc', category: 'Runbooks', tags: 'ops' },
        'Single file content.',
      );

      await service.indexFile(filePath);

      expect(mockUpsertDocument).toHaveBeenCalledTimes(1);
      expect(mockUpsertDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Single Doc',
          category: 'Runbooks',
          tags: 'ops',
          content: 'Single file content.',
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // search
  // -----------------------------------------------------------------------

  describe('search', () => {
    it('delegates to FTS5 service', () => {
      const mockResults = [
        { id: 'r1', title: 'Result', tags: '', content: 'body', category: 'General', rank: -1.5 },
      ];
      mockSearch.mockReturnValue(mockResults);

      const results = service.search('test query', { category: 'General', limit: 5 });

      expect(mockSearch).toHaveBeenCalledWith('test query', { category: 'General', limit: 5 });
      expect(results).toEqual(mockResults);
    });
  });

  // -----------------------------------------------------------------------
  // close
  // -----------------------------------------------------------------------

  describe('close', () => {
    it('delegates close to FTS5 service', () => {
      service.close();
      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });
});
