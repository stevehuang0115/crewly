/**
 * SCHEMA.md loader + validator + frozen-path gate.
 *
 * Reads `<vault>/SCHEMA.md` (pure YAML inside a .md container), validates
 * shape against `VaultSchema`, and exposes the frozen-path predicate used
 * by `wiki-lint` to refuse restructure operations on OSS-pinned folders.
 *
 * Per v2.1 spec §2 (Hybrid folder architecture) — the `frozen: true` block
 * is a HARD contract: any lint or ingest operation that targets a frozen
 * path MUST fail closed.
 *
 * @module services/wiki/schema-loader.service
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { parse as parseYAML } from 'yaml';
import { VaultSchema, VaultScope } from './wiki.types.js';

/** Standard schema filename inside any vault root. */
export const SCHEMA_FILENAME = 'SCHEMA.md';

/**
 * Loads + validates a vault's SCHEMA.md. Stateless — instantiate once
 * per service or use the static helper.
 */
export class SchemaLoaderService {
  /**
   * Load and validate the SCHEMA.md inside a vault directory.
   *
   * @param vaultPath - Absolute path to the vault root (the directory
   *   containing SCHEMA.md). Must be absolute.
   * @returns Validated VaultSchema.
   * @throws If vaultPath is not absolute, SCHEMA.md is missing, YAML
   *   parsing fails, or the parsed object is shape-invalid.
   */
  async load(vaultPath: string): Promise<VaultSchema> {
    if (!path.isAbsolute(vaultPath)) {
      throw new Error(`SchemaLoader: vaultPath must be absolute, got "${vaultPath}"`);
    }
    const schemaPath = path.join(vaultPath, SCHEMA_FILENAME);
    let raw: string;
    try {
      raw = await fs.readFile(schemaPath, 'utf8');
    } catch (err) {
      throw new Error(
        `SchemaLoader: SCHEMA.md not found at ${schemaPath} (${(err as Error).message})`,
      );
    }

    let parsed: unknown;
    try {
      parsed = parseYAML(raw);
    } catch (err) {
      throw new Error(
        `SchemaLoader: invalid YAML in ${schemaPath}: ${(err as Error).message}`,
      );
    }

    return this.validate(parsed, schemaPath);
  }

  /**
   * Determine whether a path inside a vault is frozen (OSS-pinned).
   *
   * Used by `wiki-lint` and `wiki-ingest` to refuse restructure / write
   * operations. Comparison is by leading path segment — e.g. `sop/foo.md`
   * is frozen if `sop/` is declared frozen.
   *
   * @param schema - The vault's parsed schema.
   * @param relativePath - Path relative to vault root, e.g. `sop/team-1.md`.
   * @returns true if the path lives under a frozen folder.
   */
  isFrozenPath(schema: VaultSchema, relativePath: string): boolean {
    const normalized = relativePath.replace(/^[/\\]+/, '');
    return schema.hardcoded.some((folder) => {
      // Match either exact folder or anything beneath it.
      const folderName = folder.path.replace(/[/\\]+$/, '');
      return normalized === folderName || normalized.startsWith(`${folderName}/`);
    });
  }

  /**
   * Return every frozen folder path declared in a schema. Convenience for
   * lint reports.
   */
  getFrozenPaths(schema: VaultSchema): string[] {
    return schema.hardcoded.map((f) => f.path);
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  private validate(parsed: unknown, source: string): VaultSchema {
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`SchemaLoader: ${source} did not parse to an object`);
    }
    const p = parsed as Record<string, unknown>;

    const vault_scope = this.requireScope(p.vault_scope, source);
    const vault_id = this.requireString(p.vault_id, 'vault_id', source);
    const hardcoded = this.requireHardcoded(p.hardcoded, source);
    const llm_curated = this.requireLlmCurated(p.llm_curated, source);
    const write_policy = this.requireWritePolicy(p.write_policy, source);

    return { vault_scope, vault_id, hardcoded, llm_curated, write_policy };
  }

  private requireScope(raw: unknown, source: string): VaultScope {
    if (raw !== 'team' && raw !== 'project' && raw !== 'global') {
      throw new Error(
        `SchemaLoader: ${source} has invalid vault_scope "${raw}" — expected "team" | "project" | "global"`,
      );
    }
    return raw;
  }

  private requireString(raw: unknown, field: string, source: string): string {
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new Error(`SchemaLoader: ${source} missing or empty "${field}"`);
    }
    return raw;
  }

  private requireHardcoded(raw: unknown, source: string): VaultSchema['hardcoded'] {
    if (!Array.isArray(raw)) {
      throw new Error(`SchemaLoader: ${source} "hardcoded" must be an array`);
    }
    return raw.map((entry, idx) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error(`SchemaLoader: ${source} hardcoded[${idx}] is not an object`);
      }
      const e = entry as Record<string, unknown>;
      const path = this.requireString(e.path, `hardcoded[${idx}].path`, source);
      if (e.frozen !== true) {
        throw new Error(
          `SchemaLoader: ${source} hardcoded[${idx}] must have frozen: true (got ${JSON.stringify(e.frozen)})`,
        );
      }
      const description = this.requireString(
        e.description,
        `hardcoded[${idx}].description`,
        source,
      );
      const refs = this.requireStringArray(
        e.referenced_by,
        `hardcoded[${idx}].referenced_by`,
        source,
      );
      // Each ref must look like `<kind>:<name>` — validated lightly here so
      // a malformed registry doesn't reach the resolver.
      refs.forEach((ref, refIdx) => {
        if (!/^(skill|service):.+$/.test(ref)) {
          throw new Error(
            `SchemaLoader: ${source} hardcoded[${idx}].referenced_by[${refIdx}] must match "skill:<name>" or "service:<name>" (got "${ref}")`,
          );
        }
      });
      return {
        path,
        frozen: true as const,
        description,
        referenced_by: refs as VaultSchema['hardcoded'][number]['referenced_by'],
      };
    });
  }

  private requireLlmCurated(raw: unknown, source: string): VaultSchema['llm_curated'] {
    if (!Array.isArray(raw)) {
      throw new Error(`SchemaLoader: ${source} "llm_curated" must be an array`);
    }
    return raw.map((entry, idx) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error(`SchemaLoader: ${source} llm_curated[${idx}] is not an object`);
      }
      const e = entry as Record<string, unknown>;
      const path = this.requireString(e.path, `llm_curated[${idx}].path`, source);
      if (e.frozen !== false) {
        throw new Error(
          `SchemaLoader: ${source} llm_curated[${idx}] must have frozen: false (got ${JSON.stringify(e.frozen)})`,
        );
      }
      const seed_subdirs = this.requireStringArray(
        e.seed_subdirs,
        `llm_curated[${idx}].seed_subdirs`,
        source,
      );
      return {
        path,
        frozen: false as const,
        seed_subdirs,
        llm_can_create_subdirs: Boolean(e.llm_can_create_subdirs),
        lint_may_restructure: Boolean(e.lint_may_restructure),
      };
    });
  }

  private requireWritePolicy(raw: unknown, source: string): VaultSchema['write_policy'] {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`SchemaLoader: ${source} "write_policy" must be an object`);
    }
    const w = raw as Record<string, unknown>;
    return {
      canonical: this.requireStringArray(w.canonical, 'write_policy.canonical', source),
      proposed_only: this.requireStringArray(
        w.proposed_only,
        'write_policy.proposed_only',
        source,
      ),
      schema_writer: this.requireStringArray(
        w.schema_writer,
        'write_policy.schema_writer',
        source,
      ),
    };
  }

  private requireStringArray(raw: unknown, field: string, source: string): string[] {
    if (!Array.isArray(raw)) {
      throw new Error(`SchemaLoader: ${source} "${field}" must be an array`);
    }
    raw.forEach((item, idx) => {
      if (typeof item !== 'string' || item.length === 0) {
        throw new Error(`SchemaLoader: ${source} "${field}[${idx}]" must be a non-empty string`);
      }
    });
    return raw as string[];
  }
}
