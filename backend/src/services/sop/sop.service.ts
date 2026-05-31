/**
 * SOP Service
 *
 * Manages Standard Operating Procedures (SOPs) including loading,
 * indexing, matching, and creating custom SOPs.
 *
 * @module services/sop/sop.service
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import {
  SOP,
  SOPRole,
  SOPCategory,
  SOPIndex,
  SOPIndexEntry,
  SOPMatchParams,
  SOP_CONSTANTS,
  ParsedSOP,
  SOPFrontmatter,
} from '../../types/sop.types.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Interface for the SOP Service
 */
export interface ISOPService {
  /**
   * Initialize the service (create directories, build index)
   */
  initialize(): Promise<void>;

  /**
   * Rebuild the SOP index from filesystem
   */
  rebuildIndex(): Promise<void>;

  /**
   * Get an SOP by ID
   *
   * @param id - SOP identifier
   * @returns SOP or null if not found
   */
  getSOP(id: string): Promise<SOP | null>;

  /**
   * Get all SOPs for a specific role
   *
   * @param role - Role to filter by
   * @returns Array of SOPs
   */
  getSOPsByRole(role: SOPRole | 'all'): Promise<SOP[]>;

  /**
   * Get all SOPs in a category
   *
   * @param category - Category to filter by
   * @returns Array of SOPs
   */
  getSOPsByCategory(category: SOPCategory): Promise<SOP[]>;

  /**
   * Find SOPs relevant to the given context
   *
   * @param params - Match parameters
   * @returns Array of matching SOPs
   */
  findRelevantSOPs(params: SOPMatchParams): Promise<SOP[]>;

  /**
   * Generate SOP context string for prompts
   *
   * @param params - Match parameters
   * @returns Formatted SOP context string
   */
  generateSOPContext(params: SOPMatchParams): Promise<string>;

  /**
   * Create a custom SOP
   *
   * @param sop - SOP data (without id, timestamps, version)
   * @returns Created SOP ID
   */
  createCustomSOP(
    sop: Omit<SOP, 'id' | 'createdAt' | 'updatedAt' | 'version'>
  ): Promise<string>;

  /**
   * Update an existing SOP
   *
   * @param id - SOP identifier
   * @param updates - Partial SOP updates
   */
  updateSOP(id: string, updates: Partial<SOP>): Promise<void>;

  /**
   * Delete a custom SOP
   *
   * @param id - SOP identifier
   */
  deleteSOP(id: string): Promise<void>;

  /**
   * Get the current SOP index
   *
   * @returns SOP index
   */
  getIndex(): Promise<SOPIndex>;

  /**
   * Search SOPs by query string
   *
   * @param query - Search query
   * @returns Matching index entries
   */
  searchSOPs(query: string): Promise<SOPIndexEntry[]>;
}

/**
 * Service for managing Standard Operating Procedures
 *
 * @example
 * ```typescript
 * const service = SOPService.getInstance();
 * await service.initialize();
 *
 * const sops = await service.findRelevantSOPs({
 *   role: 'developer',
 *   taskContext: 'implementing a new API endpoint',
 * });
 * ```
 */
export class SOPService implements ISOPService {
  private static instance: SOPService | null = null;

  private readonly logger: ComponentLogger;
  private readonly basePath: string;
  private readonly systemPath: string;
  private readonly customPath: string;
  private readonly indexPath: string;

  private index: SOPIndex | null = null;
  private sopCache: Map<string, SOP> = new Map();
  private initialized: boolean = false;

  /**
   * Private constructor for singleton pattern
   *
   * @param basePath - Optional custom base path for SOPs
   */
  private constructor(basePath?: string) {
    this.logger = LoggerService.getInstance().createComponentLogger('SOPService');
    this.basePath = basePath || path.join(this.getCrewlyHome(), SOP_CONSTANTS.PATHS.SOP_DIR);
    this.systemPath = path.join(this.basePath, SOP_CONSTANTS.PATHS.SYSTEM_SOP_DIR);
    this.customPath = path.join(this.basePath, SOP_CONSTANTS.PATHS.CUSTOM_SOP_DIR);
    this.indexPath = path.join(this.basePath, SOP_CONSTANTS.PATHS.INDEX_FILE);
  }

  /**
   * Gets the singleton instance
   *
   * @returns The SOPService instance
   */
  public static getInstance(): SOPService {
    if (!SOPService.instance) {
      SOPService.instance = new SOPService();
    }
    return SOPService.instance;
  }

  /**
   * Clears the singleton instance (for testing)
   */
  public static clearInstance(): void {
    SOPService.instance = null;
  }

  /**
   * Create an instance with a custom base path (for testing)
   *
   * @param basePath - Custom base path
   * @returns SOPService instance
   */
  public static createWithPath(basePath: string): SOPService {
    return new SOPService(basePath);
  }

  /**
   * Get the Crewly home directory
   *
   * @returns Home directory path
   */
  private getCrewlyHome(): string {
    return process.env.CREWLY_HOME || path.join(process.env.HOME || '', '.crewly');
  }

  /**
   * Initialize the service
   */
  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Ensure directories exist
    await fs.mkdir(this.systemPath, { recursive: true });
    await fs.mkdir(this.customPath, { recursive: true });

    // Build index if not exists or outdated
    await this.ensureIndex();

    this.initialized = true;
    this.logger.info('SOPService initialized', { basePath: this.basePath });
  }

  /**
   * Rebuild the SOP index from filesystem
   */
  public async rebuildIndex(): Promise<void> {
    const entries: SOPIndexEntry[] = [];

    // Index system SOPs
    await this.indexDirectory(this.systemPath, entries, true);

    // Index custom SOPs
    await this.indexDirectory(this.customPath, entries, false);

    this.index = {
      version: SOP_CONSTANTS.INDEX_VERSION,
      lastUpdated: new Date().toISOString(),
      sops: entries,
    };

    await this.saveIndex();
    this.sopCache.clear();
    this.logger.info('SOP index rebuilt', { count: entries.length });
  }

  /**
   * Index a directory recursively
   *
   * @param dirPath - Directory path to index
   * @param entries - Array to add entries to
   * @param isSystem - Whether these are system SOPs
   */
  private async indexDirectory(
    dirPath: string,
    entries: SOPIndexEntry[],
    isSystem: boolean
  ): Promise<void> {
    if (!existsSync(dirPath)) {
      return;
    }

    try {
      const items = await fs.readdir(dirPath, { withFileTypes: true });

      for (const item of items) {
        const itemPath = path.join(dirPath, item.name);

        if (item.isDirectory()) {
          await this.indexDirectory(itemPath, entries, isSystem);
        } else if (item.name.endsWith('.md')) {
          const parsed = await this.parseSOPFile(itemPath);
          if (parsed) {
            entries.push({
              id: parsed.frontmatter.id,
              path: path.relative(this.basePath, itemPath),
              role: parsed.frontmatter.role,
              category: parsed.frontmatter.category,
              priority: parsed.frontmatter.priority,
              triggers: parsed.frontmatter.triggers,
              title: parsed.frontmatter.title,
              isSystem,
            });
          }
        }
      }
    } catch (error) {
      this.logger.warn('Error indexing directory', { dirPath, error });
    }
  }

  /**
   * Parse an SOP file from disk
   *
   * @param filePath - Path to the SOP file
   * @returns Parsed SOP or null on error
   */
  private async parseSOPFile(filePath: string): Promise<ParsedSOP | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return this.parseSOPContent(content);
    } catch (error) {
      this.logger.warn('Failed to parse SOP file', { filePath, error });
      return null;
    }
  }

  /**
   * Parse SOP content (frontmatter + body)
   *
   * @param content - Raw file content
   * @returns Parsed SOP or null on error
   */
  private parseSOPContent(content: string): ParsedSOP | null {
    // Match frontmatter (YAML between ---)
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

    if (!frontmatterMatch) {
      return null;
    }

    const [, frontmatterStr, body] = frontmatterMatch;

    try {
      const frontmatter = parseYAML(frontmatterStr) as SOPFrontmatter;

      // Validate required fields
      if (!frontmatter.id || !frontmatter.role || !frontmatter.category) {
        return null;
      }

      return {
        frontmatter: {
          id: frontmatter.id,
          version: frontmatter.version || 1,
          createdAt: frontmatter.createdAt || new Date().toISOString(),
          updatedAt: frontmatter.updatedAt || new Date().toISOString(),
          createdBy: frontmatter.createdBy || 'system',
          role: frontmatter.role,
          category: frontmatter.category,
          priority: frontmatter.priority ?? SOP_CONSTANTS.MATCHING.DEFAULT_PRIORITY,
          title: frontmatter.title || frontmatter.id,
          description: frontmatter.description || '',
          triggers: frontmatter.triggers || [],
          conditions: frontmatter.conditions,
          tags: frontmatter.tags || [],
          relatedSOPs: frontmatter.relatedSOPs,
        },
        content: body.trim(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Convert parsed SOP to full SOP object
   *
   * @param parsed - Parsed SOP
   * @returns Full SOP object
   */
  private parsedToSOP(parsed: ParsedSOP): SOP {
    return {
      ...parsed.frontmatter,
      content: parsed.content,
      examples: parsed.examples,
    };
  }

  /**
   * Get an SOP by ID
   *
   * @param id - SOP identifier
   * @returns SOP or null if not found
   */
  public async getSOP(id: string): Promise<SOP | null> {
    // Check cache
    if (this.sopCache.has(id)) {
      return this.sopCache.get(id)!;
    }

    // Find in index
    const index = await this.getIndex();
    const entry = index.sops.find((e) => e.id === id);
    if (!entry) {
      return null;
    }

    // Load file
    const filePath = path.join(this.basePath, entry.path);
    const parsed = await this.parseSOPFile(filePath);

    if (parsed) {
      const sop = this.parsedToSOP(parsed);
      this.sopCache.set(id, sop);
      return sop;
    }

    return null;
  }

  /**
   * Get all SOPs for a specific role
   *
   * @param role - Role to filter by
   * @returns Array of SOPs
   */
  public async getSOPsByRole(role: SOPRole | 'all'): Promise<SOP[]> {
    const index = await this.getIndex();
    const entries = index.sops.filter(
      (e) => e.role === role || e.role === 'all' || role === 'all'
    );

    const sops: SOP[] = [];
    for (const entry of entries) {
      const sop = await this.getSOP(entry.id);
      if (sop) {
        sops.push(sop);
      }
    }

    return sops;
  }

  /**
   * Get all SOPs in a category
   *
   * @param category - Category to filter by
   * @returns Array of SOPs
   */
  public async getSOPsByCategory(category: SOPCategory): Promise<SOP[]> {
    const index = await this.getIndex();
    const entries = index.sops.filter((e) => e.category === category);

    const sops: SOP[] = [];
    for (const entry of entries) {
      const sop = await this.getSOP(entry.id);
      if (sop) {
        sops.push(sop);
      }
    }

    return sops;
  }

  /**
   * Find SOPs relevant to the given context
   *
   * @param params - Match parameters
   * @returns Array of matching SOPs
   */
  public async findRelevantSOPs(params: SOPMatchParams): Promise<SOP[]> {
    const index = await this.getIndex();
    const { role, taskContext, taskType, limit = SOP_CONSTANTS.LIMITS.MAX_SOPS_IN_PROMPT } = params;

    // Filter and score entries
    const scored = index.sops
      .filter((entry) => this.matchesRole(entry, role))
      .map((entry) => ({
        entry,
        score: this.scoreRelevance(entry, taskContext || '', taskType),
      }))
      .filter((s) => s.score >= SOP_CONSTANTS.MATCHING.MIN_TRIGGER_MATCH_SCORE)
      .sort((a, b) => {
        // Sort by score, then priority
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return b.entry.priority - a.entry.priority;
      })
      .slice(0, limit);

    // Load full SOPs
    const sops: SOP[] = [];
    for (const { entry } of scored) {
      const sop = await this.getSOP(entry.id);
      if (sop) {
        sops.push(sop);
      }
    }

    return sops;
  }

  /**
   * Check if an SOP matches a role
   *
   * @param entry - SOP index entry
   * @param role - Role to check
   * @returns True if matches
   */
  private matchesRole(entry: SOPIndexEntry, role: string): boolean {
    if (entry.role === 'all') {
      return true;
    }
    if (entry.role === role) {
      return true;
    }

    // Handle role hierarchies
    const roleHierarchy: Record<string, string[]> = {
      'frontend-developer': ['developer'],
      'backend-developer': ['developer'],
      developer: [],
      pm: [],
      tpm: [],
      pgm: [],
      qa: [],
      tester: [],
      orchestrator: [],
      designer: [],
      devops: [],
    };

    const parentRoles = roleHierarchy[role] || [];
    return parentRoles.includes(entry.role);
  }

  /**
   * Score how relevant an SOP is to the given context
   *
   * @param entry - SOP index entry
   * @param context - Context string
   * @param taskType - Optional task type
   * @returns Relevance score (0-1)
   */
  public scoreRelevance(entry: SOPIndexEntry, context: string, taskType?: string): number {
    let score = 0;
    const contextLower = context.toLowerCase();
    const words = contextLower.split(/\s+/);

    // Score trigger matches
    for (const trigger of entry.triggers) {
      const triggerLower = trigger.toLowerCase();
      if (contextLower.includes(triggerLower)) {
        score += 0.3;
      }
      if (words.includes(triggerLower)) {
        score += 0.2;
      }
    }

    // Score category match
    if (taskType && entry.category === taskType) {
      score += SOP_CONSTANTS.MATCHING.CATEGORY_MATCH_BOOST;
    }

    // Normalize score
    return Math.min(score, 1.0);
  }

  /**
   * Generate SOP context string for prompts
   *
   * @param params - Match parameters
   * @returns Formatted SOP context string
   */
  public async generateSOPContext(params: SOPMatchParams): Promise<string> {
    const sops = await this.findRelevantSOPs(params);
    // Surface the team's own installed/custom SOPs (written to the team library
    // by the wiki editor / update-sop skill) — the read path historically only
    // read the global store, so team SOPs were invisible to get-sops.
    const teamSops = params.teamId ? await this.readTeamSOPs(params.teamId) : [];

    if (sops.length === 0 && teamSops.length === 0) {
      return '';
    }

    const render = (title: string, category: string, priority: string | number, raw: string): string => {
      const content =
        raw.length > SOP_CONSTANTS.LIMITS.MAX_SOP_CONTENT_LENGTH
          ? raw.substring(0, SOP_CONSTANTS.LIMITS.MAX_SOP_CONTENT_LENGTH) + '\n\n*[Content truncated]*'
          : raw;
      return `### ${title}\n\n*Category: ${category} | Priority: ${priority}*\n\n${content}\n\n---\n\n`;
    };

    let context = '## Relevant Standard Operating Procedures\n\n';
    context += 'Follow these procedures for your current work:\n\n';
    for (const sop of sops) {
      context += render(sop.title, sop.category, sop.priority, sop.content);
    }

    if (teamSops.length > 0) {
      context += '## Team SOPs\n\n';
      context += "Your team's own SOPs:\n\n";
      for (const sop of teamSops) {
        context += render(sop.title, sop.category, 'team', sop.content);
      }
    }

    return context;
  }

  /**
   * Read a team's installed/custom SOP library from
   * `~/.crewly/teams/<teamId>/sops/` (recursively). Each `.md` file becomes a
   * SOP entry with its frontmatter `title`/`category` (falling back to the
   * filename / parent folder). Read-only; tolerant of a missing directory.
   *
   * @param teamId - The team whose SOP library to read.
   * @returns Team SOP entries (possibly empty).
   */
  private async readTeamSOPs(
    teamId: string,
  ): Promise<Array<{ title: string; category: string; content: string }>> {
    const root = path.join(this.getCrewlyHome(), 'teams', teamId, 'sops');
    const out: Array<{ title: string; category: string; content: string }> = [];
    const walk = async (dir: string, categoryHint: string): Promise<void> => {
      let entries: import('fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs, entry.name);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          try {
            const raw = await fs.readFile(abs, 'utf-8');
            const titleMatch = raw.match(/^\s*title:\s*(.+?)\s*$/m);
            const catMatch = raw.match(/^\s*category:\s*(.+?)\s*$/m);
            const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
            out.push({
              title: titleMatch ? titleMatch[1].replace(/^["']|["']$/g, '') : path.basename(entry.name, '.md'),
              category: catMatch ? catMatch[1].trim() : categoryHint || 'team',
              content: body || raw,
            });
          } catch {
            // skip unreadable file
          }
        }
      }
    };
    await walk(root, '');
    return out;
  }

  /**
   * Create a custom SOP
   *
   * @param sopData - SOP data (without id, timestamps, version)
   * @returns Created SOP ID
   */
  public async createCustomSOP(
    sopData: Omit<SOP, 'id' | 'createdAt' | 'updatedAt' | 'version'>
  ): Promise<string> {
    const id = `custom-${uuidv4().substring(0, 8)}`;
    const now = new Date().toISOString();

    const sop: SOP = {
      ...sopData,
      id,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    // Create file
    const filePath = path.join(this.customPath, `${id}.md`);
    const content = this.sopToMarkdown(sop);
    await fs.writeFile(filePath, content, 'utf-8');

    // Update index
    await this.rebuildIndex();

    this.logger.info('Custom SOP created', { id, title: sop.title });
    return id;
  }

  /**
   * Update an existing SOP
   *
   * @param id - SOP identifier
   * @param updates - Partial SOP updates
   */
  public async updateSOP(id: string, updates: Partial<SOP>): Promise<void> {
    const index = await this.getIndex();
    const entry = index.sops.find((e) => e.id === id);

    if (!entry) {
      throw new Error(`SOP not found: ${id}`);
    }

    if (entry.isSystem) {
      throw new Error('Cannot update system SOPs');
    }

    const existingSOP = await this.getSOP(id);
    if (!existingSOP) {
      throw new Error(`SOP not found: ${id}`);
    }

    const updatedSOP: SOP = {
      ...existingSOP,
      ...updates,
      id: existingSOP.id, // Prevent ID change
      version: existingSOP.version + 1,
      updatedAt: new Date().toISOString(),
    };

    // Update file
    const filePath = path.join(this.basePath, entry.path);
    const content = this.sopToMarkdown(updatedSOP);
    await fs.writeFile(filePath, content, 'utf-8');

    // Update cache and index
    this.sopCache.set(id, updatedSOP);
    await this.rebuildIndex();

    this.logger.info('SOP updated', { id, version: updatedSOP.version });
  }

  /**
   * Delete a custom SOP
   *
   * @param id - SOP identifier
   */
  public async deleteSOP(id: string): Promise<void> {
    const index = await this.getIndex();
    const entry = index.sops.find((e) => e.id === id);

    if (!entry) {
      throw new Error(`SOP not found: ${id}`);
    }

    if (entry.isSystem) {
      throw new Error('Cannot delete system SOPs');
    }

    // Delete file
    const filePath = path.join(this.basePath, entry.path);
    await fs.unlink(filePath);

    // Update cache and index
    this.sopCache.delete(id);
    await this.rebuildIndex();

    this.logger.info('SOP deleted', { id });
  }

  /**
   * Get the current SOP index
   *
   * @returns SOP index
   */
  public async getIndex(): Promise<SOPIndex> {
    if (!this.index) {
      await this.ensureIndex();
    }
    return this.index!;
  }

  /**
   * Search SOPs by query string
   *
   * @param query - Search query
   * @returns Matching index entries
   */
  public async searchSOPs(query: string): Promise<SOPIndexEntry[]> {
    const index = await this.getIndex();
    const queryLower = query.toLowerCase();

    return index.sops.filter((entry) => {
      // Search in title
      if (entry.title.toLowerCase().includes(queryLower)) {
        return true;
      }

      // Search in triggers
      if (entry.triggers.some((t) => t.toLowerCase().includes(queryLower))) {
        return true;
      }

      // Search in category
      if (entry.category.toLowerCase().includes(queryLower)) {
        return true;
      }

      return false;
    });
  }

  /**
   * Ensure the index exists (load or rebuild)
   */
  private async ensureIndex(): Promise<void> {
    try {
      const content = await fs.readFile(this.indexPath, 'utf-8');
      this.index = JSON.parse(content);
    } catch {
      await this.rebuildIndex();
    }
  }

  /**
   * Save the index to disk
   */
  private async saveIndex(): Promise<void> {
    // Ensure the store dir exists — on a fresh machine ~/.crewly/sops may not
    // exist yet, and the first query rebuilds the index before initialize()
    // has created it (otherwise saveIndex throws ENOENT → 500 on first call).
    await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
    await fs.writeFile(this.indexPath, JSON.stringify(this.index, null, 2), 'utf-8');
  }

  /**
   * Convert an SOP to Markdown format
   *
   * @param sop - SOP to convert
   * @returns Markdown string
   */
  private sopToMarkdown(sop: SOP): string {
    const frontmatter: SOPFrontmatter = {
      id: sop.id,
      version: sop.version,
      createdAt: sop.createdAt,
      updatedAt: sop.updatedAt,
      createdBy: sop.createdBy,
      role: sop.role,
      category: sop.category,
      priority: sop.priority,
      title: sop.title,
      description: sop.description,
      triggers: sop.triggers,
      conditions: sop.conditions,
      tags: sop.tags,
      relatedSOPs: sop.relatedSOPs,
    };

    return `---\n${stringifyYAML(frontmatter)}---\n\n${sop.content}`;
  }

  /**
   * Clear the SOP cache
   */
  public clearCache(): void {
    this.sopCache.clear();
    this.logger.debug('SOP cache cleared');
  }
}
