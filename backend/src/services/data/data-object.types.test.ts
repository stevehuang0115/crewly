/**
 * Tests for DataObject types and type guards.
 *
 * Validates isDataObject, isSchemaDefinition, and isSinkDefinition
 * against valid objects and various malformed inputs.
 */

import {
  DataObject,
  SchemaDefinition,
  SinkDefinition,
  isDataObject,
  isSchemaDefinition,
  isSinkDefinition,
} from './data-object.types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validDataObject: DataObject = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  type: 'memory',
  scope: 'project',
  schema_id: 'schema-test-v1',
  status: 'new',
  owner_id: 'agent-leo',
  namespace: 'test/namespace',
  payload: { content: 'hello' },
  metadata: {
    created_at: '2026-03-30T00:00:00Z',
    updated_at: '2026-03-30T00:00:00Z',
    tags: ['test'],
  },
  sync_state: 'local',
};

const validSchemaDefinition: SchemaDefinition = {
  id: 'schema-test-v1',
  name: 'Test Schema',
  version: '1.0.0',
  fields: {
    title: { type: 'string', required: true, max_length: 100 },
    tags: { type: 'array', item_type: 'string', min_items: 1 },
  },
  write_policy: {
    allow_unstructured: false,
    validation_level: 'strict',
    auto_archive_after_days: 90,
  },
};

const validSinkDefinition: SinkDefinition = {
  id: 'sink-test',
  name: 'Test Sink',
  type: 'collection',
  path: 'sinks/test',
  format: 'json',
  schema_id: 'schema-test-v1',
  responsible_agent: 'agent-leo',
  notify: ['agent-sam'],
  description: 'A test sink',
};

// ---------------------------------------------------------------------------
// isDataObject
// ---------------------------------------------------------------------------

describe('isDataObject', () => {
  it('returns true for a valid DataObject', () => {
    expect(isDataObject(validDataObject)).toBe(true);
  });

  it('accepts all valid type values', () => {
    for (const t of ['memory', 'knowledge', 'sink_entry'] as const) {
      expect(isDataObject({ ...validDataObject, type: t })).toBe(true);
    }
  });

  it('accepts all valid scope values', () => {
    for (const s of ['agent', 'project', 'global'] as const) {
      expect(isDataObject({ ...validDataObject, scope: s })).toBe(true);
    }
  });

  it('accepts all valid status values', () => {
    for (const s of ['new', 'processed', 'archived'] as const) {
      expect(isDataObject({ ...validDataObject, status: s })).toBe(true);
    }
  });

  it('accepts all valid sync_state values', () => {
    for (const s of ['local', 'synced', 'conflict'] as const) {
      expect(isDataObject({ ...validDataObject, sync_state: s })).toBe(true);
    }
  });

  it('accepts optional metadata fields', () => {
    const withOptionals = {
      ...validDataObject,
      metadata: {
        ...validDataObject.metadata,
        source_thread_id: 'thread-123',
        confidence_score: 0.95,
      },
    };
    expect(isDataObject(withOptionals)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isDataObject(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isDataObject(undefined)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isDataObject('not an object')).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isDataObject(42)).toBe(false);
  });

  it('returns false when id is missing', () => {
    const { id, ...rest } = validDataObject;
    expect(isDataObject(rest)).toBe(false);
  });

  it('returns false for invalid type value', () => {
    expect(isDataObject({ ...validDataObject, type: 'invalid' })).toBe(false);
  });

  it('returns false for invalid scope value', () => {
    expect(isDataObject({ ...validDataObject, scope: 'invalid' })).toBe(false);
  });

  it('returns false for invalid status value', () => {
    expect(isDataObject({ ...validDataObject, status: 'invalid' })).toBe(false);
  });

  it('returns false for invalid sync_state value', () => {
    expect(isDataObject({ ...validDataObject, sync_state: 'invalid' })).toBe(false);
  });

  it('returns false when payload is null', () => {
    expect(isDataObject({ ...validDataObject, payload: null })).toBe(false);
  });

  it('returns false when metadata is null', () => {
    expect(isDataObject({ ...validDataObject, metadata: null })).toBe(false);
  });

  it('returns false when metadata.tags is not an array', () => {
    expect(
      isDataObject({
        ...validDataObject,
        metadata: { ...validDataObject.metadata, tags: 'not-array' },
      }),
    ).toBe(false);
  });

  it('returns false when metadata.created_at is missing', () => {
    const { created_at, ...metaRest } = validDataObject.metadata;
    expect(isDataObject({ ...validDataObject, metadata: metaRest })).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isDataObject({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSchemaDefinition
// ---------------------------------------------------------------------------

describe('isSchemaDefinition', () => {
  it('returns true for a valid SchemaDefinition', () => {
    expect(isSchemaDefinition(validSchemaDefinition)).toBe(true);
  });

  it('accepts all valid validation_level values', () => {
    for (const vl of ['strict', 'loose', 'none'] as const) {
      expect(
        isSchemaDefinition({
          ...validSchemaDefinition,
          write_policy: { ...validSchemaDefinition.write_policy, validation_level: vl },
        }),
      ).toBe(true);
    }
  });

  it('returns false for null', () => {
    expect(isSchemaDefinition(null)).toBe(false);
  });

  it('returns false when id is missing', () => {
    const { id, ...rest } = validSchemaDefinition;
    expect(isSchemaDefinition(rest)).toBe(false);
  });

  it('returns false when fields is not an object', () => {
    expect(isSchemaDefinition({ ...validSchemaDefinition, fields: 'bad' })).toBe(false);
  });

  it('returns false when write_policy is null', () => {
    expect(isSchemaDefinition({ ...validSchemaDefinition, write_policy: null })).toBe(false);
  });

  it('returns false when allow_unstructured is not boolean', () => {
    expect(
      isSchemaDefinition({
        ...validSchemaDefinition,
        write_policy: { ...validSchemaDefinition.write_policy, allow_unstructured: 'yes' },
      }),
    ).toBe(false);
  });

  it('returns false when validation_level is invalid', () => {
    expect(
      isSchemaDefinition({
        ...validSchemaDefinition,
        write_policy: { ...validSchemaDefinition.write_policy, validation_level: 'invalid' },
      }),
    ).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isSchemaDefinition({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSinkDefinition
// ---------------------------------------------------------------------------

describe('isSinkDefinition', () => {
  it('returns true for a valid SinkDefinition', () => {
    expect(isSinkDefinition(validSinkDefinition)).toBe(true);
  });

  it('accepts all valid sink type values', () => {
    for (const t of ['collection', 'log'] as const) {
      expect(isSinkDefinition({ ...validSinkDefinition, type: t })).toBe(true);
    }
  });

  it('accepts all valid format values', () => {
    for (const f of ['markdown', 'json', 'jsonl'] as const) {
      expect(isSinkDefinition({ ...validSinkDefinition, format: f })).toBe(true);
    }
  });

  it('returns false for null', () => {
    expect(isSinkDefinition(null)).toBe(false);
  });

  it('returns false when id is missing', () => {
    const { id, ...rest } = validSinkDefinition;
    expect(isSinkDefinition(rest)).toBe(false);
  });

  it('returns false for invalid type value', () => {
    expect(isSinkDefinition({ ...validSinkDefinition, type: 'invalid' })).toBe(false);
  });

  it('returns false for invalid format value', () => {
    expect(isSinkDefinition({ ...validSinkDefinition, format: 'xml' })).toBe(false);
  });

  it('returns false when notify is not an array', () => {
    expect(isSinkDefinition({ ...validSinkDefinition, notify: 'agent' })).toBe(false);
  });

  it('returns false when description is missing', () => {
    const { description, ...rest } = validSinkDefinition;
    expect(isSinkDefinition(rest)).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isSinkDefinition({})).toBe(false);
  });
});
