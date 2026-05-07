/**
 * Vector Store Service — v2
 *
 * Local, on-device vector storage using SQLite (better-sqlite3) with optional
 * sqlite-vec extension for native KNN search. Falls back gracefully to
 * JavaScript cosine similarity when the extension is unavailable.
 *
 * v2 improvements over v1:
 * - Binary BLOB storage (Float32Array) instead of JSON TEXT (~4× smaller, faster)
 * - Optional sqlite-vec integration for native SQL-based KNN search (cosine metric)
 * - Dimension validation ensures all vectors in a scope share the same width
 * - Prepared statement caching for repeated operations
 * - Input sanitization (NaN, Infinity rejection)
 * - Batch upsert with transaction wrapping
 * - Automatic schema migration from v1 (JSON TEXT) databases
 *
 * Storage locations:
 * - Global scope: ~/.crewly/vector-store.db
 * - Project scope: {projectPath}/.crewly/vector-store.db
 *
 * @module services/knowledge/vector-store.service
 */

import * as path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { createBareModuleRequire } from '../../utils/node-require.utils.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { CREWLY_CONSTANTS } from '../../constants.js';

// ---------------------------------------------------------------------------
// Lazy module loading
// ---------------------------------------------------------------------------

/**
 * CJS-style `require` scoped to this module. better-sqlite3 and sqlite-vec
 * are native addons and must be loaded via CJS `require`, but this file
 * compiles to ESM (root package has `"type": "module"`) where the bare
 * `require` global is undefined. `createRequire(<base URL>)` bridges the two.
 *
 * The `typeof require === 'function'` guard inside the helper means
 * tests transpiled to CommonJS (ts-jest) reuse the CJS `require`
 * directly. For the ESM branch the helper anchors `createRequire` to
 * THIS file's URL via `import.meta.url`, hidden behind direct `eval`
 * so ts-jest's parser does not see the meta-property token (TS1343).
 * The eval branch never executes under CJS — the `require`-typeof
 * short-circuit fires first.
 *
 * @see backend/src/utils/node-require.utils.ts
 */
const nodeRequire = createBareModuleRequire(
  typeof require === 'function' ? require : null,
);

/**
 * Lazy-loaded better-sqlite3 module reference.
 * Uses dynamic require so that a native-module load failure does NOT cascade
 * to every test file that transitively imports this service.
 *
 * @see https://github.com/stevehuang0115/crewly/issues/170
 */
let _BetterSqlite3: typeof import('better-sqlite3') | null = null;

/**
 * Load better-sqlite3 on demand. Throws a clear error if the native module
 * is not available (e.g. needs `npm rebuild better-sqlite3`).
 */
function getBetterSqlite3(): typeof import('better-sqlite3') {
  if (!_BetterSqlite3) {
    try {
      _BetterSqlite3 = nodeRequire('better-sqlite3');
    } catch (err) {
      throw new Error(
        'better-sqlite3 native module failed to load. Run `npm rebuild better-sqlite3` to fix. ' +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return _BetterSqlite3!;
}

/** Lazy-loaded sqlite-vec extension loader. */
let _sqliteVec: { load: (db: unknown) => void } | null = null;
let _sqliteVecLoadAttempted = false;

/**
 * Attempt to load the sqlite-vec module. Returns null if unavailable.
 */
function getSqliteVec(): { load: (db: unknown) => void } | null {
  if (!_sqliteVecLoadAttempted) {
    _sqliteVecLoadAttempted = true;
    try {
      _sqliteVec = nodeRequire('sqlite-vec');
    } catch {
      _sqliteVec = null;
    }
  }
  return _sqliteVec;
}

/** Reset the sqlite-vec loader state (for testing). */
export function resetSqliteVecLoader(): void {
  _sqliteVec = null;
  _sqliteVecLoadAttempted = false;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Type alias for a better-sqlite3 Database instance */
type DatabaseType = import('better-sqlite3').Database;
/** Type alias for a better-sqlite3 Statement */
type StatementType = import('better-sqlite3').Statement;

/** Constants for the vector store */
export const VECTOR_STORE_CONSTANTS = {
  /** SQLite database filename */
  DB_FILENAME: 'vector-store.db',
  /** Default number of results for similarity search */
  DEFAULT_SEARCH_LIMIT: 10,
  /** Minimum cosine similarity threshold for search results */
  DEFAULT_SIMILARITY_THRESHOLD: 0.1,
  /** Maximum metadata JSON size (bytes) */
  MAX_METADATA_SIZE: 65536,
  /** Current schema version */
  SCHEMA_VERSION: 2,
  /** Maximum supported embedding dimensions */
  MAX_DIMENSIONS: 4096,
  /** Maximum items in a single batch upsert */
  MAX_BATCH_SIZE: 500,
} as const;

/**
 * A stored embedding record with metadata.
 */
export interface VectorRecord {
  /** Unique identifier (typically document ID) */
  id: string;
  /** The embedding vector as a Float64 array */
  embedding: number[];
  /** Optional metadata associated with the embedding */
  metadata: Record<string, unknown>;
  /** ISO timestamp of when the embedding was stored */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
}

/**
 * A search result with cosine similarity score.
 */
export interface VectorSearchResult {
  /** Unique identifier */
  id: string;
  /** Cosine similarity score (higher is more similar) */
  score: number;
  /** Associated metadata */
  metadata: Record<string, unknown>;
}

/**
 * Raw row shape returned by SQLite queries.
 */
interface EmbeddingRow {
  id: string;
  embedding: Buffer | string;
  metadata: string;
  dimensions: number;
  created_at: string;
  updated_at: string;
}

/**
 * Row returned from vec0 KNN search.
 */
interface VecSearchRow {
  rowid: number;
  distance: number;
}

/**
 * Internal state for a single database connection.
 */
interface DatabaseState {
  db: DatabaseType;
  vecEnabled: boolean;
  dimensions: number | null;
  stmtCache: Map<string, StatementType>;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Convert a number array to a Float32Array Buffer for efficient BLOB storage.
 *
 * @param embedding - The embedding vector
 * @returns Buffer containing the Float32Array binary data
 */
export function embeddingToBlob(embedding: number[]): Buffer {
  const f32 = new Float32Array(embedding);
  return Buffer.from(f32.buffer);
}

/**
 * Convert a BLOB Buffer back to a number array.
 *
 * @param blob - Buffer containing Float32Array binary data
 * @returns The embedding as a number array
 */
export function blobToEmbedding(blob: Buffer): number[] {
  const f32 = new Float32Array(
    blob.buffer,
    blob.byteOffset,
    blob.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
  return Array.from(f32);
}

/**
 * Compute cosine similarity between two vectors.
 *
 * @param a - First vector
 * @param b - Second vector
 * @returns Cosine similarity in range [-1, 1], or 0 if vectors are incompatible
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Validate an embedding vector for storage. Rejects empty arrays, values
 * that are not finite numbers (NaN, Infinity), and dimensions exceeding
 * the maximum.
 *
 * @param embedding - The embedding to validate
 * @throws Error if the embedding is invalid
 */
export function validateEmbedding(embedding: number[]): void {
  if (!embedding || embedding.length === 0) {
    throw new Error('embedding must be a non-empty array');
  }
  if (embedding.length > VECTOR_STORE_CONSTANTS.MAX_DIMENSIONS) {
    throw new Error(
      `embedding dimensions (${embedding.length}) exceed maximum (${VECTOR_STORE_CONSTANTS.MAX_DIMENSIONS})`,
    );
  }
  for (let i = 0; i < embedding.length; i++) {
    if (typeof embedding[i] !== 'number' || !isFinite(embedding[i])) {
      throw new Error(
        `embedding contains invalid value at index ${i}: ${embedding[i]}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * VectorStoreService provides local SQLite-based vector storage with optional
 * native KNN search via the sqlite-vec extension.
 *
 * When sqlite-vec is available, search uses a `vec0` virtual table with cosine
 * distance metric for hardware-accelerated nearest-neighbor queries. When it is
 * not available, search falls back to JavaScript cosine similarity (fully
 * portable, no native extension required).
 *
 * Each scope (global / project) gets its own database file so project data
 * stays isolated and portable.
 *
 * @example
 * ```typescript
 * const store = VectorStoreService.getInstance();
 * store.upsert('doc-123', embedding, { title: 'My Doc' }, 'global');
 * const results = store.search(queryEmbedding, 'global');
 * console.log(store.isVecEnabled('global')); // true if sqlite-vec loaded
 * ```
 */
export class VectorStoreService {
  private static instance: VectorStoreService | null = null;
  private readonly logger: ComponentLogger;
  /** Cache of open database connections by resolved db path */
  private readonly databases: Map<string, DatabaseState> = new Map();

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('VectorStoreService');
  }

  /**
   * Get the singleton instance.
   *
   * @returns VectorStoreService instance
   */
  static getInstance(): VectorStoreService {
    if (!VectorStoreService.instance) {
      VectorStoreService.instance = new VectorStoreService();
    }
    return VectorStoreService.instance;
  }

  /**
   * Reset the singleton and close all open databases (for testing).
   */
  static resetInstance(): void {
    if (VectorStoreService.instance) {
      VectorStoreService.instance.closeAll();
    }
    VectorStoreService.instance = null;
  }

  // ---------------------------------------------------------------------------
  // Path helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve the database file path for a given scope.
   *
   * @param scope - 'global' or 'project'
   * @param projectPath - Required when scope is 'project'
   * @returns Absolute path to the SQLite database file
   * @throws Error if projectPath is missing for project scope
   */
  private dbPath(scope: 'global' | 'project', projectPath?: string): string {
    if (scope === 'project') {
      if (!projectPath) {
        throw new Error('projectPath is required for project scope');
      }
      return path.join(projectPath, CREWLY_CONSTANTS.PATHS.CREWLY_HOME, VECTOR_STORE_CONSTANTS.DB_FILENAME);
    }
    const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
    return path.join(home, CREWLY_CONSTANTS.PATHS.CREWLY_HOME, VECTOR_STORE_CONSTANTS.DB_FILENAME);
  }

  // ---------------------------------------------------------------------------
  // Database management
  // ---------------------------------------------------------------------------

  /**
   * Check whether the sqlite-vec native KNN search is available for a scope.
   *
   * @param scope - Storage scope
   * @param projectPath - Required when scope is 'project'
   * @returns true if vec0 virtual table is active
   */
  isVecEnabled(scope: 'global' | 'project', projectPath?: string): boolean {
    const state = this.getDbState(scope, projectPath);
    return state.vecEnabled;
  }

  /**
   * Get (or prepare + cache) a statement for the given database state.
   *
   * @param state - Database state to prepare on
   * @param key - Unique cache key
   * @param sql - SQL to prepare if not yet cached
   * @returns A prepared Statement
   */
  private getStmt(state: DatabaseState, key: string, sql: string): StatementType {
    let stmt = state.stmtCache.get(key);
    if (!stmt) {
      stmt = state.db.prepare(sql);
      state.stmtCache.set(key, stmt);
    }
    return stmt;
  }

  /**
   * Open or retrieve a cached database connection. Creates the parent
   * directory, schema, and vec0 table (if sqlite-vec is available) on first
   * access. Handles automatic migration from v1 databases.
   *
   * @param scope - Document scope
   * @param projectPath - Project path for project-scoped databases
   * @returns Internal DatabaseState
   */
  private getDbState(scope: 'global' | 'project', projectPath?: string): DatabaseState {
    const dbFile = this.dbPath(scope, projectPath);
    const cached = this.databases.get(dbFile);
    if (cached) return cached;

    // Ensure parent directory exists
    const dir = path.dirname(dbFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const Database = getBetterSqlite3();
    const db = new Database(dbFile);

    // Performance pragmas
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    // Try loading sqlite-vec extension
    let vecEnabled = false;
    const sqliteVec = getSqliteVec();
    if (sqliteVec) {
      try {
        sqliteVec.load(db);
        vecEnabled = true;
        this.logger.info('sqlite-vec extension loaded', { path: dbFile });
      } catch (err) {
        this.logger.warn('sqlite-vec extension failed to load, using JS fallback', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Run schema migration
    this.migrateSchema(db, vecEnabled);

    const state: DatabaseState = {
      db,
      vecEnabled,
      dimensions: this.getStoredDimensions(db),
      stmtCache: new Map(),
    };

    this.databases.set(dbFile, state);
    this.logger.info('Opened vector store database', { path: dbFile, scope, vecEnabled });
    return state;
  }

  /**
   * Migrate database schema to v2.
   * - Creates vec_config table for tracking schema version and dimensions
   * - Adds dimensions column if missing
   * - Converts JSON TEXT embeddings to BLOB if needed
   * - Creates vec0 virtual table if sqlite-vec is available and dimensions are known
   *
   * @param db - The database to migrate
   * @param vecEnabled - Whether sqlite-vec extension is loaded
   */
  private migrateSchema(db: DatabaseType, vecEnabled: boolean): void {
    // Config table for schema metadata
    db.exec(`
      CREATE TABLE IF NOT EXISTS vec_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const versionRow = db.prepare(
      'SELECT value FROM vec_config WHERE key = ?',
    ).get('schema_version') as { value: string } | undefined;
    const currentVersion = versionRow ? parseInt(versionRow.value, 10) : 0;

    if (currentVersion < VECTOR_STORE_CONSTANTS.SCHEMA_VERSION) {
      const tableExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'",
      ).get();

      if (tableExists) {
        // Check column types to detect v1 vs v2
        const colInfo = db.prepare('PRAGMA table_info(embeddings)').all() as Array<{
          name: string;
          type: string;
        }>;
        const embeddingCol = colInfo.find((c) => c.name === 'embedding');
        const hasDimensionsCol = colInfo.some((c) => c.name === 'dimensions');

        if (embeddingCol && embeddingCol.type === 'TEXT') {
          // v1 → v2: convert JSON TEXT embeddings to BLOB
          this.logger.info('Migrating vector store from v1 (JSON) to v2 (BLOB)');

          if (!hasDimensionsCol) {
            db.exec('ALTER TABLE embeddings ADD COLUMN dimensions INTEGER NOT NULL DEFAULT 0');
          }

          const rows = db.prepare(
            "SELECT id, embedding FROM embeddings WHERE typeof(embedding) = 'text'",
          ).all() as Array<{ id: string; embedding: string }>;
          const updateStmt = db.prepare(
            'UPDATE embeddings SET embedding = ?, dimensions = ? WHERE id = ?',
          );

          const migrate = db.transaction(() => {
            for (const row of rows) {
              try {
                const arr = JSON.parse(row.embedding) as number[];
                updateStmt.run(embeddingToBlob(arr), arr.length, row.id);
              } catch (err) {
                this.logger.warn('Failed to migrate embedding', {
                  id: row.id,
                  error: String(err),
                });
              }
            }
          });
          migrate();
        } else if (!hasDimensionsCol) {
          db.exec('ALTER TABLE embeddings ADD COLUMN dimensions INTEGER NOT NULL DEFAULT 0');
        }
      } else {
        // Fresh database — create v2 schema directly
        db.exec(`
          CREATE TABLE embeddings (
            id TEXT PRIMARY KEY,
            embedding BLOB NOT NULL,
            metadata TEXT NOT NULL DEFAULT '{}',
            dimensions INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_embeddings_updated_at ON embeddings(updated_at);
        `);
      }

      db.prepare(
        'INSERT OR REPLACE INTO vec_config (key, value) VALUES (?, ?)',
      ).run('schema_version', String(VECTOR_STORE_CONSTANTS.SCHEMA_VERSION));
    }

    // Create vec0 virtual table if sqlite-vec is available and dimensions are known
    if (vecEnabled) {
      this.ensureVecTable(db);
    }
  }

  /**
   * Create the vec0 virtual table if it doesn't already exist and dimensions
   * are known. Returns true if the table is ready for use.
   *
   * @param db - The database
   * @param dimensions - Explicit dimensions; if omitted, reads from vec_config
   * @returns true if vec0 table exists and is ready
   */
  private ensureVecTable(db: DatabaseType, dimensions?: number): boolean {
    const dim = dimensions || this.getStoredDimensions(db);
    if (!dim || dim <= 0) return false;

    const vecTableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_embeddings'",
    ).get();

    if (!vecTableExists) {
      try {
        db.exec(
          `CREATE VIRTUAL TABLE vec_embeddings USING vec0(embedding float[${dim}] distance_metric=cosine)`,
        );
        db.prepare(
          'INSERT OR REPLACE INTO vec_config (key, value) VALUES (?, ?)',
        ).run('vec_dimensions', String(dim));
        this.logger.info('Created vec0 virtual table', { dimensions: dim });

        // Backfill existing embeddings into vec0
        this.backfillVecTable(db, dim);
        return true;
      } catch (err) {
        this.logger.warn('Failed to create vec0 table', {
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    }
    return true;
  }

  /**
   * Copy all existing embeddings matching the target dimensions into the vec0
   * virtual table.
   *
   * @param db - The database
   * @param dimensions - Target embedding dimensions
   */
  private backfillVecTable(db: DatabaseType, dimensions: number): void {
    const rows = db.prepare(
      'SELECT rowid, embedding, dimensions FROM embeddings WHERE dimensions = ?',
    ).all(dimensions) as Array<{ rowid: number; embedding: Buffer; dimensions: number }>;

    if (rows.length === 0) return;

    const insertVec = db.prepare(
      'INSERT OR REPLACE INTO vec_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), ?)',
    );
    const backfill = db.transaction(() => {
      for (const row of rows) {
        try {
          insertVec.run(row.rowid, row.embedding);
        } catch (err) {
          this.logger.warn('Failed to backfill vec embedding', {
            rowid: row.rowid,
            error: String(err),
          });
        }
      }
    });
    backfill();
    this.logger.info('Backfilled vec0 table', { count: rows.length });
  }

  /**
   * Read the stored embedding dimensions from the vec_config table.
   *
   * @param db - The database
   * @returns Stored dimensions, or null if not yet determined
   */
  private getStoredDimensions(db: DatabaseType): number | null {
    try {
      const row = db.prepare(
        'SELECT value FROM vec_config WHERE key = ?',
      ).get('vec_dimensions') as { value: string } | undefined;
      return row ? parseInt(row.value, 10) : null;
    } catch {
      return null;
    }
  }

  /**
   * Close all open database connections and clear caches.
   */
  closeAll(): void {
    for (const [filePath, state] of this.databases) {
      try {
        state.stmtCache.clear();
        state.db.close();
        this.logger.debug('Closed vector store database', { path: filePath });
      } catch (error) {
        this.logger.warn('Error closing database', {
          path: filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.databases.clear();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Store or update an embedding for a document.
   *
   * @param id - Document identifier
   * @param embedding - The embedding vector (array of numbers)
   * @param metadata - Optional metadata to associate with the embedding
   * @param scope - Storage scope ('global' or 'project')
   * @param projectPath - Required when scope is 'project'
   * @throws Error if id is empty, embedding is invalid, metadata exceeds size,
   *         or dimensions don't match previously stored embeddings
   */
  upsert(
    id: string,
    embedding: number[],
    metadata: Record<string, unknown>,
    scope: 'global' | 'project',
    projectPath?: string,
  ): void {
    if (!id) {
      throw new Error('id is required');
    }
    validateEmbedding(embedding);

    const metadataJson = JSON.stringify(metadata);
    if (metadataJson.length > VECTOR_STORE_CONSTANTS.MAX_METADATA_SIZE) {
      throw new Error(
        `metadata exceeds maximum size of ${VECTOR_STORE_CONSTANTS.MAX_METADATA_SIZE} bytes`,
      );
    }

    const state = this.getDbState(scope, projectPath);

    // Dimension consistency: all vectors in a scope must share the same width
    if (state.dimensions && state.dimensions !== embedding.length) {
      throw new Error(
        `Dimension mismatch: expected ${state.dimensions}, got ${embedding.length}. ` +
          'All embeddings in a scope must have the same dimensions.',
      );
    }

    const now = new Date().toISOString();
    const blob = embeddingToBlob(embedding);

    const upsertStmt = this.getStmt(
      state,
      'upsert',
      `INSERT INTO embeddings (id, embedding, metadata, dimensions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         embedding = excluded.embedding,
         metadata = excluded.metadata,
         dimensions = excluded.dimensions,
         updated_at = excluded.updated_at`,
    );
    upsertStmt.run(id, blob, metadataJson, embedding.length, now, now);

    // Track dimensions on first insert
    if (!state.dimensions) {
      state.dimensions = embedding.length;
      state.db.prepare(
        'INSERT OR REPLACE INTO vec_config (key, value) VALUES (?, ?)',
      ).run('vec_dimensions', String(embedding.length));

      // Now we know dimensions — create vec0 table if available
      if (state.vecEnabled) {
        this.ensureVecTable(state.db, embedding.length);
      }
    }

    // Sync to vec0 table
    if (state.vecEnabled && state.dimensions === embedding.length) {
      this.syncToVec(state, id, blob);
    }

    this.logger.debug('Upserted embedding', {
      id,
      scope,
      dimensions: embedding.length,
      vecEnabled: state.vecEnabled,
    });
  }

  /**
   * Sync a single embedding to the vec0 virtual table.
   * Uses CAST(? AS INTEGER) for rowid because sqlite-vec's vec0 virtual
   * table does not accept JS number params directly for primary keys.
   *
   * @param state - Database state
   * @param id - Document identifier
   * @param blob - Embedding as a Float32Array buffer
   */
  private syncToVec(state: DatabaseState, id: string, blob: Buffer): void {
    try {
      const rowObj = state.db.prepare(
        'SELECT rowid FROM embeddings WHERE id = ?',
      ).get(id) as { rowid: number } | undefined;
      if (rowObj) {
        state.db.prepare(
          'DELETE FROM vec_embeddings WHERE rowid = CAST(? AS INTEGER)',
        ).run(rowObj.rowid);
        state.db.prepare(
          'INSERT INTO vec_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), ?)',
        ).run(rowObj.rowid, blob);
      }
    } catch (err) {
      this.logger.warn('Failed to sync embedding to vec0', {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Batch upsert multiple embeddings in a single transaction. Significantly
   * faster than individual upserts for bulk imports.
   *
   * @param items - Array of { id, embedding, metadata } objects
   * @param scope - Storage scope
   * @param projectPath - Required when scope is 'project'
   * @returns Count of succeeded and failed inserts
   * @throws Error if batch size exceeds MAX_BATCH_SIZE
   */
  batchUpsert(
    items: Array<{ id: string; embedding: number[]; metadata: Record<string, unknown> }>,
    scope: 'global' | 'project',
    projectPath?: string,
  ): { succeeded: number; failed: number } {
    if (items.length > VECTOR_STORE_CONSTANTS.MAX_BATCH_SIZE) {
      throw new Error(
        `Batch size ${items.length} exceeds maximum ${VECTOR_STORE_CONSTANTS.MAX_BATCH_SIZE}`,
      );
    }

    let succeeded = 0;
    let failed = 0;

    const state = this.getDbState(scope, projectPath);
    const txn = state.db.transaction(() => {
      for (const item of items) {
        try {
          this.upsert(item.id, item.embedding, item.metadata, scope, projectPath);
          succeeded++;
        } catch (err) {
          this.logger.warn('Batch upsert item failed', {
            id: item.id,
            error: err instanceof Error ? err.message : String(err),
          });
          failed++;
        }
      }
    });
    txn();

    return { succeeded, failed };
  }

  /**
   * Retrieve a stored embedding by document ID.
   *
   * @param id - Document identifier
   * @param scope - Storage scope
   * @param projectPath - Required when scope is 'project'
   * @returns The vector record, or null if not found
   */
  get(id: string, scope: 'global' | 'project', projectPath?: string): VectorRecord | null {
    const state = this.getDbState(scope, projectPath);
    const stmt = this.getStmt(state, 'get', 'SELECT * FROM embeddings WHERE id = ?');
    const row = stmt.get(id) as EmbeddingRow | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      embedding: row.embedding instanceof Buffer
        ? blobToEmbedding(row.embedding)
        : JSON.parse(row.embedding as string) as number[],
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Delete an embedding by document ID.
   *
   * @param id - Document identifier
   * @param scope - Storage scope
   * @param projectPath - Required when scope is 'project'
   * @returns True if a record was deleted, false if not found
   */
  delete(id: string, scope: 'global' | 'project', projectPath?: string): boolean {
    const state = this.getDbState(scope, projectPath);

    // Remove from vec0 first if available
    if (state.vecEnabled) {
      try {
        const rowObj = state.db.prepare(
          'SELECT rowid FROM embeddings WHERE id = ?',
        ).get(id) as { rowid: number } | undefined;
        if (rowObj) {
          state.db.prepare(
            'DELETE FROM vec_embeddings WHERE rowid = CAST(? AS INTEGER)',
          ).run(rowObj.rowid);
        }
      } catch {
        // vec0 delete failure is non-fatal
      }
    }

    const stmt = this.getStmt(state, 'delete', 'DELETE FROM embeddings WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Check whether an embedding exists for a given document ID.
   *
   * @param id - Document identifier
   * @param scope - Storage scope
   * @param projectPath - Required when scope is 'project'
   * @returns True if the embedding exists
   */
  has(id: string, scope: 'global' | 'project', projectPath?: string): boolean {
    const state = this.getDbState(scope, projectPath);
    const stmt = this.getStmt(state, 'has', 'SELECT 1 FROM embeddings WHERE id = ?');
    return stmt.get(id) !== undefined;
  }

  /**
   * Return the total number of stored embeddings.
   *
   * @param scope - Storage scope
   * @param projectPath - Required when scope is 'project'
   * @returns Count of stored embeddings
   */
  count(scope: 'global' | 'project', projectPath?: string): number {
    const state = this.getDbState(scope, projectPath);
    const stmt = this.getStmt(state, 'count', 'SELECT COUNT(*) as cnt FROM embeddings');
    return (stmt.get() as { cnt: number }).cnt;
  }

  /**
   * Search for the most similar embeddings. Uses native vec0 KNN search when
   * sqlite-vec is available, otherwise falls back to JavaScript cosine
   * similarity.
   *
   * @param queryEmbedding - The query embedding vector
   * @param scope - Storage scope
   * @param projectPath - Required when scope is 'project'
   * @param limit - Maximum number of results (default 10)
   * @param threshold - Minimum similarity threshold (default 0.1)
   * @returns Matching records sorted by descending similarity
   */
  search(
    queryEmbedding: number[],
    scope: 'global' | 'project',
    projectPath?: string,
    limit: number = VECTOR_STORE_CONSTANTS.DEFAULT_SEARCH_LIMIT,
    threshold: number = VECTOR_STORE_CONSTANTS.DEFAULT_SIMILARITY_THRESHOLD,
  ): VectorSearchResult[] {
    if (!queryEmbedding || queryEmbedding.length === 0) {
      return [];
    }

    const state = this.getDbState(scope, projectPath);

    // Try native vec0 KNN search
    if (state.vecEnabled && state.dimensions === queryEmbedding.length) {
      try {
        return this.vecSearch(state, queryEmbedding, limit, threshold);
      } catch (err) {
        this.logger.warn('vec0 search failed, falling back to JS', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Fallback: JavaScript cosine similarity
    return this.jsFallbackSearch(state, queryEmbedding, limit, threshold);
  }

  /**
   * Native KNN search using sqlite-vec's vec0 virtual table with cosine
   * distance metric. Results are converted from cosine distance (0 = identical,
   * 1 = orthogonal) to cosine similarity (1 = identical, 0 = orthogonal).
   *
   * @param state - Database state
   * @param queryEmbedding - The query vector
   * @param limit - Max results
   * @param threshold - Minimum cosine similarity
   * @returns Sorted search results
   */
  private vecSearch(
    state: DatabaseState,
    queryEmbedding: number[],
    limit: number,
    threshold: number,
  ): VectorSearchResult[] {
    const queryBlob = embeddingToBlob(queryEmbedding);

    // Fetch candidates from vec0 (request extra to account for threshold filtering)
    const vecRows = state.db.prepare(
      `SELECT rowid, distance
       FROM vec_embeddings
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?`,
    ).all(queryBlob, limit * 2) as VecSearchRow[];

    if (vecRows.length === 0) return [];

    // Fetch metadata for matched rowids
    const rowids = vecRows.map((r) => r.rowid);
    const placeholders = rowids.map(() => '?').join(',');
    const metaRows = state.db.prepare(
      `SELECT rowid, id, metadata FROM embeddings WHERE rowid IN (${placeholders})`,
    ).all(...rowids) as Array<{ rowid: number; id: string; metadata: string }>;

    const metaMap = new Map(metaRows.map((r) => [r.rowid, r]));

    // Convert cosine distance to cosine similarity: sim = 1 - distance
    const results: VectorSearchResult[] = [];
    for (const vr of vecRows) {
      const meta = metaMap.get(vr.rowid);
      if (!meta) continue;

      const score = 1 - vr.distance;
      if (score >= threshold) {
        results.push({
          id: meta.id,
          score,
          metadata: JSON.parse(meta.metadata) as Record<string, unknown>,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * JavaScript fallback search using cosine similarity on BLOB embeddings.
   * Used when sqlite-vec is not available.
   *
   * @param state - Database state
   * @param queryEmbedding - The query vector
   * @param limit - Max results
   * @param threshold - Minimum cosine similarity
   * @returns Sorted search results
   */
  private jsFallbackSearch(
    state: DatabaseState,
    queryEmbedding: number[],
    limit: number,
    threshold: number,
  ): VectorSearchResult[] {
    const rows = state.db.prepare(
      'SELECT id, embedding, metadata FROM embeddings',
    ).all() as EmbeddingRow[];

    const results: VectorSearchResult[] = [];

    for (const row of rows) {
      const storedEmbedding = row.embedding instanceof Buffer
        ? blobToEmbedding(row.embedding)
        : JSON.parse(row.embedding as string) as number[];
      const score = cosineSimilarity(queryEmbedding, storedEmbedding);

      if (score >= threshold) {
        results.push({
          id: row.id,
          score,
          metadata: JSON.parse(row.metadata) as Record<string, unknown>,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * Delete all embeddings from the store. Also resets the stored dimension
   * constraint so that subsequent inserts may use a different embedding width.
   *
   * @param scope - Storage scope
   * @param projectPath - Required when scope is 'project'
   * @returns Number of records deleted
   */
  clear(scope: 'global' | 'project', projectPath?: string): number {
    const state = this.getDbState(scope, projectPath);

    // Drop vec0 table so it can be recreated with new dimensions
    if (state.vecEnabled) {
      try {
        state.db.exec('DROP TABLE IF EXISTS vec_embeddings');
      } catch {
        // Non-fatal
      }
    }

    const stmt = this.getStmt(state, 'clear', 'DELETE FROM embeddings');
    const result = stmt.run();

    // Reset dimension tracking — no data means no dimension constraint
    state.dimensions = null;
    try {
      state.db.prepare('DELETE FROM vec_config WHERE key = ?').run('vec_dimensions');
    } catch {
      // Non-fatal
    }

    return result.changes;
  }
}
