import {
  PRIORITY_RANK,
  PRIORITY_LABEL,
  PRIORITY_VARIANT,
  getMissionStatusType,
  getMissionStatusLabel,
  PARENT_LEVEL,
  MISSION_LEVELS,
  LEVEL_LABEL,
  PROPOSAL_STATE_LABEL,
  KR_STATUSES,
  KR_STATUS_LABEL,
  KR_STATUS_VARIANT,
  resolveLevel,
  buildMissionTree,
  computeKrProgressPercent,
  formatKrValue,
  countKrStatuses,
  summaryToKrStatusCounts,
  flattenCascadeSummary,
  progressToStatus,
  type MissionPriority,
  type MissionStatus,
  type CascadeOKRSummary,
} from './mission.types';

describe('mission.types', () => {
  describe('PRIORITY_RANK', () => {
    it('orders critical < high < medium < low (lower = higher priority)', () => {
      expect(PRIORITY_RANK.critical).toBeLessThan(PRIORITY_RANK.high);
      expect(PRIORITY_RANK.high).toBeLessThan(PRIORITY_RANK.medium);
      expect(PRIORITY_RANK.medium).toBeLessThan(PRIORITY_RANK.low);
    });

    it('has exactly one entry per MissionPriority', () => {
      const keys: MissionPriority[] = ['critical', 'high', 'medium', 'low'];
      expect(Object.keys(PRIORITY_RANK).sort()).toEqual(keys.sort());
    });
  });

  describe('PRIORITY_LABEL / PRIORITY_VARIANT', () => {
    it('provides a label for every priority', () => {
      (['critical', 'high', 'medium', 'low'] as MissionPriority[]).forEach((p) => {
        expect(PRIORITY_LABEL[p]).toBeTruthy();
        expect(PRIORITY_VARIANT[p]).toBeTruthy();
      });
    });
  });

  describe('getMissionStatusType', () => {
    it('maps cancelled to the inactive StatusType (design decision, not identity)', () => {
      expect(getMissionStatusType('cancelled')).toBe('inactive');
    });

    it('returns the identity mapping for active / paused / completed', () => {
      expect(getMissionStatusType('active')).toBe('active');
      expect(getMissionStatusType('paused')).toBe('paused');
      expect(getMissionStatusType('completed')).toBe('completed');
    });
  });

  describe('getMissionStatusLabel', () => {
    it('title-cases each status', () => {
      const expected: Record<MissionStatus, string> = {
        active: 'Active',
        paused: 'Paused',
        completed: 'Completed',
        cancelled: 'Cancelled',
      };
      (Object.keys(expected) as MissionStatus[]).forEach((s) => {
        expect(getMissionStatusLabel(s)).toBe(expected[s]);
      });
    });
  });
  // ---------------------------------------------------------------------------
  // OKR cascade helpers
  // ---------------------------------------------------------------------------

  describe('levels / proposal states', () => {
    it('company is a root; team needs company; project needs team', () => {
      expect(PARENT_LEVEL.company).toBeNull();
      expect(PARENT_LEVEL.team).toBe('company');
      expect(PARENT_LEVEL.project).toBe('team');
      expect(MISSION_LEVELS).toEqual(['company', 'team', 'project']);
      MISSION_LEVELS.forEach((l) => expect(LEVEL_LABEL[l]).toBeTruthy());
    });

    it('labels every proposal state and KR status', () => {
      expect(Object.keys(PROPOSAL_STATE_LABEL).sort()).toEqual(['approved', 'draft', 'pending_approval', 'rejected']);
      KR_STATUSES.forEach((s) => {
        expect(KR_STATUS_LABEL[s]).toBeTruthy();
        expect(KR_STATUS_VARIANT[s]).toBeTruthy();
      });
    });
  });

  describe('resolveLevel', () => {
    it('prefers the explicit level', () => {
      expect(resolveLevel({ level: 'project' }, new Map())).toBe('project');
    });

    it('derives the level from parent depth for legacy payloads', () => {
      const byId = new Map([
        ['co', { parentMissionId: undefined }],
        ['team', { parentMissionId: 'co' }],
      ]);
      expect(resolveLevel({ parentMissionId: undefined }, byId)).toBe('company');
      expect(resolveLevel({ parentMissionId: 'co' }, byId)).toBe('team');
      expect(resolveLevel({ parentMissionId: 'team' }, byId)).toBe('project');
    });

    it('does not loop on a cyclic parent chain', () => {
      const byId = new Map([
        ['a', { parentMissionId: 'b' }],
        ['b', { parentMissionId: 'a' }],
      ]);
      expect(resolveLevel({ parentMissionId: 'a' }, byId)).toBe('project');
    });
  });

  describe('buildMissionTree', () => {
    it('nests children under parents and promotes orphans to roots', () => {
      const tree = buildMissionTree([
        { id: 'proj', parentMissionId: 'team' },
        { id: 'team', parentMissionId: 'co' },
        { id: 'co' },
        { id: 'orphan', parentMissionId: 'ghost' },
      ]);
      expect(tree.map((n) => n.mission.id)).toEqual(['co', 'orphan']);
      expect(tree[0].children.map((n) => n.mission.id)).toEqual(['team']);
      expect(tree[0].children[0].children.map((n) => n.mission.id)).toEqual(['proj']);
    });

    it('applies the comparator to every sibling group', () => {
      const tree = buildMissionTree(
        [
          { id: 'b' },
          { id: 'a' },
          { id: 'b2', parentMissionId: 'b' },
          { id: 'b1', parentMissionId: 'b' },
        ],
        (x, y) => x.id.localeCompare(y.id),
      );
      expect(tree.map((n) => n.mission.id)).toEqual(['a', 'b']);
      expect(tree[1].children.map((n) => n.mission.id)).toEqual(['b1', 'b2']);
    });

    it('treats a self-parent as a root', () => {
      const tree = buildMissionTree([{ id: 'x', parentMissionId: 'x' }]);
      expect(tree).toHaveLength(1);
      expect(tree[0].children).toHaveLength(0);
    });
  });

  describe('computeKrProgressPercent / formatKrValue / progressToStatus', () => {
    it('computes clamped 0–100 progress for higher- and lower-is-better KRs', () => {
      expect(computeKrProgressPercent({ baseline: 0, target: 100, current: 25 })).toBe(25);
      expect(computeKrProgressPercent({ baseline: 30, target: 5, current: 5 })).toBe(100);
      expect(computeKrProgressPercent({ baseline: 0, target: 10, current: 50 })).toBe(100);
      expect(computeKrProgressPercent({ baseline: 0, target: 10, current: -5 })).toBe(0);
      expect(computeKrProgressPercent({ baseline: 5, target: 5, current: 4 })).toBe(0);
      expect(computeKrProgressPercent({ baseline: 5, target: 5, current: 5 })).toBe(100);
    });

    it('formats values per metric type', () => {
      expect(formatKrValue(1500, 'currency', '$')).toBe('$1,500');
      expect(formatKrValue(42, 'percentage', '')).toBe('42%');
      expect(formatKrValue(1, 'boolean', '')).toBe('Yes');
      expect(formatKrValue(0, 'boolean', '')).toBe('No');
      expect(formatKrValue(200, 'number', 'ms')).toBe('200 ms');
    });

    it('maps progress to the backend status bands', () => {
      expect(progressToStatus(100)).toBe('achieved');
      expect(progressToStatus(50)).toBe('on_track');
      expect(progressToStatus(25)).toBe('at_risk');
      expect(progressToStatus(0)).toBe('off_track');
    });
  });

  describe('KR status counts + cascade flattening', () => {
    it('counts inline KR statuses', () => {
      const counts = countKrStatuses([{ status: 'on_track' }, { status: 'on_track' }, { status: 'achieved' }]);
      expect(counts.on_track).toBe(2);
      expect(counts.achieved).toBe(1);
      expect(counts.off_track).toBe(0);
      expect(countKrStatuses(undefined).not_started).toBe(0);
    });

    it('converts an OKR summary into counts', () => {
      const counts = summaryToKrStatusCounts({
        missionId: 'm',
        totalKRs: 4,
        achieved: 1,
        onTrack: 1,
        atRisk: 1,
        offTrack: 1,
        notStarted: 0,
        overallProgress: 50,
        recommendation: 'continue',
      });
      expect(counts).toEqual({ achieved: 1, on_track: 1, at_risk: 1, off_track: 1, not_started: 0 });
    });

    it('flattens a cascade tree into an id → summary map', () => {
      const leaf = (missionId: string, level: 'team' | 'project'): CascadeOKRSummary => ({
        missionId,
        level,
        totalKRs: 0,
        achieved: 0,
        onTrack: 0,
        atRisk: 0,
        offTrack: 0,
        notStarted: 0,
        overallProgress: 0,
        recommendation: 'continue',
        childMissionCount: 0,
        rolledUpProgress: 10,
        children: [],
      });
      const root: CascadeOKRSummary = {
        ...leaf('co', 'team'),
        level: 'company',
        childMissionCount: 1,
        rolledUpProgress: 55,
        children: [{ ...leaf('team', 'team'), childMissionCount: 1, children: [leaf('proj', 'project')] }],
      };
      const map = flattenCascadeSummary(root);
      expect(Array.from(map.keys()).sort()).toEqual(['co', 'proj', 'team']);
      expect(map.get('co')?.rolledUpProgress).toBe(55);
      expect(map.get('proj')?.level).toBe('project');
    });
  });
});
