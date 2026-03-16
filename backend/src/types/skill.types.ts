/**
 * Skill Type Definitions
 *
 * Types for the Skills system, which evolves from the existing SOP
 * (Standard Operating Procedures) system. Skills combine prompts,
 * scripts, environment variables, and browser automation capabilities.
 *
 * @module types/skill.types
 */

/**
 * Skill category for grouping and filtering skills.
 * Includes both original categories and categories used by built-in skill.json files
 * (management, monitoring, memory, system, task-management, quality).
 */
export type SkillCategory =
  | 'development'
  | 'design'
  | 'communication'
  | 'research'
  | 'content-creation'
  | 'automation'
  | 'analysis'
  | 'integration'
  | 'management'
  | 'monitoring'
  | 'memory'
  | 'system'
  | 'task-management'
  | 'quality';

/**
 * Skill type - defines the nature of the skill
 * - mcp: MCP-related skills that require MCP installation or runtime flags
 * - claude-skill: Specialized domain knowledge with optional bash scripts
 * - web-page: Page-specific skills with domain knowledge and actions
 */
export type SkillType = 'mcp' | 'claude-skill' | 'web-page';

/**
 * Type of skill execution
 */
export type SkillExecutionType = 'script' | 'browser' | 'mcp-tool' | 'composite' | 'prompt-only';

/**
 * Script interpreter options
 */
export type ScriptInterpreter = 'bash' | 'python' | 'node';

/**
 * Script execution configuration
 */
export interface SkillScriptConfig {
  /** Path to the script file (.sh, .py, .js) */
  file: string;

  /** Script interpreter to use */
  interpreter: ScriptInterpreter;

  /** Working directory for script execution */
  workingDir?: string;

  /** Script timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * Browser automation configuration
 * Uses Claude's Chrome extension (claude-in-chrome MCP) for execution
 */
export interface SkillBrowserConfig {
  /** Target URL to navigate to */
  url: string;

  /** Natural language instructions for Claude to follow */
  instructions: string;

  /** Optional: specific actions to perform */
  actions?: string[];
}

/**
 * MCP tool invocation configuration
 */
export interface SkillMcpToolConfig {
  /** Name of the MCP tool to invoke */
  toolName: string;

  /** Default parameters for the tool */
  defaultParams?: Record<string, unknown>;
}

/**
 * Composite skill configuration (combines multiple skills)
 */
export interface SkillCompositeConfig {
  /** Ordered list of skill IDs to execute */
  skillSequence: string[];

  /** Whether to continue on error */
  continueOnError?: boolean;
}

/**
 * Skill execution configuration - only one type per skill
 */
export interface SkillExecutionConfig {
  /** Type of execution */
  type: SkillExecutionType;

  /** Script execution config (when type is 'script') */
  script?: SkillScriptConfig;

  /** Browser automation config (when type is 'browser') */
  browser?: SkillBrowserConfig;

  /** MCP tool config (when type is 'mcp-tool') */
  mcpTool?: SkillMcpToolConfig;

  /** Composite skill config (when type is 'composite') */
  composite?: SkillCompositeConfig;
}

/**
 * Environment variable configuration for skill execution
 */
export interface SkillEnvironmentConfig {
  /** Path to .env file (relative to skill directory) */
  file?: string;

  /** Inline environment variables */
  variables?: Record<string, string>;

  /** Required environment variables (will error if not set) */
  required?: string[];
}

/**
 * Runtime configuration for skills that modify agent startup
 */
export interface SkillRuntimeConfig {
  /** Runtime this skill is compatible with (e.g., 'claude-code') */
  runtime?: string;

  /** Additional flags to pass to the runtime (e.g., ['--chrome']) */
  flags?: string[];

  /** MCP servers required for this skill */
  requiredMcpServers?: string[];
}

/**
 * User notice configuration for skills
 */
export interface SkillNotice {
  /** Notice type for styling */
  type: 'info' | 'warning' | 'requirement';

  /** Notice title */
  title: string;

  /** Notice message */
  message: string;

  /** Optional link for more information */
  link?: string;

  /** Link text */
  linkText?: string;
}

/**
 * Full Skill definition
 */
export interface Skill {
  /** Unique identifier */
  id: string;

  /** Human-readable name */
  name: string;

  /** Detailed description of what this skill does */
  description: string;

  /** Category for grouping */
  category: SkillCategory;

  /** Type of skill (mcp, claude-skill, web-page) */
  skillType: SkillType;

  /** Path to .md file with detailed instructions */
  promptFile: string;

  /** Execution configuration (optional - prompt-only skills don't need this) */
  execution?: SkillExecutionConfig;

  /** Environment configuration */
  environment?: SkillEnvironmentConfig;

  /** Runtime configuration for agent startup modifications */
  runtime?: SkillRuntimeConfig;

  /** Notices to display to users (requirements, warnings, etc.) */
  notices?: SkillNotice[];

  /** Role IDs that can use this skill */
  assignableRoles: string[];

  /** Keywords for matching in prompts */
  triggers: string[];

  /** Searchable tags */
  tags: string[];

  /** Skill version for updates */
  version: string;

  /** Whether this is a built-in skill */
  isBuiltin: boolean;

  /** Whether this skill is enabled */
  isEnabled: boolean;

  /** Whether this skill was installed from the marketplace */
  isMarketplace?: boolean;

  /** Minimum cloud tier required to use this skill (defaults to 'free') */
  requiredTier?: string;

  /** Skill ID to use as a free-tier fallback when tier is insufficient */
  fallbackSkill?: string;

  /** ISO timestamp of creation */
  createdAt: string;

  /** ISO timestamp of last update */
  updatedAt: string;
}

/**
 * Skill with resolved prompt content
 */
export interface SkillWithPrompt extends Skill {
  /** The actual content of the prompt file */
  promptContent: string;
}

/**
 * Skill summary for list views
 */
export interface SkillSummary {
  /** Unique identifier */
  id: string;

  /** Human-readable name */
  name: string;

  /** Detailed description */
  description: string;

  /** Category for grouping */
  category: SkillCategory;

  /** Type of skill */
  skillType: SkillType;

  /** Type of execution */
  executionType: SkillExecutionType;

  /** Number of trigger keywords */
  triggerCount: number;

  /** Number of assignable roles */
  roleCount: number;

  /** Whether this is a built-in skill */
  isBuiltin: boolean;

  /** Whether this skill is enabled */
  isEnabled: boolean;

  /** Notices to display to users */
  notices?: SkillNotice[];

  /** Runtime configuration summary */
  runtime?: SkillRuntimeConfig;
}

/**
 * Input for creating a new skill
 */
export interface CreateSkillInput {
  /** Human-readable name */
  name: string;

  /** Detailed description */
  description: string;

  /** Category for grouping */
  category: SkillCategory;

  /** Type of skill */
  skillType?: SkillType;

  /** Prompt content (markdown) */
  promptContent: string;

  /** Execution configuration */
  execution?: SkillExecutionConfig;

  /** Environment configuration */
  environment?: SkillEnvironmentConfig;

  /** Runtime configuration */
  runtime?: SkillRuntimeConfig;

  /** Notices to display to users */
  notices?: SkillNotice[];

  /** Role IDs that can use this skill */
  assignableRoles?: string[];

  /** Keywords for matching in prompts */
  triggers?: string[];

  /** Searchable tags */
  tags?: string[];
}

/**
 * Input for updating a skill
 */
export interface UpdateSkillInput {
  /** Human-readable name */
  name?: string;

  /** Detailed description */
  description?: string;

  /** Category for grouping */
  category?: SkillCategory;

  /** Type of skill */
  skillType?: SkillType;

  /** Prompt content (markdown) */
  promptContent?: string;

  /** Execution configuration */
  execution?: SkillExecutionConfig;

  /** Environment configuration */
  environment?: SkillEnvironmentConfig;

  /** Runtime configuration */
  runtime?: SkillRuntimeConfig;

  /** Notices to display to users */
  notices?: SkillNotice[];

  /** Role IDs that can use this skill */
  assignableRoles?: string[];

  /** Keywords for matching in prompts */
  triggers?: string[];

  /** Searchable tags */
  tags?: string[];

  /** Whether this skill is enabled */
  isEnabled?: boolean;
}

/**
 * Filter options for querying skills
 */
export interface SkillFilter {
  /** Filter by category */
  category?: SkillCategory;

  /** Filter by execution type */
  executionType?: SkillExecutionType;

  /** Filter by assignable role ID */
  roleId?: string;

  /** Filter by builtin status */
  isBuiltin?: boolean;

  /** Filter by enabled status */
  isEnabled?: boolean;

  /** Search term for name/description */
  search?: string;

  /** Filter by tags */
  tags?: string[];
}

/**
 * Skill execution context - data passed when executing a skill
 */
export interface SkillExecutionContext {
  /** ID of the agent executing the skill */
  agentId: string;

  /** ID of the role the agent is using */
  roleId: string;

  /** Current project context */
  projectId?: string;

  /** Current task context */
  taskId?: string;

  /** User-provided input for the skill */
  userInput?: string;

  /** Additional context data */
  metadata?: Record<string, unknown>;
}

/**
 * Result of skill execution
 */
export interface SkillExecutionResult {
  /** Whether execution was successful */
  success: boolean;

  /** Output from the skill execution */
  output?: string;

  /** Error message if failed */
  error?: string;

  /** Execution duration in milliseconds */
  durationMs: number;

  /** Additional result data */
  data?: Record<string, unknown>;
}

/**
 * Storage format for skill JSON files
 */
export interface SkillStorageFormat {
  /** Unique identifier */
  id: string;

  /** Human-readable name */
  name: string;

  /** Detailed description */
  description: string;

  /** Category for grouping */
  category: SkillCategory;

  /** Type of skill */
  skillType: SkillType;

  /** Path to .md file with detailed instructions */
  promptFile: string;

  /** Execution configuration */
  execution?: SkillExecutionConfig;

  /** Environment configuration */
  environment?: SkillEnvironmentConfig;

  /** Runtime configuration */
  runtime?: SkillRuntimeConfig;

  /** Notices to display to users */
  notices?: SkillNotice[];

  /** Role IDs that can use this skill */
  assignableRoles: string[];

  /** Keywords for matching in prompts */
  triggers: string[];

  /** Searchable tags */
  tags: string[];

  /** Skill version for updates */
  version: string;

  /** ISO timestamp of creation */
  createdAt: string;

  /** ISO timestamp of last update */
  updatedAt: string;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Valid skill categories
 */
export const SKILL_CATEGORIES: SkillCategory[] = [
  'development',
  'design',
  'communication',
  'research',
  'content-creation',
  'automation',
  'analysis',
  'integration',
  'management',
  'monitoring',
  'memory',
  'system',
  'task-management',
  'quality',
];

/**
 * Display names for skill categories
 */
export const SKILL_CATEGORY_DISPLAY_NAMES: Record<SkillCategory, string> = {
  development: 'Development',
  design: 'Design',
  communication: 'Communication',
  research: 'Research',
  'content-creation': 'Content Creation',
  automation: 'Automation',
  analysis: 'Analysis',
  integration: 'Integration',
  management: 'Management',
  monitoring: 'Monitoring',
  memory: 'Memory',
  system: 'System',
  'task-management': 'Task Management',
  quality: 'Quality',
};

/**
 * Valid skill types
 */
export const SKILL_TYPES: SkillType[] = ['mcp', 'claude-skill', 'web-page'];

/**
 * Display names for skill types
 */
export const SKILL_TYPE_DISPLAY_NAMES: Record<SkillType, string> = {
  mcp: 'MCP Integration',
  'claude-skill': 'Claude Skill',
  'web-page': 'Web Page',
};

/**
 * Valid execution types
 */
export const EXECUTION_TYPES: SkillExecutionType[] = [
  'script',
  'browser',
  'mcp-tool',
  'composite',
  'prompt-only',
];

/**
 * Display names for execution types
 */
export const EXECUTION_TYPE_DISPLAY_NAMES: Record<SkillExecutionType, string> = {
  script: 'Script Execution',
  browser: 'Browser Automation',
  'mcp-tool': 'MCP Tool',
  composite: 'Composite Skill',
  'prompt-only': 'Prompt Only',
};

/**
 * Valid script interpreters
 */
export const SCRIPT_INTERPRETERS: ScriptInterpreter[] = ['bash', 'python', 'node'];

/**
 * Skill system constants
 */
export const SKILL_CONSTANTS = {
  /** Directory paths */
  PATHS: {
    SKILLS_DIR: 'skills',
    SYSTEM_SKILLS_DIR: 'system',
    CUSTOM_SKILLS_DIR: 'custom',
    INDEX_FILE: 'skills-index.json',
    PROMPTS_DIR: 'prompts',
  },

  /** Limits */
  LIMITS: {
    MAX_NAME_LENGTH: 100,
    MAX_DESCRIPTION_LENGTH: 500,
    MAX_PROMPT_LENGTH: 50000,
    MAX_TRIGGERS: 50,
    MAX_TAGS: 20,
    MAX_ASSIGNABLE_ROLES: 50,
    MAX_COMPOSITE_SKILLS: 10,
    DEFAULT_SCRIPT_TIMEOUT_MS: 60000,
    MAX_SCRIPT_TIMEOUT_MS: 300000,
  },

  /** Default values */
  DEFAULTS: {
    VERSION: '1.0.0',
    SCRIPT_TIMEOUT_MS: 60000,
    IS_ENABLED: true,
    IS_BUILTIN: false,
  },
} as const;

// =============================================================================
// Type Guard Functions
// =============================================================================

/**
 * Check if a value is a valid skill category
 *
 * @param value - Value to check
 * @returns True if value is a valid SkillCategory
 */
export function isValidSkillCategory(value: string): value is SkillCategory {
  return SKILL_CATEGORIES.includes(value as SkillCategory);
}

/**
 * Check if a value is a valid skill type
 *
 * @param value - Value to check
 * @returns True if value is a valid SkillType
 */
export function isValidSkillType(value: string): value is SkillType {
  return SKILL_TYPES.includes(value as SkillType);
}

/**
 * Check if a value is a valid execution type
 *
 * @param value - Value to check
 * @returns True if value is a valid SkillExecutionType
 */
export function isValidExecutionType(value: string): value is SkillExecutionType {
  return EXECUTION_TYPES.includes(value as SkillExecutionType);
}

/**
 * Check if a value is a valid script interpreter
 *
 * @param value - Value to check
 * @returns True if value is a valid ScriptInterpreter
 */
export function isValidScriptInterpreter(value: string): value is ScriptInterpreter {
  return SCRIPT_INTERPRETERS.includes(value as ScriptInterpreter);
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Create a skill with default values from minimal input
 *
 * @param input - Required input fields for creating a skill
 * @returns A complete Skill object with default values
 */
export function createDefaultSkill(
  input: Pick<CreateSkillInput, 'name' | 'description' | 'category' | 'promptContent'> & {
    skillType?: SkillType;
  }
): Skill {
  const now = new Date().toISOString();
  const id = `skill-${input.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;

  return {
    id,
    name: input.name,
    description: input.description,
    category: input.category,
    skillType: input.skillType ?? 'claude-skill',
    promptFile: `${id}/instructions.md`,
    assignableRoles: [],
    triggers: [],
    tags: [],
    version: SKILL_CONSTANTS.DEFAULTS.VERSION,
    isBuiltin: SKILL_CONSTANTS.DEFAULTS.IS_BUILTIN,
    isEnabled: SKILL_CONSTANTS.DEFAULTS.IS_ENABLED,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Convert a Skill to a SkillSummary for list views
 *
 * @param skill - Full skill object
 * @returns SkillSummary with derived fields
 */
export function skillToSummary(skill: Skill): SkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    category: skill.category,
    skillType: skill.skillType,
    executionType: skill.execution?.type ?? 'prompt-only',
    triggerCount: skill.triggers?.length ?? 0,
    roleCount: skill.assignableRoles?.length ?? 0,
    isBuiltin: skill.isBuiltin,
    isEnabled: skill.isEnabled,
    notices: skill.notices,
    runtime: skill.runtime,
  };
}

/**
 * Convert a Skill to storage format (omits isBuiltin since that's determined by location)
 *
 * @param skill - Full skill object
 * @returns SkillStorageFormat for JSON serialization
 */
export function skillToStorageFormat(skill: Skill): SkillStorageFormat {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    category: skill.category,
    skillType: skill.skillType,
    promptFile: skill.promptFile,
    execution: skill.execution,
    environment: skill.environment,
    runtime: skill.runtime,
    notices: skill.notices,
    assignableRoles: skill.assignableRoles,
    triggers: skill.triggers,
    tags: skill.tags,
    version: skill.version,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
}

/**
 * Convert storage format back to a Skill
 *
 * @param storage - Stored skill data
 * @param isBuiltin - Whether this skill comes from the system directory
 * @returns Full Skill object
 */
export function storageFormatToSkill(storage: SkillStorageFormat, isBuiltin: boolean): Skill {
  return {
    ...storage,
    skillType: storage.skillType ?? 'claude-skill', // Default for backward compatibility
    isBuiltin,
    isEnabled: true, // Default to enabled when loading
  };
}

/**
 * Get display name for a skill category
 *
 * @param category - Skill category
 * @returns Human-readable display name
 */
export function getSkillCategoryDisplayName(category: SkillCategory): string {
  return SKILL_CATEGORY_DISPLAY_NAMES[category] ?? category;
}

/**
 * Get display name for an execution type
 *
 * @param executionType - Execution type
 * @returns Human-readable display name
 */
export function getExecutionTypeDisplayName(executionType: SkillExecutionType): string {
  return EXECUTION_TYPE_DISPLAY_NAMES[executionType] ?? executionType;
}

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Validate CreateSkillInput
 *
 * @param input - Input to validate
 * @returns Array of error messages (empty if valid)
 */
export function validateCreateSkillInput(input: CreateSkillInput): string[] {
  const errors: string[] = [];

  // Required fields
  if (!input.name || input.name.trim().length === 0) {
    errors.push('Name is required');
  } else if (input.name.length > SKILL_CONSTANTS.LIMITS.MAX_NAME_LENGTH) {
    errors.push(`Name must be ${SKILL_CONSTANTS.LIMITS.MAX_NAME_LENGTH} characters or less`);
  }

  if (!input.description || input.description.trim().length === 0) {
    errors.push('Description is required');
  } else if (input.description.length > SKILL_CONSTANTS.LIMITS.MAX_DESCRIPTION_LENGTH) {
    errors.push(
      `Description must be ${SKILL_CONSTANTS.LIMITS.MAX_DESCRIPTION_LENGTH} characters or less`
    );
  }

  if (!isValidSkillCategory(input.category)) {
    errors.push(`Invalid category: ${input.category}`);
  }

  if (!input.promptContent || input.promptContent.trim().length === 0) {
    errors.push('Prompt content is required');
  } else if (input.promptContent.length > SKILL_CONSTANTS.LIMITS.MAX_PROMPT_LENGTH) {
    errors.push(
      `Prompt content must be ${SKILL_CONSTANTS.LIMITS.MAX_PROMPT_LENGTH} characters or less`
    );
  }

  // Optional fields validation
  if (input.triggers && input.triggers.length > SKILL_CONSTANTS.LIMITS.MAX_TRIGGERS) {
    errors.push(`Maximum ${SKILL_CONSTANTS.LIMITS.MAX_TRIGGERS} triggers allowed`);
  }

  if (input.tags && input.tags.length > SKILL_CONSTANTS.LIMITS.MAX_TAGS) {
    errors.push(`Maximum ${SKILL_CONSTANTS.LIMITS.MAX_TAGS} tags allowed`);
  }

  if (
    input.assignableRoles &&
    input.assignableRoles.length > SKILL_CONSTANTS.LIMITS.MAX_ASSIGNABLE_ROLES
  ) {
    errors.push(`Maximum ${SKILL_CONSTANTS.LIMITS.MAX_ASSIGNABLE_ROLES} assignable roles allowed`);
  }

  // Execution config validation
  if (input.execution) {
    errors.push(...validateSkillExecution(input.execution));
  }

  return errors;
}

/**
 * Validate UpdateSkillInput
 *
 * @param input - Input to validate
 * @returns Array of error messages (empty if valid)
 */
export function validateUpdateSkillInput(input: UpdateSkillInput): string[] {
  const errors: string[] = [];

  if (input.name !== undefined) {
    if (input.name.trim().length === 0) {
      errors.push('Name cannot be empty');
    } else if (input.name.length > SKILL_CONSTANTS.LIMITS.MAX_NAME_LENGTH) {
      errors.push(`Name must be ${SKILL_CONSTANTS.LIMITS.MAX_NAME_LENGTH} characters or less`);
    }
  }

  if (input.description !== undefined) {
    if (input.description.trim().length === 0) {
      errors.push('Description cannot be empty');
    } else if (input.description.length > SKILL_CONSTANTS.LIMITS.MAX_DESCRIPTION_LENGTH) {
      errors.push(
        `Description must be ${SKILL_CONSTANTS.LIMITS.MAX_DESCRIPTION_LENGTH} characters or less`
      );
    }
  }

  if (input.category !== undefined && !isValidSkillCategory(input.category)) {
    errors.push(`Invalid category: ${input.category}`);
  }

  if (input.promptContent !== undefined) {
    if (input.promptContent.trim().length === 0) {
      errors.push('Prompt content cannot be empty');
    } else if (input.promptContent.length > SKILL_CONSTANTS.LIMITS.MAX_PROMPT_LENGTH) {
      errors.push(
        `Prompt content must be ${SKILL_CONSTANTS.LIMITS.MAX_PROMPT_LENGTH} characters or less`
      );
    }
  }

  if (input.triggers && input.triggers.length > SKILL_CONSTANTS.LIMITS.MAX_TRIGGERS) {
    errors.push(`Maximum ${SKILL_CONSTANTS.LIMITS.MAX_TRIGGERS} triggers allowed`);
  }

  if (input.tags && input.tags.length > SKILL_CONSTANTS.LIMITS.MAX_TAGS) {
    errors.push(`Maximum ${SKILL_CONSTANTS.LIMITS.MAX_TAGS} tags allowed`);
  }

  if (
    input.assignableRoles &&
    input.assignableRoles.length > SKILL_CONSTANTS.LIMITS.MAX_ASSIGNABLE_ROLES
  ) {
    errors.push(`Maximum ${SKILL_CONSTANTS.LIMITS.MAX_ASSIGNABLE_ROLES} assignable roles allowed`);
  }

  if (input.execution) {
    errors.push(...validateSkillExecution(input.execution));
  }

  return errors;
}

/**
 * Validate skill execution configuration
 *
 * @param config - Execution configuration to validate
 * @returns Array of error messages (empty if valid)
 */
export function validateSkillExecution(config: SkillExecutionConfig): string[] {
  const errors: string[] = [];

  if (!isValidExecutionType(config.type)) {
    errors.push(`Invalid execution type: ${config.type}`);
    return errors;
  }

  switch (config.type) {
    case 'script':
      if (!config.script) {
        errors.push('Script configuration required for script type');
      } else {
        if (!config.script.file || config.script.file.trim().length === 0) {
          errors.push('Script file path is required');
        }
        if (!isValidScriptInterpreter(config.script.interpreter)) {
          errors.push(`Invalid script interpreter: ${config.script.interpreter}`);
        }
        if (
          config.script.timeoutMs !== undefined &&
          config.script.timeoutMs > SKILL_CONSTANTS.LIMITS.MAX_SCRIPT_TIMEOUT_MS
        ) {
          errors.push(
            `Script timeout cannot exceed ${SKILL_CONSTANTS.LIMITS.MAX_SCRIPT_TIMEOUT_MS}ms`
          );
        }
      }
      break;

    case 'browser':
      if (!config.browser) {
        errors.push('Browser configuration required for browser type');
      } else {
        if (!config.browser.url || config.browser.url.trim().length === 0) {
          errors.push('Browser URL is required');
        }
        if (!config.browser.instructions || config.browser.instructions.trim().length === 0) {
          errors.push('Browser instructions are required');
        }
      }
      break;

    case 'mcp-tool':
      if (!config.mcpTool) {
        errors.push('MCP tool configuration required for mcp-tool type');
      } else if (!config.mcpTool.toolName || config.mcpTool.toolName.trim().length === 0) {
        errors.push('MCP tool name is required');
      }
      break;

    case 'composite':
      if (!config.composite) {
        errors.push('Composite configuration required for composite type');
      } else {
        if (!config.composite.skillSequence || config.composite.skillSequence.length === 0) {
          errors.push('Composite skill must have at least one skill in sequence');
        } else if (
          config.composite.skillSequence.length > SKILL_CONSTANTS.LIMITS.MAX_COMPOSITE_SKILLS
        ) {
          errors.push(
            `Composite skill cannot have more than ${SKILL_CONSTANTS.LIMITS.MAX_COMPOSITE_SKILLS} skills`
          );
        }
      }
      break;

    case 'prompt-only':
      // No additional config required for prompt-only
      break;
  }

  return errors;
}

/**
 * Check if a skill matches the given filter
 *
 * @param skill - Skill to check
 * @param filter - Filter criteria
 * @returns True if skill matches all filter criteria
 */
export function matchesSkillFilter(skill: Skill, filter: SkillFilter): boolean {
  if (filter.category !== undefined && skill.category !== filter.category) {
    return false;
  }

  if (filter.executionType !== undefined) {
    const skillType = skill.execution?.type ?? 'prompt-only';
    if (skillType !== filter.executionType) {
      return false;
    }
  }

  if (filter.roleId !== undefined && !skill.assignableRoles.includes(filter.roleId)) {
    return false;
  }

  if (filter.isBuiltin !== undefined && skill.isBuiltin !== filter.isBuiltin) {
    return false;
  }

  if (filter.isEnabled !== undefined && skill.isEnabled !== filter.isEnabled) {
    return false;
  }

  if (filter.search !== undefined && filter.search.trim().length > 0) {
    const searchLower = filter.search.toLowerCase();
    const matchesName = skill.name.toLowerCase().includes(searchLower);
    const matchesDescription = skill.description.toLowerCase().includes(searchLower);
    const matchesTriggers = skill.triggers.some((t) => t.toLowerCase().includes(searchLower));
    if (!matchesName && !matchesDescription && !matchesTriggers) {
      return false;
    }
  }

  if (filter.tags !== undefined && filter.tags.length > 0) {
    const hasAllTags = filter.tags.every((tag) =>
      skill.tags.some((t) => t.toLowerCase() === tag.toLowerCase())
    );
    if (!hasAllTags) {
      return false;
    }
  }

  return true;
}
