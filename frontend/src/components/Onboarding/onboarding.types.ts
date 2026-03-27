/**
 * Onboarding Wizard Types
 *
 * Shared type definitions for the onboarding wizard components.
 *
 * @module components/Onboarding/onboarding.types
 */

/** Role definition within a template */
export interface TemplateRole {
  /** Machine role identifier */
  role: string;
  /** Human-readable label */
  label: string;
  /** Default display name */
  defaultName: string;
  /** Runtime engine (e.g., "claude-code", "gemini-cli") */
  runtime?: string;
  /** Brief description of this role's responsibilities */
  description?: string;
}

/** Template metadata returned from GET /api/templates */
export interface TemplateInfo {
  /** Unique template identifier (e.g. "dev-fullstack") */
  id: string;
  /** Display name */
  name: string;
  /** Brief description */
  description: string;
  /** Category for grouping (e.g. "development", "content") */
  category: string;
  /** Icon identifier (lucide icon name or emoji) */
  icon: string;
  /** Role definitions for team members */
  roles: TemplateRole[];
  /** Tags for search/filter */
  tags?: string[];
}

/** Internal state of the onboarding wizard */
export interface OnboardingState {
  /** Whether the user has connected to Crewly Cloud */
  cloudConnected: boolean;
  /** Selected template (null if none chosen yet) */
  selectedTemplate: TemplateInfo | null;
  /** Custom team name (defaults to template name) */
  teamName: string;
  /** Project directory path for the first project */
  projectPath: string;
  /** Whether the final creation request is in-flight */
  isCreating: boolean;
  /** Error message from creation attempt */
  error: string | null;
}
