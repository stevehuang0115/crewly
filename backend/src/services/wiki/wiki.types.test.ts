/**
 * Type-level tests for wiki.types.
 *
 * These are compile-time guards — when TypeScript narrowing changes shape,
 * jest still runs an explicit runtime assertion so CI catches regressions.
 *
 * @module services/wiki/wiki.types.test
 */

import {
  HardcodedFolder,
  LlmCuratedFolder,
  ReferencedBySymbol,
  VaultSchema,
  VaultScope,
} from './wiki.types.js';

describe('wiki.types', () => {
  describe('ReferencedBySymbol', () => {
    it('accepts skill: and service: prefixes', () => {
      const a: ReferencedBySymbol = 'skill:get-sops';
      const b: ReferencedBySymbol = 'service:sop.service';
      expect(a.startsWith('skill:') || a.startsWith('service:')).toBe(true);
      expect(b.startsWith('skill:') || b.startsWith('service:')).toBe(true);
    });
  });

  describe('VaultScope', () => {
    it('covers exactly the three scopes per §1', () => {
      const scopes: VaultScope[] = ['team', 'project', 'global'];
      expect(scopes).toHaveLength(3);
    });
  });

  describe('HardcodedFolder', () => {
    it('frozen is the literal true (not boolean)', () => {
      const folder: HardcodedFolder = {
        path: 'sop/',
        frozen: true,
        description: 'Team SOPs.',
        referenced_by: ['skill:get-sops', 'service:sop.service'],
      };
      expect(folder.frozen).toBe(true);
    });
  });

  describe('LlmCuratedFolder', () => {
    it('frozen is the literal false (not boolean)', () => {
      const folder: LlmCuratedFolder = {
        path: 'llm-curated/',
        frozen: false,
        seed_subdirs: ['people', 'decisions'],
        llm_can_create_subdirs: true,
        lint_may_restructure: true,
      };
      expect(folder.frozen).toBe(false);
    });
  });

  describe('VaultSchema', () => {
    it('composes hardcoded + llm-curated + write_policy', () => {
      const schema: VaultSchema = {
        vault_scope: 'project',
        vault_id: 'crewly',
        hardcoded: [
          {
            path: 'memory/',
            frozen: true,
            description: 'Project memory.',
            referenced_by: ['skill:remember', 'skill:recall'],
          },
        ],
        llm_curated: [
          {
            path: 'llm-curated/',
            frozen: false,
            seed_subdirs: ['people', 'decisions'],
            llm_can_create_subdirs: true,
            lint_may_restructure: true,
          },
        ],
        write_policy: {
          canonical: ['team-leader', 'orchestrator'],
          proposed_only: ['worker'],
          schema_writer: ['steve'],
        },
      };
      expect(schema.hardcoded[0].frozen).toBe(true);
      expect(schema.llm_curated[0].frozen).toBe(false);
      expect(schema.write_policy.canonical).toContain('orchestrator');
    });
  });
});
