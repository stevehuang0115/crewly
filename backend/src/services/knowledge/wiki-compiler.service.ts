/**
 * Wiki Compiler Service
 *
 * Reads Markdown files with YAML frontmatter from the `.crewly/knowledge/`
 * directory and indexes them into the FTS5 full-text search database.
 * Provides reindexing, single-file indexing, and search capabilities.
 *
 * @module services/knowledge/wiki-compiler.service
 */

import * as path from 'path';
import { promises as fs } from 'fs';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { Fts5IndexService, type FtsSearchResult } from './fts5-index.service.js';

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

/**
 * Parsed frontmatter result containing extracted metadata and the body text.
 */
interface ParsedFrontmatter {
  /** Key-value pairs extracted from YAML frontmatter */
  frontmatter: Record<string, string>;
  /** The markdown body after the frontmatter block */
  body: string;
}

/**
 * Parse YAML frontmatter from a Markdown file content string.
 * Handles simple key: value pairs and bracket-delimited arrays.
 * Does not require an external YAML parsing dependency.
 *
 * @param content - Raw file content including frontmatter
 * @returns Parsed frontmatter object and body text
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const fm: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // Handle arrays: ["tag1", "tag2"] -> "tag1, tag2"
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .join(', ');
    }

    // Strip surrounding quotes
    value = value.replace(/^["']|["']$/g, '');
    fm[key] = value;
  }

  return { frontmatter: fm, body: match[2] };
}

/**
 * Derive a stable document ID from a file path.
 * Uses the filename without extension, lowercased, with spaces replaced by hyphens.
 *
 * @param filePath - Absolute or relative path to the markdown file
 * @returns A URL-safe identifier string
 */
function idFromFilename(filePath: string): string {
  const basename = path.basename(filePath, '.md');
  return basename.toLowerCase().replace(/\s+/g, '-');
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * WikiCompilerService scans `.md` files in a knowledge directory, parses
 * their YAML frontmatter, and indexes the content into an FTS5 database
 * for fast full-text search.
 *
 * @example
 * ```typescript
 * const compiler = new WikiCompilerService('/Users/me/.crewly/knowledge');
 * const { indexed, errors } = await compiler.reindex();
 * const results = compiler.search('deployment guide');
 * ```
 */
export class WikiCompilerService {
  private readonly fts5: Fts5IndexService;
  private readonly knowledgePath: string;
  private readonly logger: ComponentLogger;

  /**
   * Create a WikiCompilerService.
   *
   * @param knowledgePath - Directory containing `.md` knowledge files
   */
  constructor(knowledgePath: string) {
    this.knowledgePath = knowledgePath;
    this.fts5 = new Fts5IndexService(knowledgePath);
    this.logger = LoggerService.getInstance().createComponentLogger('WikiCompilerService');
  }

  /**
   * Get the path to the knowledge directory.
   *
   * @returns The absolute path to the knowledge directory
   */
  getKnowledgePath(): string {
    return this.knowledgePath;
  }

  /**
   * Recursively find all `.md` files under the knowledge directory.
   *
   * @returns Array of absolute file paths
   */
  async getMarkdownFiles(): Promise<string[]> {
    return this.globMarkdownFiles();
  }

  /**
   * Scan all `.md` files in the knowledge directory (recursively), parse
   * their frontmatter, and rebuild the FTS5 index from scratch.
   *
   * @returns An object with the count of indexed documents and any errors encountered
   */
  async reindex(): Promise<{ indexed: number; errors: string[] }> {
    const errors: string[] = [];
    const files = await this.globMarkdownFiles();

    if (files.length === 0) {
      this.logger.info('No markdown files found for indexing', { path: this.knowledgePath });
      return { indexed: 0, errors };
    }

    const documents: Array<{ id: string; title: string; tags: string; content: string; category: string }> = [];

    for (const filePath of files) {
      try {
        const doc = await this.parseFile(filePath);
        documents.push(doc);
      } catch (err) {
        const msg = `Failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        this.logger.warn('Failed to parse markdown file during reindex', { filePath, error: msg });
      }
    }

    this.fts5.rebuildIndex(documents);
    this.logger.info('Wiki reindex complete', { indexed: documents.length, errors: errors.length });

    return { indexed: documents.length, errors };
  }

  /**
   * Index a single markdown file into the FTS5 database.
   *
   * @param filePath - Absolute path to the markdown file
   */
  async indexFile(filePath: string): Promise<void> {
    const doc = await this.parseFile(filePath);
    this.fts5.upsertDocument(doc);
    this.logger.debug('Indexed single file', { filePath, id: doc.id });
  }

  /**
   * Search the knowledge base using FTS5 full-text search.
   *
   * @param query - The search query string
   * @param options - Optional search parameters (category filter, result limit)
   * @returns Array of matching documents sorted by BM25 relevance
   */
  search(query: string, options?: { category?: string; limit?: number }): FtsSearchResult[] {
    return this.fts5.search(query, options);
  }

  /**
   * Get direct access to the underlying FTS5 index service.
   *
   * @returns The Fts5IndexService instance
   */
  getFts5(): Fts5IndexService {
    return this.fts5;
  }

  /**
   * Close the underlying FTS5 database connection.
   */
  close(): void {
    this.fts5.close();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Recursively find all `.md` files under the knowledge directory.
   *
   * @returns Array of absolute file paths
   */
  private async globMarkdownFiles(): Promise<string[]> {
    const results: string[] = [];

    const walkDir = async (dir: string): Promise<void> => {
      let entries: import('fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walkDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          results.push(fullPath);
        }
      }
    };

    await walkDir(this.knowledgePath);
    return results;
  }

  /**
   * Read and parse a single markdown file into an FTS5 document shape.
   *
   * @param filePath - Absolute path to the markdown file
   * @returns Parsed document ready for FTS5 indexing
   */
  private async parseFile(
    filePath: string,
  ): Promise<{ id: string; title: string; tags: string; content: string; category: string }> {
    const raw = await fs.readFile(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw);

    const id = frontmatter.id || idFromFilename(filePath);
    const title = frontmatter.title || path.basename(filePath, '.md');
    const tags = frontmatter.tags || '';
    const category = frontmatter.category || 'General';
    const content = body.trim();

    return { id, title, tags, content, category };
  }
}
