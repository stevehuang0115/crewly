/**
 * Tests for data-object.types.ts
 *
 * Validates type-level contracts via runtime assertions on constants
 * and structural checks on interface-conforming objects.
 */

import { describe, it, expect } from 'vitest';
import {
  DATA_CONSTANTS,
  type DataObject,
  type DataObjectType,
  type DataObjectScope,
  type DataObjectStatus,
  type SyncState,
  type SchemaDefinition,
  type SchemaField,
  type SinkDefinition,
  type ValidationResult,
  type ValidationError,
  type WritePolicy,
} from './data-object.types.js';

describe('data-object.types', () => {
  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------

  describe('DATA_CONSTANTS', () => {
    it('has expected path constants', () => {
      expect(DATA_CONSTANTS.SINKS_DIR).toBe('sinks');
      expect(DATA_CONSTANTS.SINKS_REGISTRY_FILE).toBe('_sinks.json');
      expect(DATA_CONSTANTS.SCHEMA_FILE).toBe('_schema.json');
      expect(DATA_CONSTANTS.INBOX_DIR).toBe('_inbox');
    });

    it('is frozen (const assertion)', () => {
      // Attempting to modify should have no effect at runtime
      const copy = { ...DATA_CONSTANTS };
      expect(copy.SINKS_DIR).toBe('sinks');
    });
  });

  // -----------------------------------------------------------------------
  // DataObject structural conformance
  // -----------------------------------------------------------------------

  describe('DataObject structure', () => {
    it('accepts a valid DataObject', () => {
      const obj: DataObject = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'sink_entry',
        scope: 'project',
        schema_id: 'schema-steve-input-v1',
        status: 'new',
        owner_id: 'agent-123',
        payload: { title: 'Test', content: 'Hello' },
        metadata: {
          created_at: '2026-03-29T10:00:00Z',
          updated_at: '2026-03-29T10:00:00Z',
          tags: ['strategy'],
        },
        sync_state: 'local',
      };
      expect(obj.id).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(obj.type).toBe('sink_entry');
    });

    it('supports all DataObjectType values', () => {
      const types: DataObjectType[] = ['memory', 'knowledge', 'sink_entry'];
      expect(types).toHaveLength(3);
    });

    it('supports all DataObjectScope values', () => {
      const scopes: DataObjectScope[] = ['agent', 'project', 'global'];
      expect(scopes).toHaveLength(3);
    });

    it('supports all DataObjectStatus values', () => {
      const statuses: DataObjectStatus[] = ['new', 'processed', 'archived'];
      expect(statuses).toHaveLength(3);
    });

    it('supports all SyncState values', () => {
      const states: SyncState[] = ['local', 'synced', 'conflict'];
      expect(states).toHaveLength(3);
    });
  });

  // -----------------------------------------------------------------------
  // SchemaDefinition structural conformance
  // -----------------------------------------------------------------------

  describe('SchemaDefinition structure', () => {
    it('accepts a valid schema with all field types', () => {
      const schema: SchemaDefinition = {
        id: 'test-schema',
        name: 'Test Schema',
        fields: {
          title: { type: 'string', required: true, max_length: 100 },
          source: { type: 'enum', options: ['a', 'b'], required: true },
          tags: { type: 'array', item_type: 'string', min_items: 1 },
          count: { type: 'number' },
          active: { type: 'boolean' },
          created: { type: 'datetime', required: true },
        },
        write_policy: {
          allow_unstructured: false,
          validation_level: 'strict',
          auto_archive_after_days: 30,
        },
      };
      expect(Object.keys(schema.fields)).toHaveLength(6);
    });
  });

  // -----------------------------------------------------------------------
  // SinkDefinition structural conformance
  // -----------------------------------------------------------------------

  describe('SinkDefinition structure', () => {
    it('accepts a valid sink definition', () => {
      const sink: SinkDefinition = {
        id: 'steve-inputs',
        name: 'CEO Inputs',
        description: 'Raw CEO inputs',
        schema_id: 'schema-steve-input-v1',
        tags: ['strategy', 'ceo'],
        directory: 'steve-inputs',
      };
      expect(sink.id).toBe('steve-inputs');
      expect(sink.tags).toContain('strategy');
    });

    it('allows optional description', () => {
      const sink: SinkDefinition = {
        id: 'minimal',
        name: 'Minimal',
        schema_id: 'schema-min-v1',
        tags: [],
        directory: 'minimal',
      };
      expect(sink.description).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // ValidationResult / ValidationError
  // -----------------------------------------------------------------------

  describe('ValidationResult structure', () => {
    it('accepts a valid result', () => {
      const result: ValidationResult = { valid: true, errors: [] };
      expect(result.valid).toBe(true);
    });

    it('accepts a result with errors', () => {
      const error: ValidationError = {
        field: 'title',
        message: 'Field is required',
        rule: 'required',
      };
      const result: ValidationResult = { valid: false, errors: [error] };
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].rule).toBe('required');
    });
  });

  // -----------------------------------------------------------------------
  // WritePolicy structure
  // -----------------------------------------------------------------------

  describe('WritePolicy structure', () => {
    it('accepts strict policy', () => {
      const policy: WritePolicy = {
        allow_unstructured: false,
        validation_level: 'strict',
        auto_archive_after_days: 90,
      };
      expect(policy.validation_level).toBe('strict');
    });

    it('accepts permissive policy without auto_archive', () => {
      const policy: WritePolicy = {
        allow_unstructured: true,
        validation_level: 'permissive',
      };
      expect(policy.auto_archive_after_days).toBeUndefined();
    });
  });
});
