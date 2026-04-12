/**
 * Tests for SchemaRegistryService
 *
 * Covers: schema loading from disk, getSchema, listSchemas, and all
 * validation rules (required, type, max_length, enum, array min_items, datetime).
 */

import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { SchemaRegistryService } from './schema-registry.service.js';
import type { SchemaDefinition } from '../../types/data-object.types.js';

// Mock fs modules
jest.mock('fs/promises');
jest.mock('fs', () => ({
  existsSync: jest.fn(),
}));

// Mock logger
jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
      }),
    }),
  },
}));

/**
 * Helper to build a valid steve-inputs schema for testing.
 */
function makeSteveInputsSchema(): SchemaDefinition {
  return {
    id: 'schema-steve-input-v1',
    name: 'CEO Input Fragment',
    fields: {
      title: { type: 'string', required: true, max_length: 100 },
      source: { type: 'enum', options: ['slack', 'chat', 'voice'], required: true },
      tags: { type: 'array', item_type: 'string', min_items: 1 },
      content: { type: 'string', required: true },
      timestamp: { type: 'datetime', required: true },
    },
    write_policy: {
      allow_unstructured: false,
      validation_level: 'strict',
      auto_archive_after_days: 90,
    },
  };
}

describe('SchemaRegistryService', () => {
  let service: SchemaRegistryService;

  beforeEach(() => {
    SchemaRegistryService.resetInstance();
    service = SchemaRegistryService.getInstance();
    jest.clearAllMocks();
  });

  afterEach(() => {
    SchemaRegistryService.resetInstance();
  });

  // -----------------------------------------------------------------------
  // Singleton
  // -----------------------------------------------------------------------

  describe('singleton', () => {
    it('returns the same instance', () => {
      const a = SchemaRegistryService.getInstance();
      const b = SchemaRegistryService.getInstance();
      expect(a).toBe(b);
    });

    it('returns a fresh instance after reset', () => {
      const a = SchemaRegistryService.getInstance();
      SchemaRegistryService.resetInstance();
      const b = SchemaRegistryService.getInstance();
      expect(a).not.toBe(b);
    });
  });

  // -----------------------------------------------------------------------
  // Loading
  // -----------------------------------------------------------------------

  describe('loadSchemas', () => {
    it('loads schemas from sink sub-directories', async () => {
      const schema = makeSteveInputsSchema();
      jest.mocked(existsSync).mockReturnValue(true);
      jest.mocked(fs.readdir).mockResolvedValue([
        { name: 'steve-inputs', isDirectory: () => true } as unknown as import('fs').Dirent,
      ] as unknown as import('fs').Dirent[]);
      jest.mocked(fs.readFile).mockResolvedValue(JSON.stringify(schema));

      await service.loadSchemas('/project');

      expect(service.getSchema('schema-steve-input-v1')).toEqual(schema);
      expect(service.listSchemas()).toHaveLength(1);
    });

    it('skips directories starting with underscore', async () => {
      jest.mocked(existsSync).mockReturnValue(true);
      jest.mocked(fs.readdir).mockResolvedValue([
        { name: '_inbox', isDirectory: () => true } as unknown as import('fs').Dirent,
      ] as unknown as import('fs').Dirent[]);

      await service.loadSchemas('/project');

      expect(service.listSchemas()).toHaveLength(0);
    });

    it('handles non-existent sinks directory gracefully', async () => {
      jest.mocked(existsSync).mockReturnValue(false);

      await service.loadSchemas('/project');

      expect(service.listSchemas()).toHaveLength(0);
    });

    it('skips schemas missing id or fields', async () => {
      jest.mocked(existsSync).mockReturnValue(true);
      jest.mocked(fs.readdir).mockResolvedValue([
        { name: 'bad-sink', isDirectory: () => true } as unknown as import('fs').Dirent,
      ] as unknown as import('fs').Dirent[]);
      jest.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ name: 'No ID' }));

      await service.loadSchemas('/project');

      expect(service.listSchemas()).toHaveLength(0);
    });

    it('skips non-directory entries', async () => {
      jest.mocked(existsSync).mockReturnValue(true);
      jest.mocked(fs.readdir).mockResolvedValue([
        { name: 'readme.md', isDirectory: () => false } as unknown as import('fs').Dirent,
      ] as unknown as import('fs').Dirent[]);

      await service.loadSchemas('/project');

      expect(service.listSchemas()).toHaveLength(0);
    });

    it('handles malformed JSON gracefully', async () => {
      jest.mocked(existsSync).mockReturnValue(true);
      jest.mocked(fs.readdir).mockResolvedValue([
        { name: 'bad-json', isDirectory: () => true } as unknown as import('fs').Dirent,
      ] as unknown as import('fs').Dirent[]);
      jest.mocked(fs.readFile).mockResolvedValue('not valid json {{');

      await service.loadSchemas('/project');

      expect(service.listSchemas()).toHaveLength(0);
    });

    it('skips directories without _schema.json', async () => {
      jest.mocked(existsSync)
        .mockReturnValueOnce(true)   // sinksDir exists
        .mockReturnValueOnce(false); // _schema.json does not exist
      jest.mocked(fs.readdir).mockResolvedValue([
        { name: 'no-schema', isDirectory: () => true } as unknown as import('fs').Dirent,
      ] as unknown as import('fs').Dirent[]);

      await service.loadSchemas('/project');

      expect(service.listSchemas()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // registerSchema (programmatic)
  // -----------------------------------------------------------------------

  describe('registerSchema', () => {
    it('adds a schema that can be retrieved', () => {
      const schema = makeSteveInputsSchema();
      service.registerSchema(schema);
      expect(service.getSchema(schema.id)).toEqual(schema);
    });
  });

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  describe('getSchema / listSchemas', () => {
    it('returns null for unknown schema', () => {
      expect(service.getSchema('nonexistent')).toBeNull();
    });

    it('lists multiple schemas', () => {
      const s1 = makeSteveInputsSchema();
      const s2: SchemaDefinition = {
        id: 'schema-other-v1',
        name: 'Other',
        fields: { note: { type: 'string' } },
        write_policy: { allow_unstructured: true, validation_level: 'permissive' },
      };
      service.registerSchema(s1);
      service.registerSchema(s2);
      expect(service.listSchemas()).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // Validation — required
  // -----------------------------------------------------------------------

  describe('validate — required rule', () => {
    beforeEach(() => {
      service.registerSchema(makeSteveInputsSchema());
    });

    it('fails when a required field is missing', () => {
      const result = service.validate('schema-steve-input-v1', {
        source: 'slack',
        content: 'hello',
        timestamp: '2026-03-29T10:00:00Z',
        // title is missing
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'title' && e.rule === 'required')).toBe(true);
    });

    it('fails when a required field is null', () => {
      const result = service.validate('schema-steve-input-v1', {
        title: null,
        source: 'slack',
        content: 'hello',
        timestamp: '2026-03-29T10:00:00Z',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'title' && e.rule === 'required')).toBe(true);
    });

    it('passes when all required fields are present', () => {
      const result = service.validate('schema-steve-input-v1', {
        title: 'Test',
        source: 'slack',
        tags: ['a'],
        content: 'hello',
        timestamp: '2026-03-29T10:00:00Z',
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Validation — type checking
  // -----------------------------------------------------------------------

  describe('validate — type rule', () => {
    beforeEach(() => {
      service.registerSchema({
        id: 'type-test',
        name: 'Type Test',
        fields: {
          name: { type: 'string', required: true },
          count: { type: 'number', required: true },
          active: { type: 'boolean', required: true },
        },
        write_policy: { allow_unstructured: false, validation_level: 'strict' },
      });
    });

    it('fails when string field receives a number', () => {
      const result = service.validate('type-test', { name: 123, count: 1, active: true });
      expect(result.valid).toBe(false);
      expect(result.errors[0].rule).toBe('type');
    });

    it('fails when number field receives a string', () => {
      const result = service.validate('type-test', { name: 'ok', count: 'oops', active: true });
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('count');
    });

    it('fails when boolean field receives a string', () => {
      const result = service.validate('type-test', { name: 'ok', count: 1, active: 'yes' });
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('active');
    });
  });

  // -----------------------------------------------------------------------
  // Validation — max_length
  // -----------------------------------------------------------------------

  describe('validate — max_length rule', () => {
    beforeEach(() => {
      service.registerSchema(makeSteveInputsSchema());
    });

    it('fails when string exceeds max_length', () => {
      const result = service.validate('schema-steve-input-v1', {
        title: 'x'.repeat(101),
        source: 'slack',
        content: 'hello',
        timestamp: '2026-03-29T10:00:00Z',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'title' && e.rule === 'max_length')).toBe(true);
    });

    it('passes when string is exactly at max_length', () => {
      const result = service.validate('schema-steve-input-v1', {
        title: 'x'.repeat(100),
        source: 'slack',
        tags: ['a'],
        content: 'hello',
        timestamp: '2026-03-29T10:00:00Z',
      });
      expect(result.valid).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Validation — enum
  // -----------------------------------------------------------------------

  describe('validate — enum rule', () => {
    beforeEach(() => {
      service.registerSchema(makeSteveInputsSchema());
    });

    it('fails when value is not in enum options', () => {
      const result = service.validate('schema-steve-input-v1', {
        title: 'Test',
        source: 'email',
        content: 'hello',
        timestamp: '2026-03-29T10:00:00Z',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'source' && e.rule === 'enum')).toBe(true);
    });

    it('passes with valid enum value', () => {
      const result = service.validate('schema-steve-input-v1', {
        title: 'Test',
        source: 'chat',
        tags: ['a'],
        content: 'hello',
        timestamp: '2026-03-29T10:00:00Z',
      });
      expect(result.valid).toBe(true);
    });

    it('fails when enum field receives non-string', () => {
      const result = service.validate('schema-steve-input-v1', {
        title: 'Test',
        source: 42,
        content: 'hello',
        timestamp: '2026-03-29T10:00:00Z',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'source' && e.rule === 'type')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Validation — array / min_items
  // -----------------------------------------------------------------------

  describe('validate — array min_items rule', () => {
    beforeEach(() => {
      service.registerSchema(makeSteveInputsSchema());
    });

    it('fails when array has fewer than min_items', () => {
      const result = service.validate('schema-steve-input-v1', {
        title: 'Test',
        source: 'slack',
        tags: [],
        content: 'hello',
        timestamp: '2026-03-29T10:00:00Z',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'tags' && e.rule === 'min_items')).toBe(true);
    });

    it('fails when array field receives non-array', () => {
      const result = service.validate('schema-steve-input-v1', {
        title: 'Test',
        source: 'slack',
        tags: 'not-an-array',
        content: 'hello',
        timestamp: '2026-03-29T10:00:00Z',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'tags' && e.rule === 'type')).toBe(true);
    });

    it('passes with sufficient array items', () => {
      const result = service.validate('schema-steve-input-v1', {
        title: 'Test',
        source: 'slack',
        tags: ['strategy', 'mobile'],
        content: 'hello',
        timestamp: '2026-03-29T10:00:00Z',
      });
      expect(result.valid).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Validation — datetime
  // -----------------------------------------------------------------------

  describe('validate — datetime rule', () => {
    beforeEach(() => {
      service.registerSchema(makeSteveInputsSchema());
    });

    it('fails when datetime is not ISO8601', () => {
      const result = service.validate('schema-steve-input-v1', {
        title: 'Test',
        source: 'slack',
        content: 'hello',
        timestamp: 'March 29, 2026',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'timestamp' && e.rule === 'datetime')).toBe(true);
    });

    it('fails when datetime field receives non-string', () => {
      const result = service.validate('schema-steve-input-v1', {
        title: 'Test',
        source: 'slack',
        content: 'hello',
        timestamp: 12345,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'timestamp' && e.rule === 'type')).toBe(true);
    });

    it('passes with valid ISO8601 datetime (Z)', () => {
      const result = service.validate('schema-steve-input-v1', {
        title: 'Test',
        source: 'slack',
        tags: ['a'],
        content: 'hello',
        timestamp: '2026-03-29T10:00:00Z',
      });
      expect(result.valid).toBe(true);
    });

    it('passes with valid ISO8601 datetime (offset)', () => {
      const result = service.validate('schema-steve-input-v1', {
        title: 'Test',
        source: 'slack',
        tags: ['a'],
        content: 'hello',
        timestamp: '2026-03-29T10:00:00+08:00',
      });
      expect(result.valid).toBe(true);
    });

    it('passes with milliseconds', () => {
      const result = service.validate('schema-steve-input-v1', {
        title: 'Test',
        source: 'slack',
        tags: ['a'],
        content: 'hello',
        timestamp: '2026-03-29T10:00:00.123Z',
      });
      expect(result.valid).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Validation — schema not found
  // -----------------------------------------------------------------------

  describe('validate — schema not found', () => {
    it('returns error when schema does not exist', () => {
      const result = service.validate('nonexistent', { foo: 'bar' });
      expect(result.valid).toBe(false);
      expect(result.errors[0].rule).toBe('schema_exists');
    });
  });

  // -----------------------------------------------------------------------
  // Validation — optional fields
  // -----------------------------------------------------------------------

  describe('validate — optional fields', () => {
    beforeEach(() => {
      service.registerSchema(makeSteveInputsSchema());
    });

    it('passes when optional array field is omitted', () => {
      // tags is not required in the steve-inputs schema
      const result = service.validate('schema-steve-input-v1', {
        title: 'Test',
        source: 'slack',
        content: 'hello',
        timestamp: '2026-03-29T10:00:00Z',
      });
      expect(result.valid).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Validation — multiple errors
  // -----------------------------------------------------------------------

  describe('validate — multiple errors', () => {
    beforeEach(() => {
      service.registerSchema(makeSteveInputsSchema());
    });

    it('collects multiple errors in a single validation', () => {
      const result = service.validate('schema-steve-input-v1', {
        // title missing (required)
        // source missing (required)
        // content missing (required)
        // timestamp missing (required)
      });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(4);
    });
  });
});
