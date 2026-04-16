/**
 * Expert Profile Types
 *
 * Types for expert profiles returned by GET /api/experts.
 *
 * @module types/expert.types
 */

/** Summary of an expert profile for display in selectors */
export interface ExpertSummary {
  /** Unique identifier matching the directory name */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Category grouping (e.g., "Customer Support", "Development") */
  category: string;
  /** Descriptive tags for the expert's skills */
  tags: string[];
  /** Roles this expert is designed for */
  baseRoles: string[];
}
