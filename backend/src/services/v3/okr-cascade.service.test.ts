/**
 * Tests for the OKR Cascade Service — propose / approve / reject workflow.
 *
 * @module services/v3/okr-cascade.service.test
 */

import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { OKRCascadeService, type DecomposeOKRInput } from './okr-cascade.service.js';
import { KRTrackingService } from './kr-tracking.service.js';
import type { Mission } from '../../types/v2/mission.types.js';

// Mock logger so tests do not touch the real logging stack.
jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
      }),
    }),
  },
}));

describe('OKRCascadeService', () => {
  let tempDir: string;
  let originalCwd: () => string;

  /** Write a mission JSON file directly to the temp missions dir. */
  function seedMission(partial: Partial<Mission> & { id: string }): void {
    const dir = join(tempDir, '.crewly', 'missions');
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const mission: Mission = {
      // Defaults first; explicit `partial` fields override them via the spread.
      objective: 'Objective',
      ownerTeamId: 'team-a',
      successCriteria: [],
      currentStrategy: 'strategy',
      activeProjectTaskIds: [],
      cadence: '0 9 * * 1',
      // Minimal policy stub — not exercised by the cascade service.
      policy: { missionId: partial.id } as Mission['policy'],
      status: 'active',
      createdAt: now,
      updatedAt: now,
      learnings: [],
      ...partial,
    };
    writeFileSync(join(dir, `${partial.id}.json`), JSON.stringify(mission, null, 2));
  }

  /** Read a mission JSON file from the temp missions dir. */
  function readMission(id: string): Mission {
    const file = join(tempDir, '.crewly', 'missions', `${id}.json`);
    return JSON.parse(readFileSync(file, 'utf-8')) as Mission;
  }

  const minimalInput = (): DecomposeOKRInput => ({
    children: [
      {
        objective: 'Team OKR alpha',
        currentStrategy: 'do the thing',
        successCriteria: ['criterion'],
        keyResults: [
          {
            title: 'Increase signups',
            metricType: 'number',
            baseline: 0,
            target: 100,
            unit: 'signups',
          },
        ],
      },
    ],
  });

  beforeEach(() => {
    OKRCascadeService.resetInstance();
    KRTrackingService.resetInstance();
    tempDir = join(tmpdir(), `crewly-cascade-svc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    originalCwd = process.cwd;
    process.cwd = () => tempDir;
  });

  afterEach(() => {
    OKRCascadeService.resetInstance();
    KRTrackingService.resetInstance();
    process.cwd = originalCwd;
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('proposeDecomposition', () => {
    it('creates pending-approval children one level below an approved parent', async () => {
      seedMission({ id: 'co-1', level: 'company', approval: { state: 'approved' } });
      const service = OKRCascadeService.getInstance();

      const result = await service.proposeDecomposition('co-1', minimalInput(), 'tl-session');

      expect(result.parentId).toBe('co-1');
      expect(result.childLevel).toBe('team');
      expect(result.childMissionIds).toHaveLength(1);

      const child = readMission(result.childMissionIds[0]);
      expect(child.level).toBe('team');
      expect(child.parentMissionId).toBe('co-1');
      expect(child.approval?.state).toBe('pending_approval');
      expect(child.approval?.proposedBy).toBe('tl-session');
    });

    it('treats a parent with no approval field as approved (legacy)', async () => {
      seedMission({ id: 'co-1', level: 'company' });
      const service = OKRCascadeService.getInstance();
      const result = await service.proposeDecomposition('co-1', minimalInput(), 'tl');
      expect(result.childMissionIds).toHaveLength(1);
    });

    it('persists child KRs via KRTrackingService (single source of KR persistence)', async () => {
      seedMission({ id: 'co-1', level: 'company', approval: { state: 'approved' } });
      const service = OKRCascadeService.getInstance();
      const result = await service.proposeDecomposition('co-1', minimalInput(), 'tl');

      const childId = result.childMissionIds[0];
      const krs = await KRTrackingService.getInstance().listByMission(childId);
      expect(krs).toHaveLength(1);
      expect(krs[0].title).toBe('Increase signups');
      // KR persisted under the child's key-results folder, not duplicated.
      const krDir = join(tempDir, '.crewly', 'missions', childId, 'key-results');
      expect(existsSync(krDir)).toBe(true);
    });

    it('enforces childLevel = parentLevel + 1 (team parent => project child)', async () => {
      seedMission({ id: 'team-1', level: 'team', approval: { state: 'approved' } });
      const service = OKRCascadeService.getInstance();
      const input: DecomposeOKRInput = {
        children: [
          {
            objective: 'Project OKR',
            currentStrategy: 's',
            successCriteria: [],
            projectId: 'proj-xyz',
            keyResults: [],
          },
        ],
      };
      const result = await service.proposeDecomposition('team-1', input, 'tl');
      expect(result.childLevel).toBe('project');
      const child = readMission(result.childMissionIds[0]);
      expect(child.level).toBe('project');
      expect(child.projectId).toBe('proj-xyz');
    });

    it('rejects decomposing a project-level parent (bottom of cascade)', async () => {
      seedMission({ id: 'proj-1', level: 'project', projectId: 'p', approval: { state: 'approved' } });
      const service = OKRCascadeService.getInstance();
      await expect(
        service.proposeDecomposition('proj-1', minimalInput(), 'tl'),
      ).rejects.toThrow(/bottom of the cascade/i);
    });

    it('rejects when the parent is not approved (pending)', async () => {
      seedMission({ id: 'co-1', level: 'company', approval: { state: 'pending_approval' } });
      const service = OKRCascadeService.getInstance();
      await expect(
        service.proposeDecomposition('co-1', minimalInput(), 'tl'),
      ).rejects.toThrow(/not approved/i);
    });

    it('rejects when the parent does not exist', async () => {
      const service = OKRCascadeService.getInstance();
      await expect(
        service.proposeDecomposition('missing', minimalInput(), 'tl'),
      ).rejects.toThrow(/does not exist/i);
    });

    it('rejects when there are no children', async () => {
      seedMission({ id: 'co-1', level: 'company', approval: { state: 'approved' } });
      const service = OKRCascadeService.getInstance();
      await expect(
        service.proposeDecomposition('co-1', { children: [] }, 'tl'),
      ).rejects.toThrow(/at least one child/i);
    });

    it('requires projectId when the child level is project', async () => {
      seedMission({ id: 'team-1', level: 'team', approval: { state: 'approved' } });
      const service = OKRCascadeService.getInstance();
      const input: DecomposeOKRInput = {
        children: [
          { objective: 'P', currentStrategy: 's', successCriteria: [], keyResults: [] },
        ],
      };
      await expect(service.proposeDecomposition('team-1', input, 'tl')).rejects.toThrow(/projectId/i);
    });

    // Regression (finding 4): validation is a PRE-WRITE pass — a later invalid
    // child must NOT leave an earlier (valid) child persisted. Previously
    // validation ran interleaved with persistMission, so child[0] (and its KRs)
    // could land on disk before child[1] failed.
    it('does not persist the first child when a later child is invalid (all-or-nothing)', async () => {
      seedMission({ id: 'team-1', level: 'team', approval: { state: 'approved' } });
      const service = OKRCascadeService.getInstance();
      const input: DecomposeOKRInput = {
        children: [
          // Valid project child.
          { objective: 'Valid', currentStrategy: 's', successCriteria: [], projectId: 'p-1', keyResults: [] },
          // Invalid: project-level child missing projectId.
          { objective: 'Invalid', currentStrategy: 's', successCriteria: [], keyResults: [] },
        ],
      };

      await expect(service.proposeDecomposition('team-1', input, 'tl')).rejects.toThrow(/projectId/i);

      // Nothing from this proposal was written: no pending children exist.
      const pending = await service.listPendingApprovals('team-1');
      expect(pending).toHaveLength(0);

      // And the first (valid) child's objective is nowhere on disk.
      const missionsDir = join(tempDir, '.crewly', 'missions');
      const files = existsSync(missionsDir) ? readdirSync(missionsDir) : [];
      const persistedObjectives = files
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(join(missionsDir, f), 'utf-8')).objective as string);
      expect(persistedObjectives).not.toContain('Valid');
    });
  });

  describe('approveDecomposition', () => {
    it('transitions a pending child to approved with decidedBy/At', async () => {
      seedMission({ id: 'co-1', level: 'company', approval: { state: 'approved' } });
      const service = OKRCascadeService.getInstance();
      const { childMissionIds } = await service.proposeDecomposition('co-1', minimalInput(), 'tl');
      const childId = childMissionIds[0];

      const approved = await service.approveDecomposition(childId, 'steve');
      expect(approved.approval?.state).toBe('approved');
      expect(approved.approval?.decidedBy).toBe('steve');
      expect(approved.approval?.decidedAt).toBeDefined();

      // Persisted.
      expect(readMission(childId).approval?.state).toBe('approved');
    });

    it('rejects approving an already-approved (terminal) mission', async () => {
      seedMission({ id: 'co-1', level: 'company', approval: { state: 'approved' } });
      const service = OKRCascadeService.getInstance();
      await expect(service.approveDecomposition('co-1', 'steve')).rejects.toThrow(/cannot approve/i);
    });

    it('rejects approving a missing mission', async () => {
      const service = OKRCascadeService.getInstance();
      await expect(service.approveDecomposition('nope', 'steve')).rejects.toThrow(/does not exist/i);
    });
  });

  describe('rejectDecomposition', () => {
    it('transitions a pending child to rejected with a reason', async () => {
      seedMission({ id: 'co-1', level: 'company', approval: { state: 'approved' } });
      const service = OKRCascadeService.getInstance();
      const { childMissionIds } = await service.proposeDecomposition('co-1', minimalInput(), 'tl');
      const childId = childMissionIds[0];

      const rejected = await service.rejectDecomposition(childId, 'steve', 'too vague');
      expect(rejected.approval?.state).toBe('rejected');
      expect(rejected.approval?.rejectionReason).toBe('too vague');
      expect(rejected.approval?.decidedBy).toBe('steve');
    });

    it('requires a non-empty reason', async () => {
      seedMission({ id: 'co-1', level: 'company', approval: { state: 'approved' } });
      const service = OKRCascadeService.getInstance();
      const { childMissionIds } = await service.proposeDecomposition('co-1', minimalInput(), 'tl');
      await expect(
        service.rejectDecomposition(childMissionIds[0], 'steve', '   '),
      ).rejects.toThrow(/non-empty reason/i);
    });
  });

  describe('listPendingApprovals', () => {
    it('lists only pending missions, optionally scoped by parent', async () => {
      seedMission({ id: 'co-1', level: 'company', approval: { state: 'approved' } });
      seedMission({ id: 'co-2', level: 'company', approval: { state: 'approved' } });
      const service = OKRCascadeService.getInstance();
      const a = await service.proposeDecomposition('co-1', minimalInput(), 'tl');
      await service.proposeDecomposition('co-2', minimalInput(), 'tl');

      const all = await service.listPendingApprovals();
      expect(all.length).toBe(2);

      const scoped = await service.listPendingApprovals('co-1');
      expect(scoped.length).toBe(1);
      expect(scoped[0].id).toBe(a.childMissionIds[0]);
    });
  });

  // Regression (finding 5): the service resolves a level-less, parentless legacy
  // mission via the SAME canonical resolver as the routes' read-migration. A
  // parentless legacy mission must resolve to `company` (so its child is
  // `team`), matching resolveMissionLevel rather than the old hardcoded 'team'.
  describe('legacy level resolution (finding 5)', () => {
    it('resolves a parentless level-less legacy mission to company (child => team)', async () => {
      // No `level` field at all (legacy), and no parent.
      seedMission({ id: 'legacy-co', approval: { state: 'approved' } });
      const service = OKRCascadeService.getInstance();
      const result = await service.proposeDecomposition('legacy-co', minimalInput(), 'tl');
      // company + 1 === team proves the parent resolved to company.
      expect(result.childLevel).toBe('team');
    });
  });

  // Regression (finding 6): a corrupt/hand-edited approval.state must be treated
  // as INACTIVE on read — neither cascade-active nor a recognized pending state
  // — and must never crash the transition guards.
  describe('corrupt approval.state read-time normalization (finding 6)', () => {
    it('treats an unrecognized approval.state as inactive (not approvable, not pending)', async () => {
      // Hand-edited corrupt state.
      seedMission({
        id: 'corrupt-1',
        level: 'company',
        approval: { state: 'frozen' as unknown as 'approved' },
      });
      const service = OKRCascadeService.getInstance();

      // Not cascade-active: cannot be decomposed (treated as not-approved).
      await expect(
        service.proposeDecomposition('corrupt-1', minimalInput(), 'tl'),
      ).rejects.toThrow(/not approved/i);

      // Not a recognized pending state: excluded from pending approvals.
      const pending = await service.listPendingApprovals();
      expect(pending.find((m) => m.id === 'corrupt-1')).toBeUndefined();

      // The transition guard does not crash; approving a normalized-rejected
      // doc is rejected cleanly.
      await expect(service.approveDecomposition('corrupt-1', 'steve')).rejects.toThrow(/cannot approve/i);
    });
  });
});
