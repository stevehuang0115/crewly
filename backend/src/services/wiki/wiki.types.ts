/**
 * LLM-Wiki shared types.
 *
 * Mirrors the SCHEMA.md YAML shape defined in
 * .crewly/specs/2026-05-22-atlas-crewly-llm-wiki-v2-three-scope.md §2.
 *
 * @module services/wiki/wiki.types
 */

/**
 * The three vault scopes per v2.1 §1.
 *
 * - `team`:    ~/.crewly/teams/<team-id>/wiki/         (cross-project team norms)
 * - `project`: <project-root>/.crewly/wiki/            (project-scoped knowledge)
 * - `global`:  ~/.crewly/global-wiki/                  (ORC cross-project synthesis)
 */
export type VaultScope = 'team' | 'project' | 'global';

/**
 * A symbolic `referenced_by:` entry in SCHEMA.md.
 *
 * Format: `<kind>:<name>` (e.g. `skill:get-sops`, `service:sop.service`).
 * Resolves to an absolute filesystem path via
 * {@link ReferencedByResolver.resolve} so SCHEMA.md stays portable across
 * machines, users, and runtime targets.
 */
export type ReferencedBySymbol = `skill:${string}` | `service:${string}`;

/**
 * A folder entry inside a vault's `hardcoded:` block.
 *
 * Hardcoded folders are referenced by string literal from OSS code. They
 * MUST NOT be moved, renamed, or restructured by `wiki-lint`.
 */
export interface HardcodedFolder {
  /** Folder name relative to vault root, e.g. `sop/`, `memory/`. */
  path: string;
  /** Always true for entries in `hardcoded:`. */
  frozen: true;
  /** Human description; appears in lint reports. */
  description: string;
  /** Symbolic refs to code that hard-codes this path. Use `skill:` / `service:`. */
  referenced_by: ReferencedBySymbol[];
}

/**
 * The single `llm-curated:` folder entry — LLM owns sub-structure entirely.
 */
export interface LlmCuratedFolder {
  /** Always `llm-curated/`. */
  path: string;
  /** Always false; lint MAY restructure. */
  frozen: false;
  /** Initial subdirs to seed; LLM may add more if `llm_can_create_subdirs`. */
  seed_subdirs: string[];
  llm_can_create_subdirs: boolean;
  lint_may_restructure: boolean;
}

/**
 * `write_policy:` block — who may write canonical pages vs. propose-only.
 */
export interface WritePolicy {
  /** Roles allowed to write canonical pages via `wiki-ingest`. */
  canonical: string[];
  /** Roles whose ingest writes are PR-style; TL/ORC must accept. */
  proposed_only: string[];
  /** Roles allowed to modify SCHEMA.md itself. */
  schema_writer: string[];
}

/**
 * Parsed SCHEMA.md content for one vault.
 */
export interface VaultSchema {
  vault_scope: VaultScope;
  vault_id: string;
  hardcoded: HardcodedFolder[];
  llm_curated: LlmCuratedFolder[];
  write_policy: WritePolicy;
}

/**
 * Result of resolving a symbolic `referenced_by:` entry.
 */
export interface ResolvedReference {
  symbol: ReferencedBySymbol;
  absolutePath: string;
  exists: boolean;
}
