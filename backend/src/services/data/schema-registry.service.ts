/**
 * Schema Registry Service
 *
 * Loads schema definitions from project sink directories and validates
 * data payloads against those schemas. Central to the Data Architecture V2
 * governance layer — ensures every piece of data entering a sink conforms
 * to its declared structure.
 *
 * @module services/data/schema-registry.service
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type {
  SchemaDefinition,
  SchemaField,
  ValidationResult,
  ValidationError,
} from '../../types/data-object.types.js';
import { DATA_CONSTANTS } from '../../types/data-object.types.js';

/** ISO 8601 date-time regex (accepts both Z and +/-offset) */
const ISO8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Singleton service that manages schema definitions and validates payloads.
 *
 * Schemas are loaded from `{projectPath}/sinks/{sinkDir}/_schema.json` for
 * each registered sink, or from a consolidated registry file. The validate()
 * method applies all declared field rules and returns a structured result.
 */
export class SchemaRegistryService {
  private static instance: SchemaRegistryService | null = null;
  private readonly logger: ComponentLogger;
  private readonly schemas: Map<string, SchemaDefinition> = new Map();

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('SchemaRegistryService');
  }

  /**
   * Get the singleton instance.
   *
   * @returns SchemaRegistryService singleton
   */
  static getInstance(): SchemaRegistryService {
    if (!SchemaRegistryService.instance) {
      SchemaRegistryService.instance = new SchemaRegistryService();
    }
    return SchemaRegistryService.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  static resetInstance(): void {
    SchemaRegistryService.instance = null;
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  /**
   * Load schemas from a project's sinks directory.
   *
   * Scans `{projectPath}/sinks/` for sub-directories containing a
   * `_schema.json` file and registers each valid schema.
   *
   * @param projectPath - Absolute path to the Crewly project root
   */
  async loadSchemas(projectPath: string): Promise<void> {
    const sinksDir = path.join(projectPath, DATA_CONSTANTS.SINKS_DIR);

    if (!existsSync(sinksDir)) {
      this.logger.warn('Sinks directory does not exist, no schemas loaded', { sinksDir });
      return;
    }

    const entries = await fs.readdir(sinksDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) {
        continue;
      }

      const schemaPath = path.join(sinksDir, entry.name, DATA_CONSTANTS.SCHEMA_FILE);

      if (!existsSync(schemaPath)) {
        continue;
      }

      try {
        const raw = await fs.readFile(schemaPath, 'utf-8');
        const schema: SchemaDefinition = JSON.parse(raw);

        if (!schema.id || !schema.fields) {
          this.logger.warn('Skipping invalid schema file (missing id or fields)', { schemaPath });
          continue;
        }

        this.schemas.set(schema.id, schema);
        this.logger.debug?.(`Loaded schema: ${schema.id}`, { name: schema.name });
      } catch (err) {
        this.logger.warn('Failed to parse schema file', {
          schemaPath,
          error: (err as Error).message,
        });
      }
    }
  }

  /**
   * Register a schema definition directly (e.g. from tests or programmatic setup).
   *
   * @param schema - The schema to register
   */
  registerSchema(schema: SchemaDefinition): void {
    this.schemas.set(schema.id, schema);
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /**
   * Get a schema by its ID.
   *
   * @param schemaId - Unique schema identifier
   * @returns The schema, or null if not found
   */
  getSchema(schemaId: string): SchemaDefinition | null {
    return this.schemas.get(schemaId) ?? null;
  }

  /**
   * List all loaded schemas.
   *
   * @returns Array of all registered SchemaDefinitions
   */
  listSchemas(): SchemaDefinition[] {
    return Array.from(this.schemas.values());
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  /**
   * Validate a payload against a registered schema.
   *
   * Applies the following rules per field:
   * - **required**: field must exist and not be null/undefined
   * - **type**: JS typeof must match (with special handling for array, datetime, enum)
   * - **max_length**: string length must not exceed limit
   * - **enum options**: value must be one of the declared options
   * - **array min_items**: array length must meet minimum
   * - **datetime**: value must match ISO 8601 format
   *
   * @param schemaId - ID of the schema to validate against
   * @param payload - Key-value data to validate
   * @returns Structured validation result with any errors
   */
  validate(schemaId: string, payload: Record<string, unknown>): ValidationResult {
    const schema = this.schemas.get(schemaId);

    if (!schema) {
      return {
        valid: false,
        errors: [{ field: '_schema', message: `Schema '${schemaId}' not found`, rule: 'schema_exists' }],
      };
    }

    const errors: ValidationError[] = [];

    for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
      const value = payload[fieldName];
      this.validateField(fieldName, fieldDef, value, errors);
    }

    return { valid: errors.length === 0, errors };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Validate a single field against its definition, pushing errors into the array.
   *
   * @param fieldName - Name of the field being validated
   * @param fieldDef - Schema field definition
   * @param value - Actual value from the payload
   * @param errors - Mutable array to collect validation errors
   */
  private validateField(
    fieldName: string,
    fieldDef: SchemaField,
    value: unknown,
    errors: ValidationError[],
  ): void {
    // Required check
    if (fieldDef.required && (value === undefined || value === null)) {
      errors.push({ field: fieldName, message: `Field '${fieldName}' is required`, rule: 'required' });
      return; // Skip further checks if missing
    }

    // If field is absent and not required, skip remaining rules
    if (value === undefined || value === null) {
      return;
    }

    // Type-specific checks
    switch (fieldDef.type) {
      case 'string':
        this.validateString(fieldName, fieldDef, value, errors);
        break;
      case 'number':
        this.validateType(fieldName, 'number', value, errors);
        break;
      case 'boolean':
        this.validateType(fieldName, 'boolean', value, errors);
        break;
      case 'array':
        this.validateArray(fieldName, fieldDef, value, errors);
        break;
      case 'datetime':
        this.validateDatetime(fieldName, value, errors);
        break;
      case 'enum':
        this.validateEnum(fieldName, fieldDef, value, errors);
        break;
    }
  }

  /**
   * Validate a string field (typeof + max_length).
   */
  private validateString(
    fieldName: string,
    fieldDef: SchemaField,
    value: unknown,
    errors: ValidationError[],
  ): void {
    if (typeof value !== 'string') {
      errors.push({
        field: fieldName,
        message: `Expected type 'string', got '${typeof value}'`,
        rule: 'type',
      });
      return;
    }

    if (fieldDef.max_length !== undefined && value.length > fieldDef.max_length) {
      errors.push({
        field: fieldName,
        message: `String exceeds max length of ${fieldDef.max_length} (got ${value.length})`,
        rule: 'max_length',
      });
    }
  }

  /**
   * Validate a primitive type via typeof.
   */
  private validateType(
    fieldName: string,
    expectedType: string,
    value: unknown,
    errors: ValidationError[],
  ): void {
    if (typeof value !== expectedType) {
      errors.push({
        field: fieldName,
        message: `Expected type '${expectedType}', got '${typeof value}'`,
        rule: 'type',
      });
    }
  }

  /**
   * Validate an array field (isArray + min_items).
   */
  private validateArray(
    fieldName: string,
    fieldDef: SchemaField,
    value: unknown,
    errors: ValidationError[],
  ): void {
    if (!Array.isArray(value)) {
      errors.push({
        field: fieldName,
        message: `Expected type 'array', got '${typeof value}'`,
        rule: 'type',
      });
      return;
    }

    if (fieldDef.min_items !== undefined && value.length < fieldDef.min_items) {
      errors.push({
        field: fieldName,
        message: `Array must have at least ${fieldDef.min_items} item(s), got ${value.length}`,
        rule: 'min_items',
      });
    }
  }

  /**
   * Validate a datetime field (must be a string matching ISO 8601).
   */
  private validateDatetime(
    fieldName: string,
    value: unknown,
    errors: ValidationError[],
  ): void {
    if (typeof value !== 'string') {
      errors.push({
        field: fieldName,
        message: `Expected type 'datetime' (ISO8601 string), got '${typeof value}'`,
        rule: 'type',
      });
      return;
    }

    if (!ISO8601_REGEX.test(value)) {
      errors.push({
        field: fieldName,
        message: `Value '${value}' is not a valid ISO8601 datetime`,
        rule: 'datetime',
      });
    }
  }

  /**
   * Validate an enum field (value must be one of options).
   */
  private validateEnum(
    fieldName: string,
    fieldDef: SchemaField,
    value: unknown,
    errors: ValidationError[],
  ): void {
    if (typeof value !== 'string') {
      errors.push({
        field: fieldName,
        message: `Expected type 'string' for enum, got '${typeof value}'`,
        rule: 'type',
      });
      return;
    }

    if (fieldDef.options && !fieldDef.options.includes(value)) {
      errors.push({
        field: fieldName,
        message: `Value '${value}' is not in allowed options: [${fieldDef.options.join(', ')}]`,
        rule: 'enum',
      });
    }
  }
}
