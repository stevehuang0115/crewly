/**
 * Data Architecture V2.2 — Unified DataObject Model (UDM)
 *
 * Defines the core types for the structured data fabric:
 * DataObject, SchemaDefinition, SinkDefinition, and related types.
 *
 * @see specs/crewly-data-architecture-v2.md
 */

// ---------------------------------------------------------------------------
// Enums & Literal Types
// ---------------------------------------------------------------------------

/** The kind of data stored in a DataObject */
export type DataObjectType = 'memory' | 'knowledge' | 'sink_entry';

/** Visibility / ownership scope */
export type DataObjectScope = 'agent' | 'project' | 'global';

/** Lifecycle status of a DataObject */
export type DataObjectStatus = 'new' | 'processed' | 'archived';

/** Synchronisation state between local and cloud */
export type SyncState = 'local' | 'synced' | 'conflict';

/** Primitive types accepted by schema fields */
export type SchemaFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'array'
  | 'datetime'
  | 'object';

/** How strictly payload validation is applied */
export type ValidationLevel = 'strict' | 'loose' | 'none';

/** Whether a sink stores a finite collection or an append-only log */
export type SinkType = 'collection' | 'log';

/** Serialisation format used by a sink on disk */
export type SinkFormat = 'markdown' | 'json' | 'jsonl';

// ---------------------------------------------------------------------------
// DataObject
// ---------------------------------------------------------------------------

/**
 * Metadata attached to every DataObject.
 *
 * Captures provenance, confidence, and free-form tags for filtering.
 */
export interface DataObjectMetadata {
  /** ISO-8601 creation timestamp */
  created_at: string;
  /** ISO-8601 last-update timestamp */
  updated_at: string;
  /** Thread / conversation that produced this object (optional) */
  source_thread_id?: string;
  /** AI-assigned confidence in the payload accuracy (0-1, optional) */
  confidence_score?: number;
  /** Free-form classification tags */
  tags: string[];
}

/**
 * The Unified DataObject — the single polymorphic model that replaces
 * separate Memory, Knowledge, and Sink-entry tables.
 *
 * Every persisted piece of information in Crewly V2 is a DataObject.
 */
export interface DataObject {
  /** UUID v4 unique identifier */
  id: string;
  /** Discriminator: what kind of data this is */
  type: DataObjectType;
  /** Ownership scope — agent, project, or global */
  scope: DataObjectScope;
  /** Reference to the SchemaDefinition that governs this object's payload */
  schema_id: string;
  /** Lifecycle status */
  status: DataObjectStatus;
  /** Agent ID or User ID that owns this object */
  owner_id: string;
  /** Hierarchical namespace, e.g. "marketing/steve-inputs" */
  namespace: string;
  /** The actual data — shape governed by the referenced schema */
  payload: Record<string, unknown>;
  /** Provenance and classification metadata */
  metadata: DataObjectMetadata;
  /** Local/cloud sync state */
  sync_state: SyncState;
}

// ---------------------------------------------------------------------------
// Schema & Governance
// ---------------------------------------------------------------------------

/**
 * Describes a single field inside a SchemaDefinition.
 */
export interface SchemaField {
  /** Primitive type of the field */
  type: SchemaFieldType;
  /** Whether the field must be present in every payload (default false) */
  required?: boolean;
  /** Maximum character length (applies to string fields) */
  max_length?: number;
  /** Allowed values (applies to enum fields) */
  options?: string[];
  /** Element type when field type is "array" */
  item_type?: string;
  /** Minimum number of elements when field type is "array" */
  min_items?: number;
}

/**
 * Controls how strictly writes are validated against a schema.
 */
export interface WritePolicy {
  /** If true, payloads without a matching schema are still accepted */
  allow_unstructured: boolean;
  /** How strictly the schema is enforced */
  validation_level: ValidationLevel;
  /** Auto-archive objects older than this many days (optional) */
  auto_archive_after_days?: number;
}

/**
 * Defines the structure and governance rules for a category of DataObjects.
 */
export interface SchemaDefinition {
  /** Unique schema identifier, e.g. "schema-steve-input-v1" */
  id: string;
  /** Human-readable name */
  name: string;
  /** Semantic version string */
  version: string;
  /** Field definitions keyed by field name */
  fields: Record<string, SchemaField>;
  /** Controls validation behaviour on writes */
  write_policy: WritePolicy;
}

// ---------------------------------------------------------------------------
// Sink
// ---------------------------------------------------------------------------

/**
 * A SinkDefinition declares where a particular category of DataObjects
 * is persisted and who is responsible for writing to it.
 */
export interface SinkDefinition {
  /** Unique sink identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Whether the sink is a bounded collection or an append-only log */
  type: SinkType;
  /** Relative file path for on-disk storage */
  path: string;
  /** Serialisation format */
  format: SinkFormat;
  /** Optional reference to a governing schema */
  schema_id?: string;
  /** Agent session name that has exclusive write access */
  responsible_agent: string;
  /** Agent session names to notify on new writes */
  notify: string[];
  /** Human-readable description of the sink's purpose */
  description: string;
}

// ---------------------------------------------------------------------------
// Input / Filter helpers
// ---------------------------------------------------------------------------

/**
 * Input shape for creating a new DataObject.
 * The store generates `id`, timestamps, and defaults.
 */
export interface CreateDataObjectInput {
  type: DataObjectType;
  scope: DataObjectScope;
  schema_id: string;
  owner_id: string;
  namespace: string;
  payload: Record<string, unknown>;
  tags?: string[];
  source_thread_id?: string;
  confidence_score?: number;
  status?: DataObjectStatus;
  sync_state?: SyncState;
}

/**
 * Filters for querying DataObjects from the store.
 * All fields are optional — omitted fields are not filtered on.
 */
export interface DataObjectFilters {
  type?: DataObjectType;
  scope?: DataObjectScope;
  status?: DataObjectStatus;
  owner_id?: string;
  namespace?: string;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/**
 * Runtime check that a value is a valid DataObject.
 *
 * Validates the presence and types of all required top-level fields
 * and the nested metadata structure.
 *
 * @param value - The value to check
 * @returns true if value satisfies the DataObject interface
 */
export function isDataObject(value: unknown): value is DataObject {
  if (typeof value !== 'object' || value === null) return false;

  const obj = value as Record<string, unknown>;

  // Top-level required strings
  if (typeof obj.id !== 'string') return false;
  if (!isDataObjectType(obj.type)) return false;
  if (!isDataObjectScope(obj.scope)) return false;
  if (typeof obj.schema_id !== 'string') return false;
  if (!isDataObjectStatus(obj.status)) return false;
  if (typeof obj.owner_id !== 'string') return false;
  if (typeof obj.namespace !== 'string') return false;
  if (!isSyncState(obj.sync_state)) return false;

  // payload
  if (typeof obj.payload !== 'object' || obj.payload === null) return false;

  // metadata
  if (typeof obj.metadata !== 'object' || obj.metadata === null) return false;
  const meta = obj.metadata as Record<string, unknown>;
  if (typeof meta.created_at !== 'string') return false;
  if (typeof meta.updated_at !== 'string') return false;
  if (!Array.isArray(meta.tags)) return false;

  return true;
}

/**
 * Runtime check that a value is a valid SchemaDefinition.
 *
 * @param value - The value to check
 * @returns true if value satisfies the SchemaDefinition interface
 */
export function isSchemaDefinition(value: unknown): value is SchemaDefinition {
  if (typeof value !== 'object' || value === null) return false;

  const obj = value as Record<string, unknown>;

  if (typeof obj.id !== 'string') return false;
  if (typeof obj.name !== 'string') return false;
  if (typeof obj.version !== 'string') return false;
  if (typeof obj.fields !== 'object' || obj.fields === null) return false;
  if (typeof obj.write_policy !== 'object' || obj.write_policy === null) return false;

  const wp = obj.write_policy as Record<string, unknown>;
  if (typeof wp.allow_unstructured !== 'boolean') return false;
  if (!isValidationLevel(wp.validation_level)) return false;

  return true;
}

/**
 * Runtime check that a value is a valid SinkDefinition.
 *
 * @param value - The value to check
 * @returns true if value satisfies the SinkDefinition interface
 */
export function isSinkDefinition(value: unknown): value is SinkDefinition {
  if (typeof value !== 'object' || value === null) return false;

  const obj = value as Record<string, unknown>;

  if (typeof obj.id !== 'string') return false;
  if (typeof obj.name !== 'string') return false;
  if (!isSinkType(obj.type)) return false;
  if (typeof obj.path !== 'string') return false;
  if (!isSinkFormat(obj.format)) return false;
  if (typeof obj.responsible_agent !== 'string') return false;
  if (!Array.isArray(obj.notify)) return false;
  if (typeof obj.description !== 'string') return false;

  return true;
}

// ---------------------------------------------------------------------------
// Internal helpers — narrow literal unions
// ---------------------------------------------------------------------------

/** @internal */
function isDataObjectType(v: unknown): v is DataObjectType {
  return v === 'memory' || v === 'knowledge' || v === 'sink_entry';
}

/** @internal */
function isDataObjectScope(v: unknown): v is DataObjectScope {
  return v === 'agent' || v === 'project' || v === 'global';
}

/** @internal */
function isDataObjectStatus(v: unknown): v is DataObjectStatus {
  return v === 'new' || v === 'processed' || v === 'archived';
}

/** @internal */
function isSyncState(v: unknown): v is SyncState {
  return v === 'local' || v === 'synced' || v === 'conflict';
}

/** @internal */
function isValidationLevel(v: unknown): v is ValidationLevel {
  return v === 'strict' || v === 'loose' || v === 'none';
}

/** @internal */
function isSinkType(v: unknown): v is SinkType {
  return v === 'collection' || v === 'log';
}

/** @internal */
function isSinkFormat(v: unknown): v is SinkFormat {
  return v === 'markdown' || v === 'json' || v === 'jsonl';
}
