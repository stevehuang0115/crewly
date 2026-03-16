/**
 * Marketplace type definitions for browsing, installing, and managing
 * marketplace items (skills, roles, 3D models) from the Crewly registry.
 */

export type MarketplaceItemType = 'skill' | 'model' | 'role' | 'mcp_tool';

export type MarketplaceCategory =
  | 'development'
  | 'design'
  | 'communication'
  | 'research'
  | 'content-creation'
  | 'automation'
  | 'analysis'
  | 'integration'
  | 'quality'
  | 'security'
  | '3d-model';

export type SortOption = 'popular' | 'rating' | 'newest';

export interface MarketplaceItemAssets {
  archive?: string;
  checksum?: string;
  sizeBytes?: number;
  preview?: string;
  model?: string;
}

export interface MarketplaceItem {
  id: string;
  type: MarketplaceItemType;
  name: string;
  description: string;
  author: string;
  version: string;
  category: MarketplaceCategory;
  tags: string[];
  license: string;
  icon?: string;
  downloads: number;
  rating: number;
  createdAt: string;
  updatedAt: string;
  assets: MarketplaceItemAssets;
  metadata?: Record<string, unknown>;
}

export interface MarketplaceRegistry {
  schemaVersion: number;
  lastUpdated: string;
  cdnBaseUrl: string;
  items: MarketplaceItem[];
}

export interface MarketplaceFilter {
  type?: MarketplaceItemType;
  category?: MarketplaceCategory;
  search?: string;
  sortBy?: SortOption;
}

export type InstallStatus = 'not_installed' | 'installed' | 'update_available';

export interface MarketplaceItemWithStatus extends MarketplaceItem {
  installStatus: InstallStatus;
  installedVersion?: string;
}

export interface InstalledItemRecord {
  id: string;
  type: MarketplaceItemType;
  name: string;
  version: string;
  installedAt: string;
  installPath: string;
  checksum?: string;
}

export interface InstalledItemsManifest {
  schemaVersion: number;
  items: InstalledItemRecord[];
}

export interface MarketplaceOperationResult {
  success: boolean;
  message: string;
  item?: InstalledItemRecord;
}

/** Status of a marketplace submission */
export type SubmissionStatus = 'pending' | 'approved' | 'rejected';

/** A skill submission awaiting review */
export interface MarketplaceSubmission {
  /** Unique submission ID */
  id: string;
  /** Skill metadata from skill.json */
  skillId: string;
  name: string;
  description: string;
  author: string;
  version: string;
  category: MarketplaceCategory;
  tags: string[];
  license: string;
  /** Review status */
  status: SubmissionStatus;
  /** Path to the uploaded archive on disk */
  archivePath: string;
  /** SHA-256 checksum of the archive */
  checksum: string;
  /** Archive size in bytes */
  sizeBytes: number;
  /** Metadata from skill.json */
  metadata?: Record<string, unknown>;
  /** ISO timestamp of submission */
  submittedAt: string;
  /** ISO timestamp of review */
  reviewedAt?: string;
  /** Review notes (for rejections) */
  reviewNotes?: string;
}

/** Local submissions store */
export interface SubmissionsManifest {
  schemaVersion: number;
  submissions: MarketplaceSubmission[];
}

// ========================= TEMPLATE MARKETPLACE =========================

/** Lifecycle status for a marketplace template */
export type PublishStatus = 'draft' | 'review' | 'published' | 'archived';

/** Template category for team configuration templates */
export type TemplateCategory =
  | 'content-creation'
  | 'development'
  | 'marketing'
  | 'operations'
  | 'research'
  | 'support'
  | 'design'
  | 'sales'
  | 'custom';

/** Pricing model for a marketplace template */
export interface TemplatePricing {
  /** Whether the template is free */
  isFree: boolean;
  /** Price in USD cents (0 for free templates) */
  priceUsdCents: number;
  /** Subscription tier required (free = no restriction) */
  requiredTier: 'free' | 'pro' | 'enterprise';
}

/** A single version of a template */
export interface TemplateVersion {
  /** Unique version identifier */
  versionId: string;
  /** Parent template ID */
  templateId: string;
  /** Semantic version string (e.g. "1.0.0") */
  semver: string;
  /** Team configuration JSON (roles, skills, workflows) */
  config: Record<string, unknown>;
  /** Changelog describing what changed in this version */
  changelog: string;
  /** ISO timestamp of version creation */
  createdAt: string;
}

/** A marketplace template (team configuration blueprint) */
export interface MarketplaceTemplate {
  /** Unique template identifier */
  id: string;
  /** Human-readable template name */
  name: string;
  /** Detailed description of what this template provides */
  description: string;
  /** Template author name */
  author: string;
  /** Template category */
  category: TemplateCategory;
  /** Searchable tags */
  tags: string[];
  /** Pricing information */
  pricing: TemplatePricing;
  /** Current publish status */
  status: PublishStatus;
  /** Current version semver (latest published or latest draft) */
  currentVersion: string;
  /** Total download/install count */
  downloads: number;
  /** Average rating (0-5) */
  rating: number;
  /** ISO timestamp of template creation */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
  /** Optional icon URL or emoji */
  icon?: string;
  /** Arbitrary metadata (e.g. content-type specifics) */
  metadata?: Record<string, unknown>;
}

/** Filter criteria for listing templates */
export interface TemplateFilter {
  /** Filter by category */
  category?: TemplateCategory;
  /** Filter by publish status */
  status?: PublishStatus;
  /** Free-text search (name, description, tags) */
  search?: string;
  /** Filter by author */
  author?: string;
  /** Sort order */
  sortBy?: 'popular' | 'rating' | 'newest';
}

/** Result of a template operation */
export interface TemplateOperationResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Human-readable result message */
  message: string;
  /** The template involved, if applicable */
  template?: MarketplaceTemplate;
  /** The version involved, if applicable */
  version?: TemplateVersion;
}

/** On-disk store for templates */
export interface TemplateStore {
  /** Schema version for forward compatibility */
  schemaVersion: number;
  /** All templates */
  templates: MarketplaceTemplate[];
}

/** On-disk store for template versions */
export interface TemplateVersionStore {
  /** Schema version for forward compatibility */
  schemaVersion: number;
  /** All versions for a single template */
  versions: TemplateVersion[];
}
