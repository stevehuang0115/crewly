/**
 * Skill Catalog Service
 *
 * Scans skill directories (orchestrator and agent), reads SKILL.md
 * (YAML frontmatter + markdown body) from each, and generates formatted
 * catalog Markdown files at ~/.crewly/skills/.
 *
 * Generates two catalogs:
 * - SKILLS_CATALOG.md for orchestrator skills
 * - AGENT_SKILLS_CATALOG.md for agent skills
 *
 * Each catalog provides a human-readable and LLM-readable reference of all
 * available skills grouped by category, including usage examples and parameter
 * documentation extracted from each skill's SKILL.md body.
 *
 * @module services/skill/skill-catalog.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync, mkdirSync } from 'fs';
import * as os from 'os';
import { LoggerService } from '../core/logger.service.js';
import { CREWLY_CONSTANTS } from '../../constants.js';
import { parseSkillMd } from '../../utils/skill-md-parser.js';

// =============================================================================
// Constants
// =============================================================================

/** Name of the generated orchestrator catalog file */
const CATALOG_FILENAME = 'SKILLS_CATALOG.md';

/** Name of the generated agent catalog file */
const AGENT_CATALOG_FILENAME = 'AGENT_SKILLS_CATALOG.md';

/** Subdirectory under ~/.crewly where the catalog is written */
const CATALOG_SUBDIR = 'skills';

/** Relative path from project root to orchestrator skills */
const ORCHESTRATOR_SKILLS_RELATIVE_PATH = 'config/skills/orchestrator';

/** Relative path from project root to agent skills */
const AGENT_SKILLS_RELATIVE_PATH = 'config/skills/agent';

/** Directory names to skip when scanning for skills */
const SKIP_DIRECTORIES = ['_common'] as const;

/** Skill definition file name expected in each skill directory */
const SKILL_DEFINITION_FILE = 'SKILL.md';

/** Legacy skill definition file name (for backward compatibility) */
const LEGACY_SKILL_DEFINITION_FILE = 'skill.json';

/** Markdown heading pattern for detecting section boundaries */
const HEADING_PATTERN = /^#{1,2}\s/;

// =============================================================================
// Interfaces
// =============================================================================

/**
 * Represents the JSON structure read from a skill.json file.
 *
 * This mirrors the on-disk format used by orchestrator skills in
 * config/skills/orchestrator/{skill-name}/skill.json.
 */
interface SkillDefinition {
  /** Unique identifier for the skill (e.g., "orc-assign-task") */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Brief description of what the skill does */
  description: string;
  /** Category for grouping (e.g., "management", "monitoring", "communication") */
  category: string;
  /** Execution configuration for the skill */
  execution?: {
    /** Execution type (e.g., "script", "browser", "mcp-tool") */
    type: string;
    /** Script execution configuration */
    script?: {
      /** Script file name relative to the skill directory */
      file: string;
      /** Script interpreter (e.g., "bash", "python", "node") */
      interpreter: string;
      /** Maximum execution time in milliseconds */
      timeoutMs: number;
    };
  };
  /** Searchable tags for the skill */
  tags?: string[];
  /** Semantic version string */
  version?: string;
}

/**
 * Internal representation of a loaded skill with its instructions content
 * and directory name for catalog generation.
 */
interface LoadedSkill {
  /** The parsed skill.json definition */
  definition: SkillDefinition;
  /** Raw content of instructions.md, or empty string if not found */
  instructions: string;
  /** Directory name (basename) of the skill folder */
  dirName: string;
  /** Optional absolute base path override for the usage command. When set, the
   *  skill's usage line will use this path instead of the catalog-level skillsRelativePath. */
  basePath?: string;
}

/**
 * Result of the catalog generation process.
 */
export interface CatalogGenerationResult {
  /** Whether the catalog was successfully generated */
  success: boolean;
  /** Absolute path to the generated catalog file */
  catalogPath: string;
  /** Total number of skills included in the catalog */
  skillCount: number;
  /** Number of distinct categories in the catalog */
  categoryCount: number;
  /** Error message if generation failed */
  error?: string;
}

// =============================================================================
// Service
// =============================================================================

/**
 * Service for generating a Markdown skills catalog from orchestrator skill directories.
 *
 * Scans config/skills/orchestrator/ for subdirectories (skipping _common),
 * reads skill.json and instructions.md from each, groups skills by category,
 * and writes a formatted SKILLS_CATALOG.md to ~/.crewly/skills/.
 *
 * Uses a singleton pattern consistent with other Crewly services.
 *
 * @example
 * ```typescript
 * const catalogService = SkillCatalogService.getInstance('/path/to/project');
 * const result = await catalogService.generateCatalog();
 * console.log(`Generated catalog at ${result.catalogPath} with ${result.skillCount} skills`);
 * ```
 */
export class SkillCatalogService {
  private static instance: SkillCatalogService | null = null;
  private readonly logger;
  private readonly projectRoot: string;
  private readonly catalogDir: string;

  /**
   * Create a new SkillCatalogService instance.
   *
   * @param projectRoot - Absolute path to the project root directory.
   *   Defaults to the current working directory if not provided.
   */
  constructor(projectRoot?: string) {
    this.logger = LoggerService.getInstance().createComponentLogger('SkillCatalogService');
    this.projectRoot = projectRoot || process.cwd();
    this.catalogDir = path.join(os.homedir(), CREWLY_CONSTANTS.PATHS.CREWLY_HOME, CATALOG_SUBDIR);
  }

  /**
   * Get the singleton SkillCatalogService instance.
   *
   * Creates a new instance on first call with the provided project root,
   * or returns the existing instance on subsequent calls.
   *
   * @param projectRoot - Absolute path to the project root directory
   * @returns The shared SkillCatalogService instance
   */
  public static getInstance(projectRoot?: string): SkillCatalogService {
    if (!SkillCatalogService.instance) {
      SkillCatalogService.instance = new SkillCatalogService(projectRoot);
    }
    return SkillCatalogService.instance;
  }

  /**
   * Reset the singleton instance.
   *
   * Used primarily for testing to ensure a clean state between test runs.
   */
  public static clearInstance(): void {
    SkillCatalogService.instance = null;
  }

  /**
   * Generate the skills catalog by scanning skill directories and writing
   * the formatted Markdown file.
   *
   * This method performs the following steps:
   * 1. Ensures the output directory (~/.crewly/skills/) exists
   * 2. Scans config/skills/orchestrator/ for skill subdirectories
   * 3. Reads skill.json and instructions.md from each valid directory
   * 4. Groups loaded skills by their category field
   * 5. Renders a Markdown catalog document
   * 6. Writes the catalog to ~/.crewly/skills/SKILLS_CATALOG.md
   *
   * @returns A result object with success status, path, and counts
   *
   * @example
   * ```typescript
   * const result = await catalogService.generateCatalog();
   * if (result.success) {
   *   console.log(`Catalog written to ${result.catalogPath}`);
   * } else {
   *   console.error(`Catalog generation failed: ${result.error}`);
   * }
   * ```
   */
  public async generateCatalog(): Promise<CatalogGenerationResult> {
    const catalogPath = this.getCatalogPath();

    try {
      this.logger.info('Starting skills catalog generation', {
        projectRoot: this.projectRoot,
        catalogPath,
      });

      // Ensure the output directory exists
      this.ensureCatalogDirectory();

      // Scan and load all skill directories
      const skills = await this.scanSkillDirectories();

      if (skills.length === 0) {
        this.logger.warn('No skills found during catalog generation');
        const emptyMarkdown = this.renderCatalog(new Map());
        await fs.writeFile(catalogPath, emptyMarkdown, 'utf-8');

        return {
          success: true,
          catalogPath,
          skillCount: 0,
          categoryCount: 0,
        };
      }

      // Group skills by category
      const grouped = this.groupByCategory(skills);

      // Render the Markdown catalog
      const markdown = this.renderCatalog(grouped);

      // Write the catalog file
      await fs.writeFile(catalogPath, markdown, 'utf-8');

      const categoryCount = grouped.size;
      this.logger.info('Skills catalog generated successfully', {
        skillCount: skills.length,
        categoryCount,
        catalogPath,
      });

      return {
        success: true,
        catalogPath,
        skillCount: skills.length,
        categoryCount,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to generate skills catalog', {
        error: errorMessage,
      });

      return {
        success: false,
        catalogPath,
        skillCount: 0,
        categoryCount: 0,
        error: errorMessage,
      };
    }
  }

  /**
   * Generate the agent skills catalog by scanning agent skill directories
   * and writing a formatted Markdown file.
   *
   * This method mirrors generateCatalog() but targets config/skills/agent/
   * and writes to ~/.crewly/skills/AGENT_SKILLS_CATALOG.md.
   *
   * @returns A result object with success status, path, and counts
   *
   * @example
   * ```typescript
   * const result = await catalogService.generateAgentCatalog();
   * if (result.success) {
   *   console.log(`Agent catalog written to ${result.catalogPath}`);
   * }
   * ```
   */
  public async generateAgentCatalog(): Promise<CatalogGenerationResult> {
    const catalogPath = this.getAgentCatalogPath();

    try {
      this.logger.info('Starting agent skills catalog generation', {
        projectRoot: this.projectRoot,
        catalogPath,
      });

      this.ensureCatalogDirectory();

      // Scan bundled agent skills
      const bundledSkills = await this.scanSkillDirectoriesAt(AGENT_SKILLS_RELATIVE_PATH);

      // Use absolute path for agent skills because agents run in their target
      // project directory (e.g. ~/projects/business_os), NOT the Crewly root.
      // Relative paths like config/skills/agent/ won't resolve from there.
      const absoluteSkillsPath = path.join(this.projectRoot, AGENT_SKILLS_RELATIVE_PATH);

      // Also scan marketplace-installed skills
      const marketplacePath = path.join(os.homedir(), '.crewly', 'marketplace', 'skills');
      const marketplaceSkills = await this.scanSkillDirectoriesAt(
        marketplacePath,
        { absolute: true, setBasePath: true },
      );

      // Scan addon-installed skills at ~/.crewly/skills/agent/ (e.g. from crewly-pro)
      const addonSkillsPath = path.join(os.homedir(), '.crewly', 'skills', 'agent');
      const addonSkills = await this.scanSkillDirectoriesAt(
        addonSkillsPath,
        { absolute: true, setBasePath: true },
      );

      // Merge: addon skills take precedence over bundled on name conflict
      const skillsByName = new Map<string, typeof bundledSkills[number]>();
      for (const s of bundledSkills) {
        skillsByName.set(s.definition.name, s);
      }
      for (const s of marketplaceSkills) {
        skillsByName.set(s.definition.name, s);
      }
      for (const s of addonSkills) {
        skillsByName.set(s.definition.name, s);
      }
      const skills = Array.from(skillsByName.values());

      if (skills.length === 0) {
        this.logger.warn('No agent skills found during catalog generation');
        const emptyMarkdown = this.renderCatalogWithConfig(new Map(), {
          title: 'Agent Skills Catalog',
          skillsRelativePath: absoluteSkillsPath,
        });
        await fs.writeFile(catalogPath, emptyMarkdown, 'utf-8');

        return {
          success: true,
          catalogPath,
          skillCount: 0,
          categoryCount: 0,
        };
      }

      const grouped = this.groupByCategory(skills);
      const markdown = this.renderCatalogWithConfig(grouped, {
        title: 'Agent Skills Catalog',
        skillsRelativePath: absoluteSkillsPath,
      });
      await fs.writeFile(catalogPath, markdown, 'utf-8');

      const categoryCount = grouped.size;
      this.logger.info('Agent skills catalog generated successfully', {
        skillCount: skills.length,
        categoryCount,
        catalogPath,
        marketplaceSkillCount: marketplaceSkills.length,
        addonSkillCount: addonSkills.length,
      });

      return {
        success: true,
        catalogPath,
        skillCount: skills.length,
        categoryCount,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to generate agent skills catalog', {
        error: errorMessage,
      });

      return {
        success: false,
        catalogPath,
        skillCount: 0,
        categoryCount: 0,
        error: errorMessage,
      };
    }
  }

  /**
   * Get the absolute path where the orchestrator catalog file will be written.
   *
   * @returns Absolute path to ~/.crewly/skills/SKILLS_CATALOG.md
   */
  public getCatalogPath(): string {
    return path.join(this.catalogDir, CATALOG_FILENAME);
  }

  /**
   * Get the absolute path where the agent catalog file will be written.
   *
   * @returns Absolute path to ~/.crewly/skills/AGENT_SKILLS_CATALOG.md
   */
  public getAgentCatalogPath(): string {
    return path.join(this.catalogDir, AGENT_CATALOG_FILENAME);
  }

  // ==========================================================================
  // Private methods
  // ==========================================================================

  /**
   * Ensure the catalog output directory exists, creating it recursively
   * if necessary.
   *
   * Uses synchronous mkdirSync since this is a one-time setup operation
   * that must complete before writing the catalog.
   */
  private ensureCatalogDirectory(): void {
    if (!existsSync(this.catalogDir)) {
      mkdirSync(this.catalogDir, { recursive: true });
    }
  }

  /**
   * Scan the orchestrator skills directory for valid skill subdirectories.
   *
   * Delegates to scanSkillDirectoriesAt() with the orchestrator skills path.
   *
   * @returns Array of loaded skills with their definitions and instructions
   */
  private async scanSkillDirectories(): Promise<LoadedSkill[]> {
    return this.scanSkillDirectoriesAt(ORCHESTRATOR_SKILLS_RELATIVE_PATH);
  }

  /**
   * Scan a skills directory for valid skill subdirectories.
   *
   * Reads each subdirectory (skipping entries in SKIP_DIRECTORIES),
   * loads skill.json and instructions.md from each, and returns an array
   * of successfully loaded skills. Directories that fail to load are
   * logged as warnings but do not cause the entire scan to fail.
   *
   * When a subdirectory has no skill.json, it is treated as a category
   * directory (e.g. core/, marketplace/) and its children are scanned.
   *
   * @param pathOrRelative - Path to the skills directory. Joined with
   *   projectRoot by default; used directly when `options.absolute` is true.
   * @param options - Optional flags to control path resolution and basePath tagging
   * @returns Array of loaded skills with their definitions and instructions
   */
  private async scanSkillDirectoriesAt(
    pathOrRelative: string,
    options?: { absolute?: boolean; setBasePath?: boolean },
  ): Promise<LoadedSkill[]> {
    const skillsRootDir = options?.absolute
      ? pathOrRelative
      : path.join(this.projectRoot, pathOrRelative);

    if (!existsSync(skillsRootDir)) {
      if (!options?.absolute) {
        this.logger.warn('Skills directory not found', { path: skillsRootDir });
      }
      return [];
    }

    const entries = await fs.readdir(skillsRootDir, { withFileTypes: true });
    const skills: LoadedSkill[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      if ((SKIP_DIRECTORIES as readonly string[]).includes(entry.name)) {
        this.logger.debug('Skipping excluded directory', { dirName: entry.name });
        continue;
      }

      const skillDir = path.join(skillsRootDir, entry.name);
      const skillMdPath = path.join(skillDir, SKILL_DEFINITION_FILE);
      const legacyJsonPath = path.join(skillDir, LEGACY_SKILL_DEFINITION_FILE);

      if (existsSync(skillMdPath) || existsSync(legacyJsonPath)) {
        // Direct skill directory
        const skill = await this.loadSkillFromDirectory(skillsRootDir, entry.name);
        if (skill) {
          if (options?.setBasePath) {
            skill.basePath = skillsRootDir;
          }
          skills.push(skill);
        }
      } else {
        // Category subdirectory (e.g., core/, marketplace/) — recurse
        const nestedEntries = await fs.readdir(skillDir, { withFileTypes: true });
        for (const nested of nestedEntries) {
          if (!nested.isDirectory()) continue;
          const skill = await this.loadSkillFromDirectory(skillDir, nested.name);
          if (skill) {
            skill.basePath = skillDir;
            skills.push(skill);
          }
        }
      }
    }

    skills.sort((a, b) => a.definition.name.localeCompare(b.definition.name));
    return skills;
  }

  /**
   * Load a single skill from a directory by reading its SKILL.md file
   * (YAML frontmatter + markdown body). Falls back to legacy skill.json
   * + instructions.md format for backward compatibility.
   *
   * @param parentDir - Absolute path to the parent skills directory
   * @param dirName - Name of the skill subdirectory
   * @returns A LoadedSkill object, or null if loading fails
   */
  private async loadSkillFromDirectory(
    parentDir: string,
    dirName: string
  ): Promise<LoadedSkill | null> {
    const skillDir = path.join(parentDir, dirName);
    const skillMdPath = path.join(skillDir, SKILL_DEFINITION_FILE);
    const legacyJsonPath = path.join(skillDir, LEGACY_SKILL_DEFINITION_FILE);

    // Try SKILL.md first, then fall back to legacy skill.json
    if (existsSync(skillMdPath)) {
      return this.loadSkillFromSkillMd(skillDir, skillMdPath, dirName);
    } else if (existsSync(legacyJsonPath)) {
      return this.loadSkillFromLegacyJson(skillDir, legacyJsonPath, dirName);
    }

    this.logger.debug('No SKILL.md or skill.json found, skipping directory', {
      dirName,
    });
    return null;
  }

  /**
   * Load a skill from SKILL.md format (YAML frontmatter + markdown body).
   *
   * @param skillDir - Absolute path to the skill directory
   * @param skillMdPath - Path to the SKILL.md file
   * @param dirName - Name of the skill subdirectory
   * @returns A LoadedSkill object, or null if loading fails
   */
  private async loadSkillFromSkillMd(
    skillDir: string,
    skillMdPath: string,
    dirName: string
  ): Promise<LoadedSkill | null> {
    try {
      const content = await fs.readFile(skillMdPath, 'utf-8');
      const { frontmatter, body } = parseSkillMd(content);

      const definition: SkillDefinition = {
        id: (frontmatter.id as string) || `skill-${dirName}`,
        name: frontmatter.name as string,
        description: frontmatter.description as string,
        category: frontmatter.category as string,
        execution: frontmatter.execution as SkillDefinition['execution'],
        tags: frontmatter.tags as string[],
        version: frontmatter.version as string,
      };

      if (!definition.name || !definition.description || !definition.category) {
        this.logger.warn('SKILL.md missing required fields', {
          dirName,
          path: skillMdPath,
        });
        return null;
      }

      return {
        definition,
        instructions: body,
        dirName,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn('Failed to load skill from SKILL.md', {
        dirName,
        error: errorMessage,
      });
      return null;
    }
  }

  /**
   * Load a skill from legacy skill.json + instructions.md format.
   *
   * @param skillDir - Absolute path to the skill directory
   * @param skillJsonPath - Path to the skill.json file
   * @param dirName - Name of the skill subdirectory
   * @returns A LoadedSkill object, or null if loading fails
   */
  private async loadSkillFromLegacyJson(
    skillDir: string,
    skillJsonPath: string,
    dirName: string
  ): Promise<LoadedSkill | null> {
    try {
      const skillJsonContent = await fs.readFile(skillJsonPath, 'utf-8');
      const definition: SkillDefinition = JSON.parse(skillJsonContent);

      if (!definition.id || !definition.name || !definition.description || !definition.category) {
        this.logger.warn('Skill definition missing required fields', {
          dirName,
          id: definition.id,
        });
        return null;
      }

      let instructions = '';
      const instructionsPath = path.join(skillDir, 'instructions.md');
      if (existsSync(instructionsPath)) {
        instructions = await fs.readFile(instructionsPath, 'utf-8');
      }

      return {
        definition,
        instructions,
        dirName,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn('Failed to load skill from skill.json', {
        dirName,
        error: errorMessage,
      });
      return null;
    }
  }

  /**
   * Group loaded skills by their category field.
   *
   * Categories are title-cased for display (e.g., "management" becomes "Management").
   * Skills within each category are maintained in their current sorted order.
   *
   * @param skills - Array of loaded skills to group
   * @returns Map of category display name to array of skills in that category
   */
  private groupByCategory(skills: LoadedSkill[]): Map<string, LoadedSkill[]> {
    const grouped = new Map<string, LoadedSkill[]>();

    for (const skill of skills) {
      const categoryKey = this.formatCategoryName(skill.definition.category);
      const existing = grouped.get(categoryKey) ?? [];
      existing.push(skill);
      grouped.set(categoryKey, existing);
    }

    // Sort categories alphabetically
    const sorted = new Map<string, LoadedSkill[]>(
      Array.from(grouped.entries()).sort(([a], [b]) => a.localeCompare(b))
    );

    return sorted;
  }

  /**
   * Format a raw category string into a display-friendly title.
   *
   * Capitalizes the first letter of each word and replaces hyphens/underscores
   * with spaces (e.g., "task-management" becomes "Task Management").
   *
   * @param category - Raw category string from skill.json
   * @returns Formatted category display name
   */
  private formatCategoryName(category: string): string {
    return category
      .split(/[-_\s]+/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  /**
   * Render the complete Markdown catalog document from grouped skills.
   *
   * Delegates to renderCatalogWithConfig() with orchestrator defaults.
   *
   * @param groupedSkills - Map of category name to skills in that category
   * @returns Complete Markdown document as a string
   */
  private renderCatalog(groupedSkills: Map<string, LoadedSkill[]>): string {
    // Use absolute path so skills work regardless of the orchestrator's cwd
    const absoluteSkillsPath = path.join(this.projectRoot, ORCHESTRATOR_SKILLS_RELATIVE_PATH);
    return this.renderCatalogWithConfig(groupedSkills, {
      title: 'Orchestrator Skills Catalog',
      skillsRelativePath: absoluteSkillsPath,
    });
  }

  /**
   * Render the complete Markdown catalog document from grouped skills
   * with configurable title and path prefix.
   *
   * Produces the full catalog including header, usage instructions,
   * category sections, and individual skill entries with descriptions
   * and parameter documentation extracted from instructions.md.
   *
   * @param groupedSkills - Map of category name to skills in that category
   * @param config - Catalog rendering configuration
   * @param config.title - Catalog title for the Markdown heading
   * @param config.skillsRelativePath - Relative path prefix for skill usage commands
   * @returns Complete Markdown document as a string
   */
  private renderCatalogWithConfig(
    groupedSkills: Map<string, LoadedSkill[]>,
    config: { title: string; skillsRelativePath: string }
  ): string {
    const timestamp = new Date().toISOString();
    const lines: string[] = [];

    // Header
    lines.push(`# ${config.title}`);
    lines.push(`> Auto-generated on ${timestamp}. Execute skills via bash scripts.`);
    lines.push('');

    // How to Use section
    lines.push('## How to Use');
    lines.push('');
    lines.push('All skills follow the pattern:');
    lines.push('```bash');
    lines.push(`bash ${config.skillsRelativePath}/{skill-name}/execute.sh '{"param":"value"}'`);
    lines.push('```');
    lines.push('All scripts output JSON to stdout. Errors go to stderr.');
    lines.push('');

    // Category sections
    for (const [categoryName, skills] of groupedSkills) {
      lines.push(`## ${categoryName}`);
      lines.push('');

      for (const skill of skills) {
        lines.push(...this.renderSkillEntry(skill, config.skillsRelativePath));
      }
    }

    return lines.join('\n');
  }

  /**
   * Render a single skill entry as Markdown lines.
   *
   * Includes the skill name, description, usage command, and any
   * Parameters section extracted from the skill's instructions.md.
   *
   * @param skill - The loaded skill to render
   * @param skillsRelativePath - Relative path prefix for usage command
   * @returns Array of Markdown lines for this skill entry
   */
  private renderSkillEntry(skill: LoadedSkill, skillsRelativePath: string = ORCHESTRATOR_SKILLS_RELATIVE_PATH): string[] {
    const lines: string[] = [];

    // Skill heading and description
    lines.push(`### ${skill.definition.name}`);
    lines.push(skill.definition.description);
    lines.push('');

    // Usage line — use the skill's basePath if it has one (marketplace skills),
    // otherwise fall back to the catalog-level skillsRelativePath (bundled skills)
    const effectivePath = skill.basePath || skillsRelativePath;
    lines.push(
      `**Usage:** \`bash ${effectivePath}/${skill.dirName}/execute.sh '{}'\``
    );
    lines.push('');

    // Extract and include Parameters section from instructions.md if available
    const parametersSection = this.extractParametersSection(skill.instructions);
    if (parametersSection) {
      lines.push(parametersSection);
      lines.push('');
    }

    // Separator
    lines.push('---');
    lines.push('');

    return lines;
  }

  /**
   * Extract the Parameters section from an instructions.md file's content.
   *
   * Uses a line-based approach to find the "## Parameters" heading and capture
   * all content until the next heading of the same or higher level (# or ##)
   * or the end of the file. Returns null if no Parameters section is found.
   *
   * @param instructionsContent - Full content of the instructions.md file
   * @returns The Parameters section content (without the heading), or null
   */
  private extractParametersSection(instructionsContent: string): string | null {
    if (!instructionsContent) {
      return null;
    }

    const lines = instructionsContent.split('\n');
    let capturing = false;
    const captured: string[] = [];

    for (const line of lines) {
      if (capturing) {
        // Stop capturing when we hit another heading (# or ##)
        if (HEADING_PATTERN.test(line)) {
          break;
        }
        captured.push(line);
      } else if (line.match(/^## Parameters\s*$/)) {
        // Start capturing after the Parameters heading
        capturing = true;
      }
    }

    if (!capturing || captured.length === 0) {
      return null;
    }

    const content = captured.join('\n').trim();
    if (content.length === 0) {
      return null;
    }

    return content;
  }
}
