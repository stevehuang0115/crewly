/**
 * Skill Service
 *
 * Manages AI agent skills including loading from directories,
 * CRUD operations, and skill matching for prompts.
 *
 * Skills are the evolution of the SOP (Standard Operating Procedures) system,
 * combining prompts, scripts, environment variables, and browser automation.
 *
 * @module services/skill/skill.service
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { existsSync } from 'fs';
import {
  Skill,
  SkillWithPrompt,
  SkillSummary,
  CreateSkillInput,
  UpdateSkillInput,
  SkillFilter,
  SkillStorageFormat,
  SKILL_CONSTANTS,
  createDefaultSkill,
  skillToSummary,
  validateCreateSkillInput,
  validateUpdateSkillInput,
  matchesSkillFilter,
} from '../../types/skill.types.js';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { parseSkillMd } from '../../utils/skill-md-parser.js';

/**
 * Options for initializing the SkillService
 */
export interface SkillServiceOptions {
  /** Directory containing built-in skills */
  builtinSkillsDir?: string;

  /** Directory for user-created skills */
  userSkillsDir?: string;

  /** Directory for marketplace-installed skills */
  marketplaceSkillsDir?: string;
}

/**
 * Service for managing AI agent skills
 *
 * Handles:
 * - Loading built-in skills from config/skills/
 * - Managing user-created skills in ~/.crewly/skills/
 * - CRUD operations for skills
 * - Skill matching for prompts
 * - Integration with role service for skill assignment
 */
export class SkillService {
  private readonly builtinSkillsDir: string;
  private readonly userSkillsDir: string;
  private readonly marketplaceSkillsDir: string;
  private skillsCache: Map<string, Skill> = new Map();
  private initialized = false;
  private readonly logger: ComponentLogger = LoggerService.getInstance().createComponentLogger('SkillService');

  /**
   * Create a new SkillService instance
   *
   * @param options - Configuration options
   */
  constructor(options?: SkillServiceOptions) {
    this.builtinSkillsDir =
      options?.builtinSkillsDir ?? path.join(process.cwd(), 'config', 'skills');
    this.userSkillsDir =
      options?.userSkillsDir ??
      path.join(process.env.HOME || '~', '.crewly', SKILL_CONSTANTS.PATHS.SKILLS_DIR);
    this.marketplaceSkillsDir =
      options?.marketplaceSkillsDir ??
      path.join(process.env.HOME || '~', '.crewly', 'marketplace', 'skills');
  }

  /**
   * Initialize the service by loading all skills
   *
   * Creates user skills directory if it doesn't exist and loads
   * both built-in and user-defined skills into memory.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.ensureUserSkillsDir();
    await this.loadAllSkills();
    this.initialized = true;
  }

  /**
   * Get all skills, optionally filtered
   *
   * @param filter - Optional filter criteria
   * @returns Array of skill summaries
   */
  async listSkills(filter?: SkillFilter): Promise<SkillSummary[]> {
    await this.ensureInitialized();

    let skills = Array.from(this.skillsCache.values());

    if (filter) {
      skills = skills.filter((skill) => matchesSkillFilter(skill, filter));
    }

    return skills.map(skillToSummary);
  }

  /**
   * Get a skill by ID with full prompt content
   *
   * @param id - Skill identifier
   * @returns Skill with prompt content or null if not found
   */
  async getSkill(id: string): Promise<SkillWithPrompt | null> {
    await this.ensureInitialized();

    const skill = this.skillsCache.get(id);
    if (!skill) return null;

    const promptContent = await this.loadPromptContent(skill);
    return { ...skill, promptContent };
  }

  /**
   * Get skills matching a prompt/input
   *
   * Used by agents to find relevant skills for a task. Scores skills
   * based on trigger matches, tag matches, name matches, and description
   * keyword matches.
   *
   * @param input - User input or prompt to match against
   * @param roleId - Optional role ID to filter by
   * @param maxResults - Maximum number of results to return (default: 5)
   * @returns Array of matching skills with prompt content, sorted by relevance
   */
  async matchSkills(input: string, roleId?: string, maxResults = 5): Promise<SkillWithPrompt[]> {
    await this.ensureInitialized();

    const inputLower = input.toLowerCase();
    const matches: { skill: Skill; score: number }[] = [];

    for (const skill of this.skillsCache.values()) {
      if (!skill.isEnabled) continue;

      // Check role assignment if provided
      if (roleId && !skill.assignableRoles.includes(roleId) && skill.assignableRoles.length > 0) {
        continue;
      }

      let score = 0;

      // Check triggers (highest priority)
      for (const trigger of skill.triggers) {
        if (inputLower.includes(trigger.toLowerCase())) {
          score += 10;
        }
      }

      // Check tags
      for (const tag of skill.tags) {
        if (inputLower.includes(tag.toLowerCase())) {
          score += 3;
        }
      }

      // Check name
      if (inputLower.includes(skill.name.toLowerCase())) {
        score += 5;
      }

      // Check description keywords
      const descWords = skill.description.toLowerCase().split(/\s+/);
      for (const word of descWords) {
        if (word.length > 3 && inputLower.includes(word)) {
          score += 1;
        }
      }

      if (score > 0) {
        matches.push({ skill, score });
      }
    }

    // Sort by score descending
    matches.sort((a, b) => b.score - a.score);

    // Get top results with prompt content
    const topMatches = matches.slice(0, maxResults);
    return Promise.all(
      topMatches.map(async ({ skill }) => ({
        ...skill,
        promptContent: await this.loadPromptContent(skill),
      }))
    );
  }

  /**
   * Create a new user-defined skill
   *
   * @param input - Skill creation input
   * @returns The created skill
   * @throws SkillValidationError if input is invalid
   */
  async createSkill(input: CreateSkillInput): Promise<Skill> {
    await this.ensureInitialized();

    const errors = validateCreateSkillInput(input);
    if (errors.length > 0) {
      throw new SkillValidationError(errors);
    }

    const skill = createDefaultSkill({ ...input, skillType: input.skillType });
    skill.execution = input.execution;
    skill.environment = input.environment;
    skill.runtime = input.runtime;
    skill.notices = input.notices;
    skill.assignableRoles = input.assignableRoles ?? [];
    skill.triggers = input.triggers ?? [];
    skill.tags = input.tags ?? [];

    await this.saveSkill(skill, input.promptContent);
    this.skillsCache.set(skill.id, skill);

    return skill;
  }

  /**
   * Update an existing skill
   *
   * @param id - Skill identifier
   * @param input - Update input with partial skill data
   * @returns The updated skill
   * @throws SkillNotFoundError if skill doesn't exist
   * @throws BuiltinSkillModificationError if trying to modify a built-in skill
   */
  async updateSkill(id: string, input: UpdateSkillInput): Promise<Skill> {
    await this.ensureInitialized();

    const existing = this.skillsCache.get(id);
    if (!existing) {
      throw new SkillNotFoundError(id);
    }

    if (existing.isBuiltin) {
      throw new BuiltinSkillModificationError('update');
    }

    const validationErrors = validateUpdateSkillInput(input);
    if (validationErrors.length > 0) {
      throw new SkillValidationError(validationErrors);
    }

    const updated: Skill = {
      ...existing,
      name: input.name ?? existing.name,
      description: input.description ?? existing.description,
      category: input.category ?? existing.category,
      skillType: input.skillType ?? existing.skillType,
      execution: input.execution ?? existing.execution,
      environment: input.environment ?? existing.environment,
      runtime: input.runtime ?? existing.runtime,
      notices: input.notices ?? existing.notices,
      assignableRoles: input.assignableRoles ?? existing.assignableRoles,
      triggers: input.triggers ?? existing.triggers,
      tags: input.tags ?? existing.tags,
      isEnabled: input.isEnabled ?? existing.isEnabled,
      updatedAt: new Date().toISOString(),
    };

    await this.saveSkill(updated, input.promptContent);
    this.skillsCache.set(id, updated);

    return updated;
  }

  /**
   * Delete a user-created skill
   *
   * @param id - Skill identifier
   * @throws SkillNotFoundError if skill doesn't exist
   * @throws BuiltinSkillModificationError if trying to delete a built-in skill
   */
  async deleteSkill(id: string): Promise<void> {
    await this.ensureInitialized();

    const skill = this.skillsCache.get(id);
    if (!skill) {
      throw new SkillNotFoundError(id);
    }

    if (skill.isBuiltin) {
      throw new BuiltinSkillModificationError('delete');
    }

    const skillDir = path.join(this.userSkillsDir, id);
    await fs.rm(skillDir, { recursive: true, force: true });
    this.skillsCache.delete(id);
  }

  /**
   * Enable or disable a skill
   *
   * @param id - Skill identifier
   * @param enabled - Whether to enable or disable
   * @returns The updated skill
   */
  async setSkillEnabled(id: string, enabled: boolean): Promise<Skill> {
    return this.updateSkill(id, { isEnabled: enabled });
  }

  /**
   * Get skills assigned to a specific role
   *
   * @param roleId - Role identifier
   * @returns Array of skill summaries for the role
   */
  async getSkillsForRole(roleId: string): Promise<SkillSummary[]> {
    return this.listSkills({ roleId, isEnabled: true });
  }

  /**
   * Refresh skills from disk (reload)
   *
   * Clears the cache and reloads all skills from both
   * built-in and user directories.
   */
  async refresh(): Promise<void> {
    this.skillsCache.clear();
    this.initialized = false;
    await this.initialize();
  }

  /**
   * Get the count of all skills
   *
   * @returns Total number of skills in cache
   */
  async getSkillCount(): Promise<number> {
    await this.ensureInitialized();
    return this.skillsCache.size;
  }

  /**
   * Check if a skill exists
   *
   * @param id - Skill identifier
   * @returns True if skill exists
   */
  async skillExists(id: string): Promise<boolean> {
    await this.ensureInitialized();
    return this.skillsCache.has(id);
  }

  // ==========================================================================
  // Private methods
  // ==========================================================================

  /**
   * Ensure the service is initialized before operations
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Ensure the user skills directory exists
   */
  private async ensureUserSkillsDir(): Promise<void> {
    await fs.mkdir(this.userSkillsDir, { recursive: true });
  }

  /**
   * Load all skills from both builtin and user directories
   */
  private async loadAllSkills(): Promise<void> {
    // Load built-in skills
    try {
      if (existsSync(this.builtinSkillsDir)) {
        const builtinSkills = await this.loadSkillsFromDir(this.builtinSkillsDir, true);
        for (const skill of builtinSkills) {
          this.skillsCache.set(skill.id, skill);
        }
      }
    } catch (error) {
      // Log warning but don't fail - built-in skills may not exist yet
      this.logger.warn('Failed to load built-in skills', { error: error instanceof Error ? error.message : String(error) });
    }

    // Load user skills
    try {
      if (existsSync(this.userSkillsDir)) {
        const userSkills = await this.loadSkillsFromDir(this.userSkillsDir, false);
        for (const skill of userSkills) {
          this.skillsCache.set(skill.id, skill);
        }
      }
    } catch (error) {
      // Log warning but don't fail - user skills may not exist yet
      this.logger.warn('Failed to load user skills', { error: error instanceof Error ? error.message : String(error) });
    }

    // Load marketplace-installed skills
    try {
      if (existsSync(this.marketplaceSkillsDir)) {
        const marketplaceSkills = await this.loadSkillsFromDir(this.marketplaceSkillsDir, false);
        for (const skill of marketplaceSkills) {
          skill.isMarketplace = true;
          this.skillsCache.set(skill.id, skill);
        }
      }
    } catch (error) {
      this.logger.warn('Failed to load marketplace skills', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Check if a directory is a skill directory (has SKILL.md or legacy skill.json).
   *
   * @param dir - Directory path to check
   * @returns True if the directory contains a skill definition
   */
  private isSkillDirectory(dir: string): boolean {
    return existsSync(path.join(dir, 'SKILL.md')) || existsSync(path.join(dir, 'skill.json'));
  }

  /**
   * Load skills from a directory
   *
   * Handles both flat structure (SKILL.md in immediate subdirs)
   * and nested category structure (category/skill/SKILL.md).
   *
   * @param dir - Directory path
   * @param isBuiltin - Whether these are built-in skills
   * @returns Array of loaded skills
   */
  private async loadSkillsFromDir(dir: string, isBuiltin: boolean): Promise<Skill[]> {
    const skills: Skill[] = [];

    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const subDir = path.join(dir, entry.name);

      if (this.isSkillDirectory(subDir)) {
        const skill = await this.loadSkillFromDir(subDir, isBuiltin);
        if (skill) {
          skills.push(skill);
        }
      } else {
        // This might be a category directory, recurse into it
        const nestedSkills = await this.loadNestedSkills(subDir, isBuiltin);
        skills.push(...nestedSkills);
      }
    }

    return skills;
  }

  /**
   * Load skills from nested directories (category/skill structure)
   *
   * @param categoryDir - Category directory path
   * @param isBuiltin - Whether these are built-in skills
   * @returns Array of loaded skills from the category
   */
  private async loadNestedSkills(categoryDir: string, isBuiltin: boolean): Promise<Skill[]> {
    const skills: Skill[] = [];

    try {
      const entries = await fs.readdir(categoryDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillDir = path.join(categoryDir, entry.name);

        if (this.isSkillDirectory(skillDir)) {
          const skill = await this.loadSkillFromDir(skillDir, isBuiltin);
          if (skill) {
            skills.push(skill);
          }
        }
      }
    } catch (error) {
      this.logger.warn('Failed to load nested skills', { categoryDir, error: error instanceof Error ? error.message : String(error) });
    }

    return skills;
  }

  /**
   * Load a single skill from a directory. Tries SKILL.md first,
   * then falls back to legacy skill.json format.
   *
   * @param skillDir - Directory containing the skill
   * @param isBuiltin - Whether this is a built-in skill
   * @returns Loaded skill or null if loading fails
   */
  private async loadSkillFromDir(
    skillDir: string,
    isBuiltin: boolean
  ): Promise<Skill | null> {
    const skillMdPath = path.join(skillDir, 'SKILL.md');

    if (existsSync(skillMdPath)) {
      return this.loadSkillFromSkillMd(skillDir, skillMdPath, isBuiltin);
    }

    // Legacy fallback: skill.json
    const skillJsonPath = path.join(skillDir, 'skill.json');
    if (existsSync(skillJsonPath)) {
      return this.loadSkillFromLegacyJson(skillDir, skillJsonPath, isBuiltin);
    }

    return null;
  }

  /**
   * Load a skill from SKILL.md format (YAML frontmatter + markdown body).
   *
   * @param skillDir - Directory containing the skill
   * @param skillMdPath - Path to SKILL.md file
   * @param isBuiltin - Whether this is a built-in skill
   * @returns Loaded skill or null if loading fails
   */
  private async loadSkillFromSkillMd(
    skillDir: string,
    skillMdPath: string,
    isBuiltin: boolean
  ): Promise<Skill | null> {
    try {
      const content = await fs.readFile(skillMdPath, 'utf-8');
      const { frontmatter, body } = parseSkillMd(content);

      const dirName = path.basename(skillDir);
      const fm = frontmatter as Record<string, unknown>;

      // Validate required fields
      if (!fm.name || !fm.description) {
        this.logger.warn('SKILL.md missing required fields (name/description)', { skillDir });
        return null;
      }

      const skill: Skill = {
        id: (fm.id as string) || `skill-${dirName}`,
        name: fm.name as string,
        description: fm.description as string,
        category: ((fm.category as string) || 'general') as Skill['category'],
        skillType: ((fm.skillType as string) || 'claude-skill') as Skill['skillType'],
        promptFile: skillMdPath, // body content is in the SKILL.md itself
        execution: fm.execution as Skill['execution'],
        environment: fm.environment as Skill['environment'],
        credentials: fm.credentials as Skill['credentials'],
        runtime: fm.runtime as Skill['runtime'],
        notices: fm.notices as Skill['notices'],
        assignableRoles: (fm.assignableRoles as string[]) || [],
        triggers: (fm.triggers as string[]) || [],
        tags: (fm.tags as string[]) || [],
        version: (fm.version as string) || '1.0.0',
        requiredTier: fm.requiredTier as string | undefined,
        fallbackSkill: fm.fallbackSkill as string | undefined,
        isBuiltin,
        isEnabled: true,
        createdAt: (fm.createdAt as string) || new Date().toISOString(),
        updatedAt: (fm.updatedAt as string) || new Date().toISOString(),
      };

      return skill;
    } catch (error) {
      this.logger.warn('Failed to load skill from SKILL.md', { skillDir, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  /**
   * Load a single skill from a legacy skill.json file.
   *
   * @param skillDir - Directory containing the skill
   * @param skillJsonPath - Path to skill.json file
   * @param isBuiltin - Whether this is a built-in skill
   * @returns Loaded skill or null if loading fails
   */
  private async loadSkillFromLegacyJson(
    skillDir: string,
    skillJsonPath: string,
    isBuiltin: boolean
  ): Promise<Skill | null> {
    try {
      const content = await fs.readFile(skillJsonPath, 'utf-8');
      const data: SkillStorageFormat = JSON.parse(content);

      const skill: Skill = {
        ...data,
        isBuiltin,
        isEnabled: true,
        promptFile: path.join(skillDir, data.promptFile || 'instructions.md'),
      };

      return skill;
    } catch (error) {
      this.logger.warn('Failed to load skill', { skillDir, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  /**
   * Load prompt content for a skill.
   *
   * For SKILL.md format, extracts the markdown body (after frontmatter).
   * For legacy format, reads the separate instructions.md file.
   *
   * @param skill - Skill to load prompt for
   * @returns Prompt content string
   */
  private async loadPromptContent(skill: Skill): Promise<string> {
    try {
      const content = await fs.readFile(skill.promptFile, 'utf-8');

      // If promptFile points to a SKILL.md, extract just the body
      if (skill.promptFile.endsWith('SKILL.md')) {
        const { body } = parseSkillMd(content);
        return body;
      }

      return content;
    } catch (error) {
      this.logger.warn('Failed to load prompt for skill', { skillId: skill.id, error: error instanceof Error ? error.message : String(error) });
      return '';
    }
  }

  /**
   * Save a skill to disk in SKILL.md format (YAML frontmatter + markdown body).
   *
   * @param skill - Skill to save
   * @param promptContent - Optional prompt content (markdown body)
   */
  private async saveSkill(skill: Skill, promptContent?: string): Promise<void> {
    // Lazy import to avoid circular dependency issues at module load time
    const { stringify: stringifyYAML } = await import('yaml');

    const skillDir = path.join(this.userSkillsDir, skill.id);
    await fs.mkdir(skillDir, { recursive: true });

    // Build frontmatter object (id included for reload identity)
    const frontmatter: Record<string, unknown> = {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      category: skill.category,
      skillType: skill.skillType,
    };

    if (skill.assignableRoles?.length) frontmatter.assignableRoles = skill.assignableRoles;
    if (skill.triggers?.length) frontmatter.triggers = skill.triggers;
    if (skill.tags?.length) frontmatter.tags = skill.tags;
    if (skill.execution) frontmatter.execution = skill.execution;
    if (skill.environment) frontmatter.environment = skill.environment;
    if (skill.runtime) frontmatter.runtime = skill.runtime;
    if (skill.notices?.length) frontmatter.notices = skill.notices;
    if (skill.requiredTier) frontmatter.requiredTier = skill.requiredTier;
    if (skill.fallbackSkill) frontmatter.fallbackSkill = skill.fallbackSkill;

    const yamlStr = stringifyYAML(frontmatter).trim();
    const body = promptContent || '';
    const skillMdContent = `---\n${yamlStr}\n---\n\n${body}\n`;

    const skillMdPath = path.join(skillDir, 'SKILL.md');
    await fs.writeFile(skillMdPath, skillMdContent);

    // Update skill's prompt file path
    skill.promptFile = skillMdPath;
  }
}

// =============================================================================
// Error Classes
// =============================================================================

/**
 * Error thrown when a skill is not found
 */
export class SkillNotFoundError extends Error {
  /**
   * Create a SkillNotFoundError
   *
   * @param id - ID of the skill that was not found
   */
  constructor(public readonly skillId: string) {
    super(`Skill not found: ${skillId}`);
    this.name = 'SkillNotFoundError';
  }
}

/**
 * Error thrown when skill validation fails
 */
export class SkillValidationError extends Error {
  /**
   * Create a SkillValidationError
   *
   * @param errors - Array of validation error messages
   */
  constructor(public readonly errors: string[]) {
    super(`Skill validation failed: ${errors.join(', ')}`);
    this.name = 'SkillValidationError';
  }
}

/**
 * Error thrown when attempting to modify a built-in skill
 */
export class BuiltinSkillModificationError extends Error {
  /**
   * Create a BuiltinSkillModificationError
   *
   * @param action - The action that was attempted (e.g., 'update', 'delete')
   */
  constructor(public readonly action: string) {
    super(`Cannot ${action} a built-in skill`);
    this.name = 'BuiltinSkillModificationError';
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let skillServiceInstance: SkillService | null = null;

/**
 * Get the singleton SkillService instance
 *
 * @returns The shared SkillService instance
 */
export function getSkillService(): SkillService {
  if (!skillServiceInstance) {
    skillServiceInstance = new SkillService();
  }
  return skillServiceInstance;
}

/**
 * Reset the singleton SkillService instance
 *
 * Used primarily for testing to ensure a clean state.
 */
export function resetSkillService(): void {
  skillServiceInstance = null;
}
