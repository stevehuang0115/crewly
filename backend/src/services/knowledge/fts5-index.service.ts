/**
 * FTS5 Index Service
 *
 * Manages a SQLite FTS5 full-text search index for the Wiki-First
 * Knowledge System. Provides upsert, remove, search, and rebuild
 * operations over a `knowledge_fts` virtual table using Porter stemming
 * and Unicode61 tokenization.
 *
 * The database file is stored at `<knowledgePath>/index.fts5.db`.
 *
 * @module services/knowledge/fts5-index.service
 */

import * as path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';

// ---------------------------------------------------------------------------
// Lazy module loading
// ---------------------------------------------------------------------------

/** Lazy-loaded better-sqlite3 module reference. */
let _BetterSqlite3: typeof import('better-sqlite3') | null = null;

/**
 * Load better-sqlite3 on demand. Throws a clear error if the native module
 * is not available.
 */
function getBetterSqlite3(): typeof import('better-sqlite3') {
  if (!_BetterSqlite3) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      _BetterSqlite3 = require('better-sqlite3');
    } catch (err) {
      throw new Error(
        'better-sqlite3 native module failed to load. Run `npm rebuild better-sqlite3` to fix. ' +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return _BetterSqlite3!;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Type alias for a better-sqlite3 Database instance */
type DatabaseType = import('better-sqlite3').Database;

/**
 * A single result from an FTS5 search query.
 */
export interface FtsSearchResult {
  /** Document identifier */
  id: string;
  /** Document title */
  title: string;
  /** Space-separated tags */
  tags: string;
  /** Document body content */
  content: string;
  /** Document category */
  category: string;
  /** BM25 relevance rank (lower/more negative = more relevant in FTS5) */
  rank: number;
}

/**
 * Input document shape for upserting into the FTS5 index.
 */
export interface FtsDocument {
  /** Unique document identifier */
  id: string;
  /** Document title */
  title: string;
  /** Space-separated or comma-separated tags */
  tags: string;
  /** Document body content */
  content: string;
  /** Document category */
  category: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Fts5IndexService manages a SQLite FTS5 full-text search database.
 *
 * It lazily initializes the database and FTS5 virtual table on first use,
 * and provides methods to upsert, remove, search, and rebuild the index.
 *
 * @example
 * ```typescript
 * const fts5 = new Fts5IndexService('/path/to/knowledge');
 * fts5.upsertDocument({ id: 'doc-1', title: 'Setup', tags: 'devops', content: '...', category: 'SOPs' });
 * const results = fts5.search('setup devops');
 * ```
 */
export class Fts5IndexService {
  private db: DatabaseType | null = null;
  private readonly dbPath: string;
  private readonly logger: ComponentLogger;

  /**
   * Create an Fts5IndexService.
   *
   * @param knowledgePath - Directory where the FTS5 database will be stored
   */
  constructor(knowledgePath: string) {
    this.dbPath = path.join(knowledgePath, 'index.fts5.db');
    this.logger = LoggerService.getInstance().createComponentLogger('Fts5IndexService');
  }

  /**
   * Get or lazily initialize the SQLite database connection.
   * Creates the parent directory and FTS5 virtual table if they do not exist.
   *
   * @returns The better-sqlite3 Database instance
   */
  private getDb(): DatabaseType {
    if (this.db) {
      return this.db;
    }

    // Ensure parent directory exists
    const dir = path.dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const Database = getBetterSqlite3();
    this.db = new Database(this.dbPath);

    // Performance pragmas
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.initSchema();

    this.logger.info('FTS5 index database opened', { path: this.dbPath });
    return this.db;
  }

  /**
   * Create the FTS5 virtual table if it does not already exist.
   * Uses Porter stemming and Unicode61 tokenization for broad language support.
   */
  private initSchema(): void {
    const db = this.db!;
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        id UNINDEXED,
        title,
        tags,
        content,
        category UNINDEXED,
        tokenize='porter unicode61'
      );
    `);
  }

  /**
   * Upsert a document into the FTS5 index.
   * Removes any existing row with the same ID before inserting.
   *
   * @param doc - The document to upsert
   */
  upsertDocument(doc: FtsDocument): void {
    const db = this.getDb();

    // FTS5 tables do not support ON CONFLICT, so delete-then-insert
    const deleteStmt = db.prepare('DELETE FROM knowledge_fts WHERE id = ?');
    const insertStmt = db.prepare(
      'INSERT INTO knowledge_fts (id, title, tags, content, category) VALUES (?, ?, ?, ?, ?)',
    );

    const txn = db.transaction(() => {
      deleteStmt.run(doc.id);
      insertStmt.run(doc.id, doc.title, doc.tags, doc.content, doc.category);
    });
    txn();
  }

  /**
   * Remove a document from the FTS5 index by its ID.
   *
   * @param id - The document identifier to remove
   */
  removeDocument(id: string): void {
    const db = this.getDb();
    db.prepare('DELETE FROM knowledge_fts WHERE id = ?').run(id);
  }

  /**
   * Search the FTS5 index using a MATCH query with BM25 ranking.
   *
   * @param query - The search query string (FTS5 MATCH syntax)
   * @param options - Optional search parameters
   * @param options.category - Filter results by category
   * @param options.limit - Maximum number of results (default 10)
   * @returns Array of matching documents sorted by relevance
   */
  search(query: string, options?: { category?: string; limit?: number }): FtsSearchResult[] {
    if (!query || query.trim().length === 0) {
      return [];
    }

    const db = this.getDb();
    const limit = options?.limit ?? 10;

    // Sanitize query: remove characters that break FTS5 MATCH syntax
    const sanitized = query.replace(/['"*(){}[\]^~\\]/g, ' ').trim();
    if (sanitized.length === 0) {
      return [];
    }

    try {
      if (options?.category) {
        const stmt = db.prepare(`
          SELECT id, title, tags, content, category, rank
          FROM knowledge_fts
          WHERE knowledge_fts MATCH ?
            AND category = ?
          ORDER BY rank
          LIMIT ?
        `);
        return stmt.all(sanitized, options.category, limit) as FtsSearchResult[];
      }

      const stmt = db.prepare(`
        SELECT id, title, tags, content, category, rank
        FROM knowledge_fts
        WHERE knowledge_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `);
      return stmt.all(sanitized, limit) as FtsSearchResult[];
    } catch (err) {
      this.logger.warn('FTS5 search query failed, returning empty results', {
        query: sanitized,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Rebuild the entire FTS5 index from scratch.
   * Drops all existing rows and reinserts the provided documents in a single transaction.
   *
   * @param documents - The complete set of documents to index
   */
  rebuildIndex(documents: FtsDocument[]): void {
    const db = this.getDb();

    const deleteAll = db.prepare('DELETE FROM knowledge_fts');
    const insertStmt = db.prepare(
      'INSERT INTO knowledge_fts (id, title, tags, content, category) VALUES (?, ?, ?, ?, ?)',
    );

    const txn = db.transaction(() => {
      deleteAll.run();
      for (const doc of documents) {
        insertStmt.run(doc.id, doc.title, doc.tags, doc.content, doc.category);
      }
    });
    txn();

    this.logger.info('FTS5 index rebuilt', { documentCount: documents.length });
  }

  /**
   * Close the database connection and release resources.
   */
  close(): void {
    if (this.db) {
      try {
        this.db.close();
        this.logger.debug('FTS5 index database closed', { path: this.dbPath });
      } catch (err) {
        this.logger.warn('Error closing FTS5 database', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.db = null;
    }
  }
}
