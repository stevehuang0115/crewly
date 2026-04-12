/**
 * Data Architecture V2.2 — Core Type Definitions
 *
 * Defines the Unified DataObject Model, Schema Governance types,
 * and Sink Ecosystem types used across the data fabric layer.
 *
 * @module types/data-object.types
 */

// ---------------------------------------------------------------------------
// DataObject — the unified model for all structured data in Crewly V2
// ---------------------------------------------------------------------------

/** Discriminates the kind of data stored in a DataObject */
export type DataObjectType = 'memory' | 'knowledge' | 'sink_entry';

/** Visibility / ownership scope */
export type DataObjectScope = 'agent' | 'project' | 'global';

/** Lifecycle state every DataObject must transition through */
export type DataObjectStatus = 'new' | 'processed' | 'archived';

/** Local-vs-cloud synchronisation state */
export type SyncState = 'local' | 'synced' | 'conflict';

/**
 * Metadata attached to every DataObject.
 */
export interface DataObjectMetadata {
  created_at: string;
  updated_at: string;
  source_thread_id?: string;
  confidence_score?: number;
  tags: string[];
}

/**
 * The unified, polymorphic data record at the heart of V2.
 */
export interface DataObject {
  id: string;
  type: DataObjectType;
  scope: DataObjectScope;
  schema_id: string;
  status: DataObjectStatus;
  owner_id: string;
  payload: Record<string, unknown>;
  metadata: DataObjectMetadata;
  sync_state: SyncState;
}

// ---------------------------------------------------------------------------
// Schema & Governance Layer
// ---------------------------------------------------------------------------

/** Primitive types a schema field can declare */
export type SchemaFieldType = 'string' | 'number' | 'boolean' | 'array' | 'datetime' | 'enum';

/**
 * A single field inside a SchemaDefinition.
 */
export interface SchemaField {
  /** JS typeof the value should match (or special: 'array', 'datetime', 'enum') */
  type: SchemaFieldType;
  /** Whether the field must be present and non-null */
  required?: boolean;
  /** Maximum string length (only for type 'string') */
  max_length?: number;
  /** Allowed enum values (only for type 'enum') */
  options?: string[];
  /** Type of array items (only for type 'array') */
  item_type?: string;
  /** Minimum array length (only for type 'array') */
  min_items?: number;
}

/** Validation strictness applied when writing data */
export type ValidationLevel = 'strict' | 'permissive';

/**
 * Controls who can write to a sink and how data is validated.
 */
export interface WritePolicy {
  allow_unstructured: boolean;
  validation_level: ValidationLevel;
  auto_archive_after_days?: number;
}

/**
 * A full schema declaration loaded from a sink's schema file.
 */
export interface SchemaDefinition {
  id: string;
  name: string;
  fields: Record<string, SchemaField>;
  write_policy: WritePolicy;
}

// ---------------------------------------------------------------------------
// Sink Ecosystem
// ---------------------------------------------------------------------------

/**
 * A registered data sink (destination for structured data).
 */
export interface SinkDefinition {
  id: string;
  name: string;
  description?: string;
  schema_id: string;
  tags: string[];
  /** Directory name under sinks/ where data files are stored */
  directory: string;
}

// ---------------------------------------------------------------------------
// Validation Results
// ---------------------------------------------------------------------------

/**
 * Describes a single validation failure.
 */
export interface ValidationError {
  field: string;
  message: string;
  rule: string;
}

/**
 * Result of validating a payload against a schema.
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Paths relative to a project root used by the data layer */
export const DATA_CONSTANTS = {
  /** Directory containing sink data and schemas */
  SINKS_DIR: 'sinks',
  /** Registry file listing all sinks */
  SINKS_REGISTRY_FILE: '_sinks.json',
  /** Sub-directory for each sink's schema file */
  SCHEMA_FILE: '_schema.json',
  /** Catch-all inbox for unmatched data */
  INBOX_DIR: '_inbox',
} as const;
