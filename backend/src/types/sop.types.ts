/**
 * Standard Operating Procedure (SOP) Type Definitions
 *
 * Types for defining, storing, and matching SOPs that guide
 * agent behavior with standardized procedures.
 *
 * @module types/sop.types
 */

/**
 * Roles that can have associated SOPs
 */
export type SOPRole =
  | 'orchestrator'
  | 'pm'
  | 'tpm'
  | 'pgm'
  | 'developer'
  | 'frontend-developer'
  | 'backend-developer'
  | 'qa'
  | 'tester'
  | 'designer'
  | 'devops';

/**
 * Categories of SOPs
 */
export type SOPCategory =
  | 'workflow' // How to do things
  | 'quality' // Quality standards
  | 'communication' // How to communicate
  | 'escalation' // When to escalate
  | 'tools' // How to use tools
  | 'debugging' // How to debug
  | 'testing' // Testing procedures
  | 'git' // Git workflows
  | 'security'; // Security practices

/**
 * Condition operator for SOP activation
 */
export type SOPConditionOperator = 'equals' | 'contains' | 'matches';

/**
 * Condition type for SOP activation
 */
export type SOPConditionType = 'task-type' | 'file-pattern' | 'project-type' | 'custom';

/**
 * Condition for SOP activation
 */
export interface SOPCondition {
  /** Type of condition */
  type: SOPConditionType;
  /** Value to check against */
  value: string;
  /** Comparison operator */
  operator: SOPConditionOperator;
}

/**
 * Example demonstrating correct SOP usage
 */
export interface SOPExample {
  /** Example title */
  title: string;
  /** Scenario description */
  scenario: string;
  /** How to correctly handle this scenario */
  correctApproach: string;
  /** How NOT to handle this scenario */
  incorrectApproach?: string;
}

/**
 * Complete SOP definition
 */
export interface SOP {
  // Identity
  /** Unique SOP identifier */
  id: string;
  /** Version number (increments on updates) */
  version: number;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
  /** Creator: 'system' or agentId */
  createdBy: string;

  // Classification
  /** Role this SOP applies to, or 'all' for universal */
  role: SOPRole | 'all';
  /** Category of the SOP */
  category: SOPCategory;
  /** Priority (higher = more important) */
  priority: number;

  // Content
  /** Short title */
  title: string;
  /** Brief description */
  description: string;
  /** Full SOP content in Markdown */
  content: string;

  // Activation
  /** Keywords that trigger this SOP */
  triggers: string[];
  /** Optional conditions for activation */
  conditions?: SOPCondition[];

  // Metadata
  /** Categorization tags */
  tags: string[];
  /** IDs of related SOPs */
  relatedSOPs?: string[];
  /** Usage examples */
  examples?: SOPExample[];
}

/**
 * Entry in the SOP index for fast lookup
 */
export interface SOPIndexEntry {
  /** SOP identifier */
  id: string;
  /** Relative path to the SOP file */
  path: string;
  /** Role this SOP applies to */
  role: SOPRole | 'all';
  /** Category of the SOP */
  category: SOPCategory;
  /** Priority (higher = more important) */
  priority: number;
  /** Keywords that trigger this SOP */
  triggers: string[];
  /** Short title */
  title: string;
  /** Whether this is a system SOP (true) or custom (false) */
  isSystem: boolean;
}

/**
 * Complete SOP index
 */
export interface SOPIndex {
  /** Index format version */
  version: string;
  /** ISO timestamp of last update */
  lastUpdated: string;
  /** All indexed SOPs */
  sops: SOPIndexEntry[];
}

/**
 * Parameters for finding relevant SOPs
 */
export interface SOPMatchParams {
  /** Agent role */
  role: string;
  /** Current task context */
  taskContext: string;
  /** Type of task being performed */
  taskType?: string;
  /** File patterns involved */
  filePatterns?: string[];
  /** Maximum number of SOPs to return */
  limit?: number;
  /**
   * Team whose installed/custom SOP library should also be surfaced. When set,
   * SOPs under `~/.crewly/teams/<teamId>/sops/` (written by the wiki `+ SOP`
   * editor / `update-sop` skill) are merged into the result — closing the
   * write-to-team-library / read-from-global-store mismatch.
   */
  teamId?: string;
}

/**
 * Interface for SOP matching logic
 */
export interface ISOPMatcher {
  /**
   * Find SOPs relevant to the given context
   *
   * @param params - Match parameters
   * @returns Array of matching SOPs, sorted by relevance
   */
  findRelevant(params: SOPMatchParams): Promise<SOP[]>;

  /**
   * Score how relevant an SOP is to the given context
   *
   * @param sop - SOP index entry to score
   * @param context - Context string
   * @returns Relevance score (0-1)
   */
  scoreRelevance(sop: SOPIndexEntry, context: string): number;
}

/**
 * SOP file frontmatter (YAML header)
 */
export interface SOPFrontmatter {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  role: SOPRole | 'all';
  category: SOPCategory;
  priority: number;
  title: string;
  description: string;
  triggers: string[];
  conditions?: SOPCondition[];
  tags: string[];
  relatedSOPs?: string[];
}

/**
 * Result of parsing an SOP file
 */
export interface ParsedSOP {
  /** Parsed frontmatter */
  frontmatter: SOPFrontmatter;
  /** Markdown content (without frontmatter) */
  content: string;
  /** Parsed examples (if present) */
  examples?: SOPExample[];
}

/**
 * SOP constants
 */
export const SOP_CONSTANTS = {
  /** Directory names */
  PATHS: {
    SOP_DIR: 'sops',
    SYSTEM_SOP_DIR: 'system',
    CUSTOM_SOP_DIR: 'custom',
    INDEX_FILE: 'index.json',
  },

  /** Limits */
  LIMITS: {
    MAX_SOPS_IN_PROMPT: 5,
    MAX_SOP_CONTENT_LENGTH: 2000,
    MAX_TRIGGERS_PER_SOP: 20,
    MAX_CONDITIONS_PER_SOP: 10,
    MAX_EXAMPLES_PER_SOP: 5,
  },

  /** Matching configuration */
  MATCHING: {
    MIN_TRIGGER_MATCH_SCORE: 0.3,
    DEFAULT_PRIORITY: 5,
    ROLE_MATCH_BOOST: 0.3,
    CATEGORY_MATCH_BOOST: 0.2,
  },

  /** Index version */
  INDEX_VERSION: '1.0',
} as const;

/**
 * Default SOP categories organized by role
 */
export const DEFAULT_SOP_CATEGORIES: Record<SOPRole | 'all', SOPCategory[]> = {
  all: ['communication', 'escalation', 'security'],
  orchestrator: ['workflow', 'communication', 'escalation'],
  pm: ['workflow', 'communication', 'quality'],
  tpm: ['workflow', 'communication', 'quality'],
  pgm: ['workflow', 'communication', 'quality'],
  developer: ['workflow', 'quality', 'git', 'testing', 'debugging'],
  'frontend-developer': ['workflow', 'quality', 'git', 'testing', 'debugging'],
  'backend-developer': ['workflow', 'quality', 'git', 'testing', 'debugging', 'security'],
  qa: ['testing', 'quality', 'debugging', 'communication'],
  tester: ['testing', 'quality', 'debugging', 'communication'],
  designer: ['workflow', 'communication', 'tools'],
  devops: ['workflow', 'security', 'tools', 'debugging'],
};

/**
 * All valid SOP roles
 */
export const ALL_SOP_ROLES: SOPRole[] = [
  'orchestrator',
  'pm',
  'tpm',
  'pgm',
  'developer',
  'frontend-developer',
  'backend-developer',
  'qa',
  'tester',
  'designer',
  'devops',
];

/**
 * All valid SOP categories
 */
export const ALL_SOP_CATEGORIES: SOPCategory[] = [
  'workflow',
  'quality',
  'communication',
  'escalation',
  'tools',
  'debugging',
  'testing',
  'git',
  'security',
];
