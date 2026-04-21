import {
  PRIORITY_RANK,
  PRIORITY_LABEL,
  PRIORITY_VARIANT,
  getMissionStatusType,
  getMissionStatusLabel,
  type MissionPriority,
  type MissionStatus,
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
});
