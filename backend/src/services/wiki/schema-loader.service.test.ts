/**
 * Tests for SchemaLoaderService.
 *
 * Covers: happy-path parse of project + team vault shapes, frozen-path
 * predicate, and every validation guard.
 *
 * @module services/wiki/schema-loader.service.test
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { SchemaLoaderService, SCHEMA_FILENAME } from './schema-loader.service.js';

describe('SchemaLoaderService', () => {
  let tmpVault: string;
  let loader: SchemaLoaderService;

  beforeEach(async () => {
    tmpVault = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-schema-test-'));
    loader = new SchemaLoaderService();
  });

  afterEach(async () => {
    await fs.rm(tmpVault, { recursive: true, force: true });
  });

  /** Helper to write a YAML schema into the temp vault. */
  const writeSchema = async (yaml: string): Promise<void> => {
    await fs.writeFile(path.join(tmpVault, SCHEMA_FILENAME), yaml, 'utf8');
  };

  describe('load (happy path)', () => {
    it('parses a project-scope vault schema', async () => {
      await writeSchema(`
vault_scope: project
vault_id: crewly
hardcoded:
  - path: memory/
    frozen: true
    description: "Project memory."
    referenced_by:
      - skill:remember
      - skill:recall
      - service:memory.service
llm_curated:
  - path: llm-curated/
    frozen: false
    seed_subdirs: [people, decisions]
    llm_can_create_subdirs: true
    lint_may_restructure: true
write_policy:
  canonical: [team-leader, orchestrator]
  proposed_only: [worker]
  schema_writer: [steve]
`);
      const schema = await loader.load(tmpVault);
      expect(schema.vault_scope).toBe('project');
      expect(schema.vault_id).toBe('crewly');
      expect(schema.hardcoded).toHaveLength(1);
      expect(schema.hardcoded[0].path).toBe('memory/');
      expect(schema.hardcoded[0].referenced_by).toEqual([
        'skill:remember',
        'skill:recall',
        'service:memory.service',
      ]);
      expect(schema.llm_curated[0].lint_may_restructure).toBe(true);
      expect(schema.write_policy.canonical).toContain('orchestrator');
    });

    it('parses a team-scope vault schema', async () => {
      await writeSchema(`
vault_scope: team
vault_id: ad923b66-19dd-4d73-9c92-dc1107d37501
hardcoded:
  - path: sop/
    frozen: true
    description: "Team SOPs."
    referenced_by: [skill:get-sops, service:sop.service]
  - path: team-norm/
    frozen: true
    description: "Team norms."
    referenced_by: [skill:get-team-norms]
llm_curated:
  - path: llm-curated/
    frozen: false
    seed_subdirs: [people, decisions, patterns]
    llm_can_create_subdirs: true
    lint_may_restructure: true
write_policy:
  canonical: [team-leader]
  proposed_only: [worker]
  schema_writer: [steve]
`);
      const schema = await loader.load(tmpVault);
      expect(schema.vault_scope).toBe('team');
      expect(schema.hardcoded.map((h) => h.path)).toEqual(['sop/', 'team-norm/']);
    });
  });

  describe('isFrozenPath', () => {
    let schemaCache: Awaited<ReturnType<SchemaLoaderService['load']>>;

    beforeEach(async () => {
      await writeSchema(`
vault_scope: team
vault_id: t1
hardcoded:
  - path: sop/
    frozen: true
    description: "SOPs."
    referenced_by: [skill:get-sops]
  - path: team-norm/
    frozen: true
    description: "Norms."
    referenced_by: [skill:get-team-norms]
llm_curated:
  - path: llm-curated/
    frozen: false
    seed_subdirs: [people]
    llm_can_create_subdirs: true
    lint_may_restructure: true
write_policy:
  canonical: [team-leader]
  proposed_only: [worker]
  schema_writer: [steve]
`);
      schemaCache = await loader.load(tmpVault);
    });

    it('returns true for exact frozen folder match', () => {
      expect(loader.isFrozenPath(schemaCache, 'sop/')).toBe(true);
      expect(loader.isFrozenPath(schemaCache, 'sop')).toBe(true);
    });

    it('returns true for files inside frozen folders', () => {
      expect(loader.isFrozenPath(schemaCache, 'sop/code-review.md')).toBe(true);
      expect(loader.isFrozenPath(schemaCache, 'team-norm/can-delegate.md')).toBe(true);
    });

    it('returns false for llm-curated paths', () => {
      expect(loader.isFrozenPath(schemaCache, 'llm-curated/people/steve.md')).toBe(false);
    });

    it('returns false for similarly-named non-frozen paths', () => {
      // `sop-overrides/` must NOT be considered a child of `sop/`.
      expect(loader.isFrozenPath(schemaCache, 'sop-overrides/foo.md')).toBe(false);
      // `team-norms/` (plural) is not declared frozen.
      expect(loader.isFrozenPath(schemaCache, 'team-norms/foo.md')).toBe(false);
    });

    it('strips leading slashes before matching', () => {
      expect(loader.isFrozenPath(schemaCache, '/sop/foo.md')).toBe(true);
    });
  });

  describe('getFrozenPaths', () => {
    it('lists every hardcoded path', async () => {
      await writeSchema(`
vault_scope: team
vault_id: t1
hardcoded:
  - path: sop/
    frozen: true
    description: "."
    referenced_by: [skill:get-sops]
  - path: team-norm/
    frozen: true
    description: "."
    referenced_by: [skill:get-team-norms]
llm_curated:
  - path: llm-curated/
    frozen: false
    seed_subdirs: []
    llm_can_create_subdirs: true
    lint_may_restructure: true
write_policy:
  canonical: [team-leader]
  proposed_only: []
  schema_writer: [steve]
`);
      const schema = await loader.load(tmpVault);
      expect(loader.getFrozenPaths(schema)).toEqual(['sop/', 'team-norm/']);
    });
  });

  describe('validation errors', () => {
    it('rejects non-absolute vaultPath', async () => {
      await expect(loader.load('relative/path')).rejects.toThrow(/must be absolute/);
    });

    it('reports a clear error when SCHEMA.md is missing', async () => {
      await expect(loader.load(tmpVault)).rejects.toThrow(/SCHEMA\.md not found/);
    });

    it('rejects invalid YAML', async () => {
      await writeSchema('not: : valid: yaml: : :');
      await expect(loader.load(tmpVault)).rejects.toThrow(/invalid YAML/);
    });

    it('rejects unknown vault_scope', async () => {
      await writeSchema(`
vault_scope: galaxy
vault_id: t1
hardcoded: []
llm_curated: []
write_policy:
  canonical: []
  proposed_only: []
  schema_writer: []
`);
      await expect(loader.load(tmpVault)).rejects.toThrow(/invalid vault_scope/);
    });

    it('rejects missing vault_id', async () => {
      await writeSchema(`
vault_scope: team
hardcoded: []
llm_curated: []
write_policy:
  canonical: []
  proposed_only: []
  schema_writer: []
`);
      await expect(loader.load(tmpVault)).rejects.toThrow(/missing or empty "vault_id"/);
    });

    it('rejects hardcoded entries with frozen != true', async () => {
      await writeSchema(`
vault_scope: team
vault_id: t1
hardcoded:
  - path: sop/
    frozen: false
    description: "."
    referenced_by: [skill:get-sops]
llm_curated: []
write_policy:
  canonical: []
  proposed_only: []
  schema_writer: []
`);
      await expect(loader.load(tmpVault)).rejects.toThrow(/must have frozen: true/);
    });

    it('rejects llm_curated entries with frozen != false', async () => {
      await writeSchema(`
vault_scope: team
vault_id: t1
hardcoded: []
llm_curated:
  - path: llm-curated/
    frozen: true
    seed_subdirs: []
    llm_can_create_subdirs: true
    lint_may_restructure: true
write_policy:
  canonical: []
  proposed_only: []
  schema_writer: []
`);
      await expect(loader.load(tmpVault)).rejects.toThrow(/must have frozen: false/);
    });

    it('rejects malformed referenced_by symbols', async () => {
      await writeSchema(`
vault_scope: team
vault_id: t1
hardcoded:
  - path: sop/
    frozen: true
    description: "."
    referenced_by: ["bogus-no-colon"]
llm_curated: []
write_policy:
  canonical: []
  proposed_only: []
  schema_writer: []
`);
      await expect(loader.load(tmpVault)).rejects.toThrow(
        /must match "skill:<name>" or "service:<name>"/,
      );
    });
  });

  describe('integration: real project SCHEMA.md', () => {
    it('parses the Crewly project vault SCHEMA.md', async () => {
      // Verify the SCHEMA.md we shipped for dogfood actually parses.
      const projectVault = path.join(
        '/Users/yellowsunhy/Desktop/projects/crewly-projects/crewly/.crewly/wiki',
      );
      // Skip cleanly if the file isn't where we expect (e.g. CI without .crewly).
      try {
        await fs.access(path.join(projectVault, SCHEMA_FILENAME));
      } catch {
        return;
      }
      const schema = await loader.load(projectVault);
      expect(schema.vault_scope).toBe('project');
      expect(schema.vault_id).toBe('crewly');
      expect(loader.getFrozenPaths(schema)).toContain('memory/');
    });
  });
});
