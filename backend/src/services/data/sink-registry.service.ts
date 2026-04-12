/**
 * Sink Registry Service
 *
 * Manages sink definitions loaded from a project's `_sinks.json` file.
 * Provides lookup, listing, tag-based matching, and registration of new sinks.
 * Works alongside SchemaRegistryService to form the Data Architecture V2
 * ingestion layer.
 *
 * @module services/data/sink-registry.service
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { atomicWriteFile } from '../../utils/file-io.utils.js';
import type { SinkDefinition } from '../../types/data-object.types.js';
import { DATA_CONSTANTS } from '../../types/data-object.types.js';

/**
 * Shape of the on-disk `_sinks.json` file.
 */
interface SinksRegistryFile {
  version: number;
  sinks: SinkDefinition[];
}

/**
 * Singleton service that manages data sink definitions.
 *
 * Sinks are loaded from `{projectPath}/sinks/_sinks.json`. Each sink declares
 * a name, schema reference, tags, and a directory for storage. The matchSink()
 * method enables content-aware routing of incoming data.
 */
export class SinkRegistryService {
  private static instance: SinkRegistryService | null = null;
  private readonly logger: ComponentLogger;
  private readonly sinks: Map<string, SinkDefinition> = new Map();

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('SinkRegistryService');
  }

  /**
   * Get the singleton instance.
   *
   * @returns SinkRegistryService singleton
   */
  static getInstance(): SinkRegistryService {
    if (!SinkRegistryService.instance) {
      SinkRegistryService.instance = new SinkRegistryService();
    }
    return SinkRegistryService.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  static resetInstance(): void {
    SinkRegistryService.instance = null;
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  /**
   * Load sink definitions from a project's `_sinks.json` file.
   *
   * If the file does not exist, the service starts with an empty registry
   * (no error thrown). Invalid entries (missing id) are skipped with a warning.
   *
   * @param projectPath - Absolute path to the Crewly project root
   */
  async loadSinks(projectPath: string): Promise<void> {
    const registryPath = this.registryPath(projectPath);

    if (!existsSync(registryPath)) {
      this.logger.warn('No _sinks.json found, starting with empty registry', { registryPath });
      return;
    }

    try {
      const raw = await fs.readFile(registryPath, 'utf-8');
      const registry: SinksRegistryFile = JSON.parse(raw);

      if (!Array.isArray(registry.sinks)) {
        this.logger.warn('_sinks.json missing "sinks" array', { registryPath });
        return;
      }

      for (const sink of registry.sinks) {
        if (!sink.id) {
          this.logger.warn('Skipping sink entry without id', { sink });
          continue;
        }
        this.sinks.set(sink.id, sink);
        this.logger.debug?.(`Loaded sink: ${sink.id}`, { name: sink.name });
      }
    } catch (err) {
      this.logger.warn('Failed to parse _sinks.json', {
        registryPath,
        error: (err as Error).message,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /**
   * Get a sink by its ID.
   *
   * @param sinkId - Unique sink identifier
   * @returns The sink definition, or null if not found
   */
  getSink(sinkId: string): SinkDefinition | null {
    return this.sinks.get(sinkId) ?? null;
  }

  /**
   * List all registered sinks.
   *
   * @returns Array of all SinkDefinitions
   */
  listSinks(): SinkDefinition[] {
    return Array.from(this.sinks.values());
  }

  // ---------------------------------------------------------------------------
  // Matching
  // ---------------------------------------------------------------------------

  /**
   * Match incoming data to the best sink based on tag overlap.
   *
   * Scores each sink by the number of matching tags (intersection with the
   * provided tags array). If `content` is provided and a sink name appears
   * in the content, that sink gets a bonus point. Returns the highest-scoring
   * sink, or null if no sink has any overlap.
   *
   * @param tags - Tags from the incoming data
   * @param content - Optional content string for keyword matching
   * @returns Best-matching SinkDefinition, or null
   */
  matchSink(tags: string[], content?: string): SinkDefinition | null {
    let bestSink: SinkDefinition | null = null;
    let bestScore = 0;

    const lowerContent = content?.toLowerCase();

    for (const sink of this.sinks.values()) {
      let score = 0;

      // Count tag overlap
      for (const tag of tags) {
        if (sink.tags.includes(tag)) {
          score += 1;
        }
      }

      // Bonus if the sink name appears in the content
      if (lowerContent && sink.name && lowerContent.includes(sink.name.toLowerCase())) {
        score += 1;
      }

      if (score > bestScore) {
        bestScore = score;
        bestSink = sink;
      }
    }

    return bestSink;
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Register a new sink definition and persist it to `_sinks.json`.
   *
   * Creates the sinks directory and registry file if they don't exist.
   * If a sink with the same ID already exists, it is overwritten.
   *
   * @param projectPath - Absolute path to the Crewly project root
   * @param sink - The sink definition to register
   */
  async registerSink(projectPath: string, sink: SinkDefinition): Promise<void> {
    this.sinks.set(sink.id, sink);

    // Ensure sinks directory exists
    const sinksDir = path.join(projectPath, DATA_CONSTANTS.SINKS_DIR);
    await fs.mkdir(sinksDir, { recursive: true });

    // Ensure the sink's data directory exists
    const sinkDataDir = path.join(sinksDir, sink.directory);
    await fs.mkdir(sinkDataDir, { recursive: true });

    // Persist the full registry
    const registryPath = this.registryPath(projectPath);
    const registryData: SinksRegistryFile = {
      version: 1,
      sinks: Array.from(this.sinks.values()),
    };

    await atomicWriteFile(registryPath, JSON.stringify(registryData, null, 2));
    this.logger.debug?.(`Registered sink: ${sink.id}`, { name: sink.name });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Compute the absolute path to the _sinks.json registry file.
   *
   * @param projectPath - Project root
   * @returns Absolute path to _sinks.json
   */
  private registryPath(projectPath: string): string {
    return path.join(projectPath, DATA_CONSTANTS.SINKS_DIR, DATA_CONSTANTS.SINKS_REGISTRY_FILE);
  }
}
