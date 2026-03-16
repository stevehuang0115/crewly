/**
 * Marketplace Types for Frontend
 *
 * Mirrors backend marketplace types for type-safe API interactions.
 * Defines types for marketplace items including skills, models, and roles.
 *
 * @module types/marketplace
 */

/**
 * Type of marketplace item.
 * - skill: Reusable agent skill packages
 * - model: 3D models for the factory visualization
 * - role: Agent role definitions
 * - mcp_tool: MCP server tool packages
 */
export type MarketplaceItemType = 'skill' | 'model' | 'role' | 'mcp_tool';

/**
 * Sort options for marketplace listing.
 * - popular: Sort by download count descending
 * - rating: Sort by rating descending
 * - newest: Sort by creation date descending
 */
export type SortOption = 'popular' | 'rating' | 'newest';

/**
 * Asset references associated with a marketplace item.
 */
export interface MarketplaceItemAssets {
  /** URL or path to the item archive */
  archive?: string;
  /** Checksum for archive integrity verification */
  checksum?: string;
  /** Size of the archive in bytes */
  sizeBytes?: number;
  /** URL or path to a preview image */
  preview?: string;
  /** URL or path to a 3D model file (for model type items) */
  model?: string;
}

/**
 * Core marketplace item definition.
 */
export interface MarketplaceItem {
  /** Unique identifier */
  id: string;
  /** Item type (skill, model, or role) */
  type: MarketplaceItemType;
  /** Display name */
  name: string;
  /** Short description of the item */
  description: string;
  /** Author or publisher name */
  author: string;
  /** Semantic version string */
  version: string;
  /** Category for grouping (e.g., 'development', 'communication') */
  category: string;
  /** Searchable tags */
  tags: string[];
  /** License identifier (e.g., 'MIT', 'Apache-2.0') */
  license: string;
  /** Optional icon URL or emoji */
  icon?: string;
  /** Total download count */
  downloads: number;
  /** Average rating (0-5) */
  rating: number;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 last update timestamp */
  updatedAt: string;
  /** Associated asset references */
  assets: MarketplaceItemAssets;
  /** Additional type-specific metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Marketplace item with local installation status.
 * Extends the base item with install state for the current environment.
 */
export interface MarketplaceItemWithStatus extends MarketplaceItem {
  /** Current installation status */
  installStatus: 'not_installed' | 'installed' | 'update_available';
  /** Version currently installed locally, if any */
  installedVersion?: string;
}

/**
 * Valid marketplace item types list.
 */
export const MARKETPLACE_ITEM_TYPES: MarketplaceItemType[] = ['skill', 'model', 'role', 'mcp_tool'];

/**
 * Valid sort options list.
 */
export const SORT_OPTIONS: SortOption[] = ['popular', 'rating', 'newest'];

/**
 * Valid install status values.
 */
export const INSTALL_STATUSES = ['not_installed', 'installed', 'update_available'] as const;

/**
 * Check if a value is a valid marketplace item type.
 *
 * @param value - String to check
 * @returns True if value is a valid MarketplaceItemType
 */
export function isValidMarketplaceItemType(value: string): value is MarketplaceItemType {
  return MARKETPLACE_ITEM_TYPES.includes(value as MarketplaceItemType);
}

/**
 * Check if a value is a valid sort option.
 *
 * @param value - String to check
 * @returns True if value is a valid SortOption
 */
export function isValidSortOption(value: string): value is SortOption {
  return SORT_OPTIONS.includes(value as SortOption);
}

/**
 * Get display label for a marketplace item type.
 *
 * @param type - Marketplace item type
 * @returns Human-readable label
 */
export function getMarketplaceItemTypeLabel(type: MarketplaceItemType): string {
  const labels: Record<MarketplaceItemType, string> = {
    skill: 'Skill',
    model: '3D Model',
    role: 'Role',
    mcp_tool: 'MCP Tool',
  };
  return labels[type] || type;
}

/**
 * Get display label for a sort option.
 *
 * @param sort - Sort option
 * @returns Human-readable label
 */
export function getSortOptionLabel(sort: SortOption): string {
  const labels: Record<SortOption, string> = {
    popular: 'Popular',
    rating: 'Highest Rated',
    newest: 'Newest',
  };
  return labels[sort] || sort;
}
