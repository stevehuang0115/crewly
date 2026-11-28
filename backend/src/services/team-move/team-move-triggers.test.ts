import type { Trigger } from '../../types/v2/trigger.types.js';
import {
  engineTriggerStore,
  isTriggerStorePath,
  selectLiveTeamTriggers,
  selectTeamTriggers,
  triggerLabel,
  triggerReport,
  triggerWarnings,
  type TeamMoveTriggerEngine,
} from './team-move-triggers.js';

const row = (id: string, teamId: string | undefined, status: Trigger['status'], name?: string): Trigger => ({ id, teamId, status, name }) as Trigger;

describe('team move triggers', () => {
  const rows = [row('a', 't1', 'active'), row('b', 't1', 'paused'), row('c', 't1', 'cancelled'), row('d', 't1', 'exhausted'), row('e', 't2', 'active'), row('f', undefined, 'active')];

  it('selects a team\'s triggers, and the live ones for the package', () => {
    expect(selectTeamTriggers(rows, 't1').map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(selectLiveTeamTriggers(rows, 't1').map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('knows a trigger store file', () => {
    expect(isTriggerStorePath('triggers/triggers.json')).toBe(true);
    expect(isTriggerStorePath('triggers')).toBe(true);
    expect(isTriggerStorePath('knowledge/triggers.json')).toBe(false);
    expect(isTriggerStorePath('triggers-notes.md')).toBe(false);
  });

  it('labels a trigger by name and id', () => {
    expect(triggerLabel({ id: '0123456789', name: 'daily' })).toBe('daily (01234567)');
    expect(triggerLabel({ id: '0123456789' })).toBe('01234567');
    expect(triggerLabel(null)).toBe('unnamed trigger');
  });

  it('names every imported, skipped and failed trigger', () => {
    const report = triggerReport({
      imported: [row('imp-1', 't1', 'active', 'one')],
      skipped: [{ row: row('skp-1', 't1', 'active', 'two'), reason: 'here' }],
      failed: [{ row: { name: 'three' }, reason: 'no id' }],
    });
    expect(report).toEqual({ imported: ['one (imp-1)'], skipped: [{ trigger: 'two (skp-1)', reason: 'here' }], failed: [{ trigger: 'three', reason: 'no id' }] });
    const text = triggerWarnings(report);
    expect(text[0]).toContain('three: no id');
    expect(text[1]).toContain('two (skp-1): here');
    expect(text[2]).toContain('one (imp-1)');
  });

  it('says so when a package carries no schedules, and nothing when there were none', () => {
    expect(triggerWarnings(null)).toEqual([expect.stringContaining('carries no schedules')]);
    expect(triggerWarnings({ imported: [], skipped: [], failed: [] })).toEqual([]);
  });

  describe('engineTriggerStore', () => {
    const engine = (running: () => boolean): jest.Mocked<TeamMoveTriggerEngine> =>
      ({
        isRunning: jest.fn(running),
        list: jest.fn(() => rows),
        restoreTriggers: jest.fn(),
        armTriggers: jest.fn(),
        delete: jest.fn(async (id: string) => id !== 'gone'),
      }) as unknown as jest.Mocked<TeamMoveTriggerEngine>;

    it('waits until the engine has loaded its store', async () => {
      let looks = 0;
      const sleep = jest.fn(async () => undefined);
      const store = engineTriggerStore(() => engine(() => ++looks > 3), { sleep });
      await expect(store.list()).resolves.toHaveLength(rows.length);
      expect(sleep).toHaveBeenCalledTimes(3);
    });

    it('fails instead of listing nothing when the engine never runs', async () => {
      const e = engine(() => false);
      const store = engineTriggerStore(() => e, { sleep: async () => undefined, timeoutMs: 1000 });
      await expect(store.list()).rejects.toThrow(/not running/);
      await expect(store.remove(['a'])).rejects.toThrow(/not running/);
      expect(e.list).not.toHaveBeenCalled();
      expect(e.delete).not.toHaveBeenCalled();
    });

    it('removes one by one and counts what was there', async () => {
      const e = engine(() => true);
      await expect(engineTriggerStore(() => e).remove(['a', 'gone', 'b'])).resolves.toBe(2);
      expect(e.delete.mock.calls.map((c) => c[0])).toEqual(['a', 'gone', 'b']);
    });
  });
});
