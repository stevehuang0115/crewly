/**
 * Team Template Types
 *
 * Defines the structure for team templates — reusable team recipes
 * that include roles, hierarchy configuration, and verification pipelines.
 * Templates are stored in config/templates/ and loaded by TemplateService.
 *
 * @module types/team-template
 */

// =============================================================================
// Template Category
// =============================================================================

/**
 * Template categories matching common team types.
 */
export type TemplateCategory =
  | 'development'
  | 'content'
  | 'research'
  | 'operations'
  | 'custom';

export const TEMPLATE_CATEGORIES: TemplateCategory[] = [
  'development',
  'content',
  'research',
  'operations',
  'custom',
];

// =============================================================================
// Verification Types
// =============================================================================

/**
 * Verification methods available to Team Leaders.
 * Each method corresponds to a specific skill or tool chain.
 */
export type VerificationMethod =
  | 'quality_gates'
  | 'e2e_test'
  | 'code_review'
  | 'browser_test'
  | 'screenshot_review'
  | 'gemini_vision'
  | 'content_check'
  | 'fact_check'
  | 'source_verify'
  | 'data_validate'
  | 'manual_review'
  | 'custom_script';

export const VERIFICATION_METHODS: VerificationMethod[] = [
  'quality_gates',
  'e2e_test',
  'code_review',
  'browser_test',
  'screenshot_review',
  'gemini_vision',
  'content_check',
  'fact_check',
  'source_verify',
  'data_validate',
  'manual_review',
  'custom_script',
];

/**
 * A single verification step in the pipeline.
 */
export interface VerificationStep {
  /** Step identifier */
  id: string;
  /** Human-readable step name */
  name: string;
  /** Description of what this step verifies */
  description: string;
  /** Verification method */
  method: VerificationMethod;
  /** Whether this step is critical for overall pass/fail */
  critical: boolean;
  /** Step-specific configuration (depends on method) */
  config: Record<string, unknown>;
}

/**
 * Defines the verification steps the Team Leader executes
 * when reviewing worker output.
 */
export interface VerificationPipeline {
  /** Pipeline display name */
  name: string;
  /** Verification steps executed in order */
  steps: VerificationStep[];
  /**
   * Overall pass policy:
   * - 'all': All steps must pass
   * - 'majority': >50% of steps must pass
   * - 'critical_only': Only critical steps must pass
   */
  passPolicy: 'all' | 'majority' | 'critical_only';
  /** Maximum retry attempts for failed verification (default: 2) */
  maxRetries: number;
}

// =============================================================================
// Template Role
// =============================================================================

/**
 * A role definition within a template.
 */
/**
 * Defines what a team or member is responsible for.
 * Used at both team-level (team's overall scope) and member-level (individual focus areas).
 */
export interface OwnershipScope {
  /** Domain areas: "frontend", "backend", "infra", "data", "security" */
  domains: string[];
  /** What outcomes this owner delivers: "feature_delivery", "quality", "performance" */
  deliverables: string[];
  /** Specific product areas: "checkout-flow", "landing-page", "API gateway" */
  areas?: string[];
}

/**
 * Concrete delivery commitment — what the team accepts, avoids, and produces.
 * Replaces vague capability tags with actionable service definitions.
 */
export interface ServiceContract {
  /** Task types the team can handle: "mid-size product feature", "frontend bugfix" */
  accepts: string[];
  /** Task types the team should NOT handle: "production DBA changes", "security incident response" */
  avoids: string[];
  /** Expected deliverables: "PR", "test coverage report", "deployment notes" */
  expectedOutput: string[];
  /** Non-binding time estimates by complexity */
  slaHint?: {
    simpleTask?: string;      // e.g., "same day"
    mediumTask?: string;      // e.g., "1-3 days"
    complexTask?: string;     // e.g., "1-2 weeks"
  };
}

/** How this role holder is accountable — determines task routing and verification ownership. */
export type ResponsibilityType = 'delivery_owner' | 'quality_owner' | 'system_owner';

export interface TemplateRole {
  /** Role identifier (matches TeamMember.role) */
  role: string;
  /** Human-readable label for this position */
  label: string;
  /** Default member name */
  defaultName: string;
  /** Number of members with this role to create (default: 1) */
  count: number;
  /** Hierarchy level (0=orchestrator, 1=leader, 2=worker) */
  hierarchyLevel: number;
  /** Whether this role can delegate tasks to subordinates */
  canDelegate: boolean;
  /** Parent role identifier (undefined = reports to Orchestrator) */
  reportsTo?: string;
  /** Default skills assigned to this role */
  defaultSkills: string[];
  /** Skills to exclude from the role's default set */
  excludedSkills?: string[];
  /** Custom system prompt additions */
  promptAdditions?: string;
  /** AI runtime override for this role */
  runtimeOverride?: 'claude-code' | 'gemini-cli' | 'codex-cli' | 'crewly-agent';
  /** Whether to enable browser automation for this role */
  enableBrowser?: boolean;

  // --- Organization Model fields ---
  /** Job title for this position: "Frontend Tech Lead", "Backend Developer" */
  jobTitle?: string;
  /** What this position is responsible for in the team */
  jobDescription?: string;
  /** What domains/deliverables this role owns (primarily for TL roles) */
  ownershipScope?: OwnershipScope;
  /** Accountability type — determines routing and verification ownership */
  responsibilityType?: ResponsibilityType;
  /** Default autonomy level for members in this role */
  autonomyLevel?: 'directed' | 'bounded' | 'domain_autonomous';
}

// =============================================================================
// TeamTemplate
// =============================================================================

/**
 * A complete team recipe: roles, skills, hierarchy, and verification pipeline.
 */
export interface TeamTemplate {
  /** Unique template identifier (slug format) */
  id: string;
  /** Human-readable template name */
  name: string;
  /** Template description */
  description: string;
  /** Template category */
  category: TemplateCategory;
  /** Version string (semver) */
  version: string;
  /** Template author */
  author?: string;
  /** Tags for search/discovery */
  tags?: string[];
  /** Icon URL or emoji */
  icon?: string;
  /** Whether this template creates a hierarchical team */
  hierarchical: boolean;
  /** Role definitions with hierarchy configuration */
  roles: TemplateRole[];
  /** Default runtime for all members */
  defaultRuntime: 'claude-code' | 'gemini-cli' | 'codex-cli' | 'crewly-agent';
  /** Verification pipeline configuration */
  verificationPipeline: VerificationPipeline;
  /** Default monitoring configuration */
  monitoringDefaults?: {
    idleEvent: boolean;
    fallbackCheckMinutes: number;
  };
  /** Maximum workers per team leader */
  maxWorkersPerLeader?: number;
  /** Auto-assign tasks to idle workers */
  autoAssign?: boolean;
  /** Minimum cloud tier required to use this template (free if omitted) */
  requiredTier?: 'free' | 'pro' | 'enterprise';

  // --- Organization Model fields ---
  /** Team-level ownership scope — what this team is responsible for */
  ownershipScope?: OwnershipScope;
  /** Service contract — what the team accepts, avoids, and delivers */
  serviceContract?: ServiceContract;
  /** Team mission statement */
  mission?: string;
}

// =============================================================================
// Validators
// =============================================================================

/**
 * Check if a value is a valid TemplateCategory.
 *
 * @param value - Value to check
 * @returns True if valid
 */
export function isValidTemplateCategory(value: unknown): value is TemplateCategory {
  return typeof value === 'string' && TEMPLATE_CATEGORIES.includes(value as TemplateCategory);
}

/**
 * Check if a value is a valid VerificationMethod.
 *
 * @param value - Value to check
 * @returns True if valid
 */
export function isValidVerificationMethod(value: unknown): value is VerificationMethod {
  return typeof value === 'string' && VERIFICATION_METHODS.includes(value as VerificationMethod);
}

/**
 * Validate a VerificationStep object.
 *
 * @param value - Value to check
 * @returns True if valid
 */
export function isValidVerificationStep(value: unknown): value is VerificationStep {
  if (!value || typeof value !== 'object') return false;
  const step = value as Record<string, unknown>;
  return (
    typeof step.id === 'string' && step.id.length > 0 &&
    typeof step.name === 'string' && step.name.length > 0 &&
    typeof step.description === 'string' &&
    isValidVerificationMethod(step.method) &&
    typeof step.critical === 'boolean' &&
    step.config !== null && typeof step.config === 'object'
  );
}

/**
 * Validate a VerificationPipeline object.
 *
 * @param value - Value to check
 * @returns True if valid
 */
export function isValidVerificationPipeline(value: unknown): value is VerificationPipeline {
  if (!value || typeof value !== 'object') return false;
  const pipeline = value as Record<string, unknown>;
  if (typeof pipeline.name !== 'string' || pipeline.name.length === 0) return false;
  if (!Array.isArray(pipeline.steps) || pipeline.steps.length === 0) return false;
  if (!['all', 'majority', 'critical_only'].includes(pipeline.passPolicy as string)) return false;
  if (typeof pipeline.maxRetries !== 'number' || pipeline.maxRetries < 0) return false;
  return pipeline.steps.every((s: unknown) => isValidVerificationStep(s));
}

/**
 * Validate a TemplateRole object.
 *
 * @param value - Value to check
 * @returns True if valid
 */
export function isValidTemplateRole(value: unknown): value is TemplateRole {
  if (!value || typeof value !== 'object') return false;
  const role = value as Record<string, unknown>;
  return (
    typeof role.role === 'string' && role.role.length > 0 &&
    typeof role.label === 'string' && role.label.length > 0 &&
    typeof role.defaultName === 'string' && role.defaultName.length > 0 &&
    typeof role.count === 'number' && role.count >= 1 &&
    typeof role.hierarchyLevel === 'number' && role.hierarchyLevel >= 0 &&
    typeof role.canDelegate === 'boolean' &&
    Array.isArray(role.defaultSkills)
  );
}

/**
 * Validate a TeamTemplate object.
 *
 * @param value - Value to check
 * @returns True if valid
 */
export function isValidTeamTemplate(value: unknown): value is TeamTemplate {
  if (!value || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  if (typeof t.id !== 'string' || t.id.length === 0) return false;
  if (typeof t.name !== 'string' || t.name.length === 0) return false;
  if (typeof t.description !== 'string') return false;
  if (!isValidTemplateCategory(t.category)) return false;
  if (typeof t.version !== 'string') return false;
  if (typeof t.hierarchical !== 'boolean') return false;
  if (!Array.isArray(t.roles) || t.roles.length === 0) return false;
  if (!t.roles.every((r: unknown) => isValidTemplateRole(r))) return false;
  if (!['claude-code', 'gemini-cli', 'codex-cli', 'crewly-agent'].includes(t.defaultRuntime as string)) return false;
  if (!isValidVerificationPipeline(t.verificationPipeline)) return false;
  return true;
}
