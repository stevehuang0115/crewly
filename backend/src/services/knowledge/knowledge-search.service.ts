/**
 * Knowledge Search Service
 *
 * Provides pluggable search strategies for knowledge documents.
 * Uses keyword matching by default (zero dependencies), with optional
 * Gemini embedding-based semantic search when GEMINI_API_KEY is set.
 *
 * @module services/knowledge/knowledge-search.service
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { KnowledgeService } from './knowledge.service.js';
import { VectorStoreService } from './vector-store.service.js';
import { Fts5IndexService, type FtsSearchResult } from './fts5-index.service.js';
import * as path from 'path';
import * as os from 'os';
import type {
  KnowledgeDocumentSummary,
  KnowledgeScope,
} from '../../types/knowledge.types.js';
import { EMBEDDING_CONSTANTS, ENV_CONSTANTS, CREWLY_CONSTANTS } from '../../constants.js';

/** Default number of results returned by search */
const DEFAULT_SEARCH_LIMIT = 5;

/** Half-life in days for temporal decay — score halves every 30 days (#154) */
const TEMPORAL_DECAY_HALF_LIFE_DAYS = 30;

/** Tags that bypass temporal decay (always full relevance) (#154) */
const EVERGREEN_TAGS = new Set(['evergreen', 'decision', 'architecture', 'sop', 'runbook']);

/**
 * Apply temporal decay to a search score (#154).
 * Score decays by half every TEMPORAL_DECAY_HALF_LIFE_DAYS days.
 * Documents tagged with evergreen/decision tags bypass decay entirely.
 *
 * @param score - Raw relevance score
 * @param createdAt - ISO timestamp of document creation
 * @param tags - Document tags
 * @returns Decayed score
 */
export function applyTemporalDecay(score: number, createdAt: string, tags: string[]): number {
  // Bypass decay for evergreen documents
  const lowerTags = tags.map(t => t.toLowerCase());
  if (lowerTags.some(tag => EVERGREEN_TAGS.has(tag))) {
    return score;
  }

  const daysSinceCreation = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceCreation <= 0) {
    return score;
  }

  return score * Math.pow(0.5, daysSinceCreation / TEMPORAL_DECAY_HALF_LIFE_DAYS);
}

/**
 * A document scored by a search strategy.
 */
export interface ScoredDocument {
  /** The matched document summary */
  document: KnowledgeDocumentSummary;
  /** Relevance score (higher is more relevant) */
  score: number;
}

/**
 * Search options passed to strategies.
 */
export interface SearchOptions {
  scope?: KnowledgeScope;
  projectPath?: string;
  category?: string;
  limit?: number;
}

/**
 * Strategy interface for scoring documents against a query.
 */
export interface KnowledgeSearchStrategy {
  /**
   * Score documents against a query. Returns documents sorted by relevance.
   *
   * @param query - The search query
   * @param documents - Candidate documents to score (may be ignored by some strategies)
   * @param options - Optional scope and filtering parameters
   * @returns Documents sorted by descending score
   */
  search(
    query: string,
    documents: KnowledgeDocumentSummary[],
    options?: SearchOptions
  ): Promise<ScoredDocument[]>;
}

/**
 * Keyword-based search strategy (default fallback, zero dependencies).
 *
 * Splits the query into words and scores documents by matching against
 * title (3x weight), tags (2x weight), and preview (1x weight).
 */
export class KeywordSearchStrategy implements KnowledgeSearchStrategy {
  /**
   * Score documents using keyword matching.
   *
   * @param query - Search query text
   * @param documents - Documents to score
   * @param options - Optional search parameters (ignored)
   * @returns Scored documents sorted by relevance
   */
  async search(
    query: string,
    documents: KnowledgeDocumentSummary[],
    options?: SearchOptions
  ): Promise<ScoredDocument[]> {
    const queryWords = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1);

    if (queryWords.length === 0) {
      return [];
    }

    const scored: ScoredDocument[] = [];

    for (const doc of documents) {
      const titleLower = doc.title.toLowerCase();
      const previewLower = doc.preview.toLowerCase();
      const tagsLower = doc.tags.map((t) => t.toLowerCase());

      let score = 0;

      for (const word of queryWords) {
        if (titleLower.includes(word)) {
          score += 3;
        }
        if (tagsLower.some((tag) => tag.includes(word))) {
          score += 2;
        }
        if (previewLower.includes(word)) {
          score += 1;
        }
      }

      if (score > 0) {
        scored.push({ document: doc, score });
      }
    }

    return scored.sort((a, b) => b.score - a.score);
  }
}

/**
 * SQLite FTS5-based search strategy (V2 Default).
 *
 * Utilizes the FTS5 virtual table for lightning-fast full-text search
 * with native BM25 ranking. Bypasses the memory-intensive candidate
 * listing for large knowledge bases.
 */
export class Fts5SearchStrategy implements KnowledgeSearchStrategy {
  private readonly logger: ComponentLogger;
  private readonly fallback: KeywordSearchStrategy;
  private readonly globalFts5: Fts5IndexService;
  private readonly projectFts5Cache = new Map<string, Fts5IndexService>();

  constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('Fts5SearchStrategy');
    this.fallback = new KeywordSearchStrategy();

    const globalPath = path.join(os.homedir(), CREWLY_CONSTANTS.PATHS.CREWLY_HOME, 'knowledge');
    this.globalFts5 = new Fts5IndexService(globalPath);
  }

  private getProjectFts5(projectPath: string): Fts5IndexService {
    if (!this.projectFts5Cache.has(projectPath)) {
      const p = path.join(projectPath, CREWLY_CONSTANTS.PATHS.CREWLY_HOME, 'knowledge');
      this.projectFts5Cache.set(projectPath, new Fts5IndexService(p));
    }
    return this.projectFts5Cache.get(projectPath)!;
  }

  async search(
    query: string,
    documents: KnowledgeDocumentSummary[],
    options?: SearchOptions
  ): Promise<ScoredDocument[]> {
    const scope = options?.scope || 'global';
    const fts5 = scope === 'project' && options?.projectPath
      ? this.getProjectFts5(options.projectPath)
      : this.globalFts5;

    try {
      const results = fts5.search(query, {
        category: options?.category,
        limit: options?.limit,
      });

      if (results.length === 0) {
        // Fallback to keyword search on the provided documents if FTS5 returns nothing
        // This ensures we catch documents that might not be indexed yet.
        return this.fallback.search(query, documents);
      }

      // Join FTS5 hits against the candidate list (from listDocuments) so
      // we carry real createdAt/updatedAt/createdBy through. Without this,
      // every FTS5 result looks brand-new and bypasses temporal decay
      // (#154) entirely — the decay runs on createdAt, so defaulting to
      // Date.now() means every doc is treated as freshly-authored.
      const now = new Date().toISOString();
      const candidatesById = new Map(documents.map((d) => [d.id, d]));

      return results.map((r: FtsSearchResult) => {
        const candidate = candidatesById.get(r.id);
        return {
          document: {
            id: r.id,
            title: r.title,
            category: r.category,
            tags: r.tags.split(',').map((t) => t.trim()).filter(Boolean),
            preview: r.content.slice(0, 200),
            scope,
            // Prefer the authoritative metadata from listDocuments; fall
            // back to "now" only if the candidate list didn't include it
            // (e.g., an indexed doc that was removed from listDocuments
            // mid-flight). Docs missing from candidates simply bypass
            // temporal decay, same as evergreen entries.
            createdAt: candidate?.createdAt ?? now,
            updatedAt: candidate?.updatedAt ?? now,
            createdBy: candidate?.createdBy ?? 'system',
            updatedBy: candidate?.updatedBy ?? 'system',
          },
          // SQLite FTS5's bm25() returns a negative double where
          // more-negative = more-relevant (e.g. -5 beats -1). Invert so
          // higher = better to match the ScoredDocument convention used
          // by every other strategy. Clamped at 0 in case the driver ever
          // returns an unexpected positive rank.
          score: Math.max(0, 100 - r.rank),
        };
      });
    } catch (error) {
      this.logger.warn('FTS5 search failed, falling back to keyword search', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.fallback.search(query, documents);
    }
  }
}

/**
 * Cosine similarity between two vectors.
 *
 * @param a - First vector
 * @param b - Second vector
 * @returns Cosine similarity in range [-1, 1]
 */
function cosineSimilarity(a: number[], b: number[]): number {
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
 * Gemini embedding-based semantic search strategy.
 *
 * @deprecated Use Fts5SearchStrategy for technical knowledge. 
 * Semantic search is now primarily for Agent Memory via MemoryService.
 *
 * Calls the Gemini Embedding API to embed query text, then computes
 * cosine similarity against document embeddings. Falls back to
 * KeywordSearchStrategy if the API call fails.
 */
export class GeminiEmbeddingStrategy implements KnowledgeSearchStrategy {
  private readonly apiKey: string;
  private readonly fallback: KeywordSearchStrategy;
  private readonly logger: ComponentLogger;

  /**
   * Creates a GeminiEmbeddingStrategy instance.
   *
   * @param apiKey - Gemini API key for embedding requests
   */
  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.fallback = new KeywordSearchStrategy();
    this.logger = LoggerService.getInstance().createComponentLogger('GeminiEmbeddingStrategy');
  }

  /**
   * Embed a single text string via the Gemini API.
   *
   * @param text - Text to embed
   * @returns Embedding vector, or null on failure
   */
  private async embed(text: string): Promise<number[] | null> {
    try {
      const url = `${EMBEDDING_CONSTANTS.GEMINI_ENDPOINT}/${EMBEDDING_CONSTANTS.GEMINI_MODEL}:embedContent?key=${this.apiKey}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), EMBEDDING_CONSTANTS.TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: `models/${EMBEDDING_CONSTANTS.GEMINI_MODEL}`,
            content: { parts: [{ text }] },
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          let responseBody = '';
          try { responseBody = (await response.text()).slice(0, 200); } catch { /* ignore */ }
          this.logger.warn('Gemini embedding API returned non-OK status', {
            status: response.status,
            statusText: response.statusText,
            model: EMBEDDING_CONSTANTS.GEMINI_MODEL,
            textLength: text.length,
            responseBody,
          });
          return null;
        }

        const data = (await response.json()) as { embedding?: { values?: number[] } };
        return data.embedding?.values ?? null;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      this.logger.warn('Gemini embedding API call failed', {
        error: error instanceof Error ? error.message : String(error),
        model: EMBEDDING_CONSTANTS.GEMINI_MODEL,
        textLength: text.length,
        isTimeout: error instanceof Error && error.name === 'AbortError',
      });
      return null;
    }
  }

  /**
   * Score documents using Gemini embeddings and cosine similarity.
   * Falls back to keyword search if embedding fails.
   *
   * @param query - Search query text
   * @param documents - Documents to score
   * @param options - Optional search parameters
   * @returns Scored documents sorted by relevance
   */
  async search(
    query: string,
    documents: KnowledgeDocumentSummary[],
    options?: SearchOptions
  ): Promise<ScoredDocument[]> {
    const queryEmbedding = await this.embed(query);

    if (!queryEmbedding) {
      this.logger.debug('Falling back to keyword search due to embedding failure');
      return this.fallback.search(query, documents);
    }

    const scored: ScoredDocument[] = [];

    for (const doc of documents) {
      const docText = `${doc.title} ${doc.tags.join(' ')} ${doc.preview}`;
      const docEmbedding = await this.embed(docText);

      if (!docEmbedding) {
        continue;
      }

      const score = cosineSimilarity(queryEmbedding, docEmbedding);
      if (score > 0) {
        scored.push({ document: doc, score });
      }
    }

    if (scored.length === 0) {
      this.logger.debug('No embedding results, falling back to keyword search');
      return this.fallback.search(query, documents);
    }

    return scored.sort((a, b) => b.score - a.score);
  }
}

/**
 * Local vector search strategy using SQLite-backed VectorStoreService.
 *
 * @deprecated Use Fts5SearchStrategy for primary knowledge retrieval.
 *
 * Stores embeddings locally on-device so that recall works offline.
 * Uses the Gemini API to generate embeddings (when available) and
 * persists them in the local vector store. Subsequent searches skip
 * the embedding API for documents that already have stored vectors.
 * Falls back to keyword search when no API key is configured or
 * when embedding generation fails.
 */
export class LocalVectorSearchStrategy implements KnowledgeSearchStrategy {
  private readonly vectorStore: VectorStoreService;
  private readonly apiKey: string | undefined;
  private readonly fallback: KeywordSearchStrategy;
  private readonly logger: ComponentLogger;

  /**
   * Creates a LocalVectorSearchStrategy instance.
   *
   * @param apiKey - Optional Gemini API key for generating embeddings
   */
  constructor(apiKey?: string) {
    this.vectorStore = VectorStoreService.getInstance();
    this.apiKey = apiKey;
    this.fallback = new KeywordSearchStrategy();
    this.logger = LoggerService.getInstance().createComponentLogger('LocalVectorSearchStrategy');
  }

  /**
   * Embed a single text string via the Gemini API.
   *
   * @param text - Text to embed
   * @returns Embedding vector, or null on failure
   */
  private async embed(text: string): Promise<number[] | null> {
    if (!this.apiKey) {
      return null;
    }

    try {
      const url = `${EMBEDDING_CONSTANTS.GEMINI_ENDPOINT}/${EMBEDDING_CONSTANTS.GEMINI_MODEL}:embedContent?key=${this.apiKey}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), EMBEDDING_CONSTANTS.TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: `models/${EMBEDDING_CONSTANTS.GEMINI_MODEL}`,
            content: { parts: [{ text }] },
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          // #214: Add actionable hints for common error codes
          const hint = response.status === 404
            ? 'Model may be deprecated — verify Gemini embedding model availability'
            : response.status === 401 || response.status === 403
              ? 'Check GEMINI_API_KEY validity and permissions'
              : '';
          this.logger.warn('Gemini embedding API error, falling back to keyword search', {
            status: response.status, model: EMBEDDING_CONSTANTS.GEMINI_MODEL, hint,
          });
          return null;
        }

        const data = (await response.json()) as { embedding?: { values?: number[] } };
        return data.embedding?.values ?? null;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      this.logger.warn('Embedding API call failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Get or create an embedding for a document, persisting it locally.
   *
   * @param docId - Document identifier
   * @param docText - Text to embed (used only if no stored embedding)
   * @param scope - Storage scope
   * @param projectPath - Project path for project scope
   * @returns The embedding vector, or null if unavailable
   */
  private async getOrCreateEmbedding(
    docId: string,
    docText: string,
    scope: 'global' | 'project',
    projectPath?: string,
  ): Promise<number[] | null> {
    // Check local store first
    const existing = this.vectorStore.get(docId, scope, projectPath);
    if (existing) {
      return existing.embedding;
    }

    // Generate embedding via API
    const embedding = await this.embed(docText);
    if (embedding) {
      this.vectorStore.upsert(docId, embedding, { text: docText.slice(0, 200) }, scope, projectPath);
    }
    return embedding;
  }

  /**
   * Score documents using local vector search with cosine similarity.
   * Falls back to keyword search when embeddings are unavailable.
   *
   * @param query - Search query text
   * @param documents - Documents to score
   * @param options - Optional search parameters
   * @returns Scored documents sorted by relevance
   */
  async search(
    query: string,
    documents: KnowledgeDocumentSummary[],
    options?: SearchOptions
  ): Promise<ScoredDocument[]> {
    const effectiveScope = options?.scope || 'global';

    // Try to get query embedding
    const queryEmbedding = await this.embed(query);
    if (!queryEmbedding) {
      this.logger.debug('No embedding API available, falling back to keyword search');
      return this.fallback.search(query, documents);
    }

    const scored: ScoredDocument[] = [];

    for (const doc of documents) {
      const docText = `${doc.title} ${doc.tags.join(' ')} ${doc.preview}`;
      const docEmbedding = await this.getOrCreateEmbedding(
        doc.id,
        docText,
        effectiveScope,
        options?.projectPath,
      );

      if (!docEmbedding) {
        continue;
      }

      const score = cosineSimilarity(queryEmbedding, docEmbedding);
      if (score > 0) {
        scored.push({ document: doc, score });
      }
    }

    if (scored.length === 0) {
      this.logger.debug('No vector results, falling back to keyword search');
      return this.fallback.search(query, documents);
    }

    return scored.sort((a, b) => b.score - a.score);
  }
}

/**
 * BM25-inspired keyword scoring for hybrid search (#152).
 *
 * Computes a simplified BM25-like score for a document against a query.
 * Uses term frequency with diminishing returns (k1 saturation).
 *
 * @param query - Search query text
 * @param docText - Document text to score
 * @returns BM25-inspired score (higher is better)
 */
export function bm25Score(query: string, docText: string): number {
  const k1 = 1.2;
  const b = 0.75;
  const avgDocLen = 200;

  const queryTerms = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  const docLower = docText.toLowerCase();
  const docWords = docLower.split(/\s+/);
  const docLen = docWords.length;

  let score = 0;
  for (const term of queryTerms) {
    const tf = docWords.filter(w => w.includes(term)).length;
    if (tf === 0) continue;
    const idf = Math.log(1 + 1 / (tf + 0.5));
    const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / avgDocLen)));
    score += idf * tfNorm;
  }
  return score;
}

/**
 * Hybrid search strategy: vector similarity (70%) + BM25 keywords (30%) (#152).
 *
 * Combines semantic vector search with BM25 keyword matching for more
 * accurate retrieval. Proper nouns, technical terms, and IDs are caught
 * by BM25 while conceptual matches come from vector similarity.
 */
export class HybridSearchStrategy implements KnowledgeSearchStrategy {
  private readonly vectorStrategy: LocalVectorSearchStrategy;
  private readonly keywordStrategy: KeywordSearchStrategy;
  private readonly logger: ComponentLogger;
  private readonly vectorWeight: number;
  private readonly keywordWeight: number;

  constructor(apiKey?: string, vectorWeight = 0.7, keywordWeight = 0.3) {
    this.vectorStrategy = new LocalVectorSearchStrategy(apiKey);
    this.keywordStrategy = new KeywordSearchStrategy();
    this.vectorWeight = vectorWeight;
    this.keywordWeight = keywordWeight;
    this.logger = LoggerService.getInstance().createComponentLogger('HybridSearchStrategy');
  }

  async search(
    query: string,
    documents: KnowledgeDocumentSummary[],
    options?: SearchOptions
  ): Promise<ScoredDocument[]> {
    const vectorResults = await this.vectorStrategy.search(query, documents, options);
    const vectorMap = new Map(vectorResults.map(r => [r.document.id, r.score]));

    const keywordResults = await this.keywordStrategy.search(query, documents, options);
    const keywordMap = new Map(keywordResults.map(r => [r.document.id, r.score]));

    const maxVector = vectorResults.length > 0 ? Math.max(...vectorResults.map(r => r.score)) : 1;
    const maxKeyword = keywordResults.length > 0 ? Math.max(...keywordResults.map(r => r.score)) : 1;

    const allDocIds = new Set([...vectorMap.keys(), ...keywordMap.keys()]);
    const docById = new Map(documents.map(d => [d.id, d]));

    const combined: ScoredDocument[] = [];
    for (const docId of allDocIds) {
      const doc = docById.get(docId);
      if (!doc) continue;

      const vScore = (vectorMap.get(docId) || 0) / (maxVector || 1);
      const kScore = (keywordMap.get(docId) || 0) / (maxKeyword || 1);
      const docText = `${doc.title} ${doc.tags.join(' ')} ${doc.preview}`;
      const bm25 = bm25Score(query, docText);
      const normalizedBm25 = Math.min(bm25 / 5, 1);

      const combinedScore =
        this.vectorWeight * vScore +
        this.keywordWeight * Math.max(kScore, normalizedBm25);

      if (combinedScore > 0) {
        combined.push({ document: doc, score: combinedScore });
      }
    }

    return combined.sort((a, b) => b.score - a.score);
  }
}

/**
 * Knowledge Search Service singleton.
 *
 * Strategy selection priority:
 * 1. Fts5SearchStrategy (V2 Default — SQLite FTS5)
 * 2. HybridSearchStrategy (when embedding API key is set — vector 70% + BM25 30%) (#152)
 * 3. KeywordSearchStrategy (default, zero dependencies)
 */
export class KnowledgeSearchService {
  private static instance: KnowledgeSearchService | null = null;
  private readonly strategy: KnowledgeSearchStrategy;
  private readonly logger: ComponentLogger;

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('KnowledgeSearchService');

    // Default to FTS5 for Knowledge V2
    this.logger.info('Using FTS5 search strategy as default for Knowledge V2');
    this.strategy = new Fts5SearchStrategy();
  }

  /**
   * Get the singleton instance.
   *
   * @returns KnowledgeSearchService instance
   */
  static getInstance(): KnowledgeSearchService {
    if (!KnowledgeSearchService.instance) {
      KnowledgeSearchService.instance = new KnowledgeSearchService();
    }
    return KnowledgeSearchService.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  static resetInstance(): void {
    KnowledgeSearchService.instance = null;
  }

  /**
   * Search knowledge documents using the configured strategy.
   *
   * @param query - Search query text
   * @param scope - Document scope ('global' or 'project')
   * @param projectPath - Project path (required when scope is 'project')
   * @param category - Optional category filter
   * @param limit - Maximum number of results (default 5)
   * @returns Matching document summaries sorted by relevance
   */
  async search(
    query: string,
    scope: KnowledgeScope,
    projectPath?: string,
    category?: string,
    limit: number = DEFAULT_SEARCH_LIMIT,
  ): Promise<KnowledgeDocumentSummary[]> {
    this.logger.debug('Searching knowledge documents', { query, scope, category });

    const knowledgeService = KnowledgeService.getInstance();
    const candidates = await knowledgeService.listDocuments(scope, projectPath, { category });

    // FTS5 strategy uses its own DB but falls back to candidates if nothing found in DB
    const scored = await this.strategy.search(query, candidates, {
      scope,
      projectPath,
      category,
      limit,
    });

    // #154: Apply temporal decay to re-rank results
    const decayed = scored.map((s) => ({
      ...s,
      score: applyTemporalDecay(s.score, s.document.createdAt, s.document.tags),
    }));
    decayed.sort((a, b) => b.score - a.score);

    return decayed.slice(0, limit).map((s) => s.document);
  }
}
