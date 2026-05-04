/**
 * Unit tests for WorkingMemoryModule.
 *
 * Covers:
 *   - Module metadata (name / priority / maxTokens / compactable).
 *   - shouldInclude gating on sessionName + projectPath/projectRoot.
 *   - build() delegates to WorkingMemoryService.getWakeCardForAgent
 *     with the correct request shape.
 *   - Fail-soft: service errors are swallowed and empty string is
 *     returned so prompt assembly never breaks.
 *   - Empty service result collapses to '' (assembler then drops the
 *     module entry instead of emitting an empty heading).
 *   - Registration in PromptAssemblyService default modules — guards
 *     against accidental removal during future module reshuffles.
 *
 * @module services/ai/prompt-modules/working-memory.module.test
 */

import { WorkingMemoryModule } from './working-memory.module.js';
import { ModuleConfig } from './prompt-module.interface.js';
import { WorkingMemoryService } from '../../memory/working-memory.service.js';
import { PromptAssemblyService } from './prompt-assembly.service.js';

describe('WorkingMemoryModule', () => {
  let module: WorkingMemoryModule;

  const baseConfig: ModuleConfig = {
    sessionName: 'crewly-product-max-358c7cb7',
    memberId: '358c7cb7-eb20-482a-87b2-655eb8cdde4e',
    role: 'developer',
    teamId: '28a4ac10-f37f-4286-ad8c-6926a0e177f5',
    projectPath: '/Users/me/projects/crewly',
    agentSkillsPath: '/path/to/skills/agent',
    tlSkillsPath: '/path/to/skills/team-leader',
    projectRoot: '/Users/me/projects/crewly',
  };

  beforeEach(() => {
    WorkingMemoryService.clearInstance();
    module = new WorkingMemoryModule();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    WorkingMemoryService.clearInstance();
  });

  // -------------------------------------------------------------------------
  // Module metadata
  // -------------------------------------------------------------------------

  describe('metadata', () => {
    it('declares name="working-memory"', () => {
      expect(module.name).toBe('working-memory');
    });

    it('declares priority=8 — after MissionCard (7) and TeamReference (6)', () => {
      expect(module.priority).toBe(8);
    });

    it('declares maxTokens=400 — covers the 1.5KB hard cap with margin', () => {
      // Service caps card at 1536 bytes; 1536/4 ≈ 384 tokens. Module budgets
      // 400 to leave headroom for the markdown heading and assembler
      // separators added during composition.
      expect(module.maxTokens).toBe(400);
      expect(module.maxTokens).toBeGreaterThanOrEqual(384);
    });

    it('declares compactable=false — wake card must not be 50%-trimmed', () => {
      // The wake card carries structured "Required next action" / "Known
      // constraints" sections. The assembler's 50% trim heuristic would cut
      // them mid-line and destroy the agent's actionable context. Better to
      // emit the full card or skip it (via empty return) than to truncate.
      expect(module.compactable).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // shouldInclude gating
  // -------------------------------------------------------------------------

  describe('shouldInclude', () => {
    it('returns true for a fully-populated config', () => {
      expect(module.shouldInclude(baseConfig)).toBe(true);
    });

    it('returns false when sessionName is empty', () => {
      const cfg: ModuleConfig = { ...baseConfig, sessionName: '' };
      expect(module.shouldInclude(cfg)).toBe(false);
    });

    it('returns false when both projectPath and projectRoot are missing', () => {
      const cfg: ModuleConfig = {
        ...baseConfig,
        projectPath: undefined,
        projectRoot: '',
      };
      expect(module.shouldInclude(cfg)).toBe(false);
    });

    it('returns true when only projectRoot is set (legacy SessionConfig path)', () => {
      const cfg: ModuleConfig = {
        ...baseConfig,
        projectPath: undefined,
      };
      expect(module.shouldInclude(cfg)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // build() — service delegation
  // -------------------------------------------------------------------------

  describe('build', () => {
    it('delegates to WorkingMemoryService.getWakeCardForAgent and returns its output verbatim', async () => {
      const expectedCard = '## Why You Are Awake\n\n- Trigger: WorkItem wi-123 (running)';
      const spy = jest
        .spyOn(WorkingMemoryService.prototype, 'getWakeCardForAgent')
        .mockResolvedValue(expectedCard);

      const result = await module.build(baseConfig);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(result).toBe(expectedCard);
    });

    it('passes memberId as agentId when present (better log correlation)', async () => {
      const spy = jest
        .spyOn(WorkingMemoryService.prototype, 'getWakeCardForAgent')
        .mockResolvedValue('');

      await module.build(baseConfig);

      expect(spy).toHaveBeenCalledWith({
        agentId: baseConfig.memberId,
        sessionName: baseConfig.sessionName,
        projectPath: baseConfig.projectPath,
        teamId: baseConfig.teamId,
      });
    });

    it('falls back to sessionName as agentId when memberId is empty', async () => {
      const spy = jest
        .spyOn(WorkingMemoryService.prototype, 'getWakeCardForAgent')
        .mockResolvedValue('');

      const cfg: ModuleConfig = { ...baseConfig, memberId: '' };
      await module.build(cfg);

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: cfg.sessionName,
          sessionName: cfg.sessionName,
        }),
      );
    });

    it('falls back to projectRoot when projectPath is undefined', async () => {
      const spy = jest
        .spyOn(WorkingMemoryService.prototype, 'getWakeCardForAgent')
        .mockResolvedValue('');

      const cfg: ModuleConfig = { ...baseConfig, projectPath: undefined };
      await module.build(cfg);

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ projectPath: cfg.projectRoot }),
      );
    });

    it('returns empty string when the service returns empty (no active WorkItem)', async () => {
      jest
        .spyOn(WorkingMemoryService.prototype, 'getWakeCardForAgent')
        .mockResolvedValue('');

      const result = await module.build(baseConfig);

      expect(result).toBe('');
    });

    it('fails soft and returns "" when the service throws', async () => {
      jest
        .spyOn(WorkingMemoryService.prototype, 'getWakeCardForAgent')
        .mockRejectedValue(new Error('TaskPool unavailable'));

      const result = await module.build(baseConfig);

      // compactable=false would normally cause the assembler to re-throw
      // an unhandled module error. The module swallows here so a wake-card
      // lookup failure cannot break prompt assembly for the agent.
      expect(result).toBe('');
    });

    it('returns "" defensively when both projectPath and projectRoot are missing', async () => {
      const spy = jest
        .spyOn(WorkingMemoryService.prototype, 'getWakeCardForAgent')
        .mockResolvedValue('IGNORED');

      const cfg: ModuleConfig = {
        ...baseConfig,
        projectPath: undefined,
        projectRoot: '',
      };
      const result = await module.build(cfg);

      // shouldInclude=false should already gate this off; the build()
      // defensive check ensures we never call the service with a
      // malformed projectPath even if the assembler bypasses shouldInclude.
      expect(result).toBe('');
      expect(spy).not.toHaveBeenCalled();
    });

    it('passes teamId through to the service when present', async () => {
      const spy = jest
        .spyOn(WorkingMemoryService.prototype, 'getWakeCardForAgent')
        .mockResolvedValue('');

      await module.build(baseConfig);

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: baseConfig.teamId }),
      );
    });

    it('passes teamId=undefined when not present (does not synthesize a value)', async () => {
      const spy = jest
        .spyOn(WorkingMemoryService.prototype, 'getWakeCardForAgent')
        .mockResolvedValue('');

      const cfg: ModuleConfig = { ...baseConfig, teamId: undefined };
      await module.build(cfg);

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: undefined }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Registration in PromptAssemblyService — wire-level guard
  // -------------------------------------------------------------------------

  describe('PromptAssemblyService registration', () => {
    it('is registered in the default module set', () => {
      const assembler = new PromptAssemblyService();
      const modules = assembler.getModules();
      const found = modules.find((m) => m.name === 'working-memory');

      expect(found).toBeDefined();
      expect(found).toBeInstanceOf(WorkingMemoryModule);
    });

    it('lands at priority 8 in the assembler', () => {
      const assembler = new PromptAssemblyService();
      const modules = assembler.getModules();
      const found = modules.find((m) => m.name === 'working-memory');

      expect(found?.priority).toBe(8);
    });

    it('is positioned after team_references and before lower-priority modules', () => {
      // Sanity-check ordering: when the assembler sorts by priority asc,
      // team_references must come before working-memory, and working-memory
      // must come before learning-reference / lifecycle (priority > 8).
      // NOTE: TeamReferenceModule's `name` field is the snake_case
      // 'team_references' (see team-reference.module.ts), not the
      // hyphenated file slug.
      const assembler = new PromptAssemblyService();
      const sorted = [...assembler.getModules()].sort(
        (a, b) => a.priority - b.priority,
      );
      const idxTeamRef = sorted.findIndex((m) => m.name === 'team_references');
      const idxWake = sorted.findIndex((m) => m.name === 'working-memory');

      expect(idxTeamRef).toBeGreaterThanOrEqual(0);
      expect(idxWake).toBeGreaterThan(idxTeamRef);
    });
  });
});
