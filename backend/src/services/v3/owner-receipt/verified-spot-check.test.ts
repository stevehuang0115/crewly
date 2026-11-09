/**
 * Tests for the verified-work spot-check (#1315, phase 1).
 */

import type { WorkItem } from '../../../types/v2/work-item.types.js';
import { daySeed, renderSpotCheck, runSpotCheck, seededRandom, type SpotCheckResult } from './verified-spot-check.js';

const NOW = new Date('2026-10-21T12:00:00Z');

/**
 * A verified WorkItem completed `hoursAgo` hours before NOW.
 *
 * @param id - Item id
 * @param evidence - Recorded evidence entries
 * @param over - Field overrides
 * @param hoursAgo - Hours between completion and NOW
 * @returns WorkItem
 */
function wi(id: string, evidence: unknown[], over: Partial<WorkItem> = {}, hoursAgo = 2): WorkItem {
  return {
    id,
    type: 'task',
    owner: 'team_lead',
    target: 'atlas',
    title: id,
    status: 'verified',
    createdAt: '2026-10-20T00:00:00Z',
    completedAt: new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString(),
    output: { evidence },
    ...over,
  } as WorkItem;
}

const teamOf = (s: string): string | null => (s === 'atlas' ? 'Think Tank' : null);

describe('runSpotCheck', () => {
  it('passes an artifact that still exists', async () => {
    const r = await runSpotCheck({ workItems: [wi('a', [{ type: 'artifact', path: '/x/a.md' }])], now: NOW, teamOf, exists: async () => true });
    expect(r).toMatchObject({ sampled: 1, artifactsChecked: 1, skipped: 0, discrepancies: [] });
  });

  it('reports a missing artifact with the WorkItem id, team and path', async () => {
    const r = await runSpotCheck({ workItems: [wi('a', [{ type: 'artifact', path: '/x/a.md' }])], now: NOW, teamOf, exists: async () => false });
    expect(r.discrepancies).toEqual([{ workItemId: 'a', team: 'Think Tank', artifactPath: '/x/a.md' }]);
  });

  it('skips URLs and commands and counts them', async () => {
    const exists = jest.fn(async () => true);
    const r = await runSpotCheck({
      workItems: [
        wi('a', [
          { type: 'artifact', path: '/x/a.md' },
          { type: 'artifact', path: 'https://example.com/p' },
          { type: 'command', command: 'test -s /x/a.md', exitCode: 0 },
        ]),
      ],
      now: NOW,
      teamOf,
      exists,
    });
    expect(r).toMatchObject({ sampled: 1, artifactsChecked: 1, skipped: 2 });
    expect(exists).toHaveBeenCalledTimes(1);
  });

  it('resolves a relative path against the recorded project path, and a ~ path against home', async () => {
    const seen: string[] = [];
    await runSpotCheck({
      workItems: [wi('a', [{ type: 'artifact', path: 'out/a.md' }, { type: 'artifact', path: '~/b.md' }], { metadata: { projectPath: '/proj' } })],
      now: NOW,
      teamOf,
      homeDir: '/home/u',
      exists: async (p) => {
        seen.push(p);
        return true;
      },
    });
    expect(seen).toEqual(['/proj/out/a.md', '/home/u/b.md']);
  });

  it('counts a relative path with nothing to resolve it against as skipped, not a discrepancy', async () => {
    const r = await runSpotCheck({ workItems: [wi('a', [{ type: 'artifact', path: 'out/a.md' }])], now: NOW, teamOf, exists: async () => false });
    expect(r).toMatchObject({ sampled: 1, artifactsChecked: 0, skipped: 1, discrepancies: [] });
  });

  it('only samples verified items completed inside the window', async () => {
    const ev = [{ type: 'artifact', path: '/x/a.md' }];
    const r = await runSpotCheck({
      workItems: [wi('old', ev, {}, 30), wi('running', ev, { status: 'running' }), wi('nocomplete', ev, { completedAt: undefined }), wi('ok', ev)],
      now: NOW,
      teamOf,
      exists: async () => true,
    });
    expect(r.eligible).toBe(1);
    expect(r.sampled).toBe(1);
  });

  it('shows zero explicitly when there is nothing to sample', async () => {
    const r = await runSpotCheck({ workItems: [], now: NOW, teamOf, exists: async () => true });
    expect(r).toMatchObject({ eligible: 0, sampled: 0, skipped: 0, discrepancies: [] });
    expect(renderSpotCheck(r)).toContain('0 sampled, 0 discrepancies');
  });

  it('picks at most the sample size, the same items for the same seed', async () => {
    const items = Array.from({ length: 12 }, (_, i) => wi(`w${String(i).padStart(2, '0')}`, [{ type: 'artifact', path: `/x/${i}.md` }]));
    const run = () => runSpotCheck({ workItems: items, now: NOW, teamOf, exists: async () => false, random: seededRandom(7) });
    const a = await run();
    const b = await run();
    expect(a.sampled).toBe(5);
    expect(a.discrepancies.map((d) => d.workItemId)).toEqual(b.discrepancies.map((d) => d.workItemId));
    const c = await runSpotCheck({ workItems: items, now: NOW, teamOf, exists: async () => false, random: seededRandom(8), sampleSize: 3 });
    expect(c.sampled).toBe(3);
  });

  it('treats a throwing file check as missing', async () => {
    const r = await runSpotCheck({
      workItems: [wi('a', [{ type: 'artifact', path: '/x/a.md' }])],
      now: NOW,
      teamOf,
      exists: async () => {
        throw new Error('EACCES');
      },
    });
    expect(r.discrepancies).toHaveLength(1);
  });

  describe('worktrees the janitor removes', () => {
    const only = (gone: string[]) => async (p: string) => !gone.some((g) => p === g || p.startsWith(`${g}/`));

    it('counts a file in a cleaned marker-path worktree as skipped (worktree cleaned), not a discrepancy', async () => {
      const root = '/repo/.claude/worktrees/agent-1';
      const r = await runSpotCheck({
        workItems: [wi('a', [{ type: 'artifact', path: `${root}/out/a.md` }])],
        now: NOW,
        teamOf,
        exists: only([root]),
      });
      expect(r).toMatchObject({ sampled: 1, artifactsChecked: 0, skipped: 1, worktreeCleaned: 1, discrepancies: [] });
    });

    it('counts a relative path under the WorkItem\'s recorded, now-removed worktree as skipped', async () => {
      const root = '/somewhere/wt-7';
      const r = await runSpotCheck({
        workItems: [wi('a', [{ type: 'artifact', path: 'out/a.md' }], { metadata: { worktree: { path: root, workdir: root } } })],
        now: NOW,
        teamOf,
        exists: only([root]),
      });
      expect(r).toMatchObject({ skipped: 1, worktreeCleaned: 1, discrepancies: [] });
    });

    it('reports missing when the worktree still exists', async () => {
      const r = await runSpotCheck({
        workItems: [wi('a', [{ type: 'artifact', path: '/repo/.crewly/worktrees/wi-1/out/a.md' }])],
        now: NOW,
        teamOf,
        exists: only(['/repo/.crewly/worktrees/wi-1/out/a.md']),
      });
      expect(r.discrepancies).toHaveLength(1);
      expect(r.worktreeCleaned).toBe(0);
    });

    it('reports missing when the path is outside any worktree', async () => {
      const r = await runSpotCheck({ workItems: [wi('a', [{ type: 'artifact', path: '/data/a.md' }])], now: NOW, teamOf, exists: async () => false });
      expect(r.discrepancies).toHaveLength(1);
    });
  });

  it('never mutates the WorkItems', async () => {
    const items = [wi('a', [{ type: 'artifact', path: '/x/a.md' }, { type: 'command', command: 'x', exitCode: 0 }])];
    const before = JSON.stringify(items);
    await runSpotCheck({ workItems: items, now: NOW, teamOf, exists: async () => false });
    expect(JSON.stringify(items)).toBe(before);
  });
});

describe('seededRandom / daySeed', () => {
  it('is repeatable and in [0, 1)', () => {
    const a = seededRandom(1);
    const b = seededRandom(1);
    for (let i = 0; i < 5; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('gives one seed per day', () => {
    expect(daySeed(new Date('2026-10-21T01:00:00Z'))).toBe(daySeed(new Date('2026-10-21T23:00:00Z')));
    expect(daySeed(new Date('2026-10-22T01:00:00Z'))).not.toBe(daySeed(new Date('2026-10-21T01:00:00Z')));
  });
});

describe('renderSpotCheck', () => {
  const base: SpotCheckResult = { at: NOW.toISOString(), eligible: 3, sampled: 3, artifactsChecked: 3, skipped: 0, worktreeCleaned: 0, discrepancies: [] };

  it('says zero discrepancies out loud', () => {
    expect(renderSpotCheck(base)).toBe('*Spot-check of verified work:* 3 sampled, 0 discrepancies');
  });

  it('lists discrepancies by team and path, never the WorkItem id, capped with +N more', () => {
    const d = (n: number) => ({ workItemId: `wi-${n}`, team: 'CE', artifactPath: `/x/${n}.md` });
    const text = renderSpotCheck({ ...base, discrepancies: [d(1), d(2), d(3), d(4)] });
    expect(text).toContain('3 sampled, 4 discrepancies');
    expect(text).toContain('• CE: `/x/1.md` is gone');
    expect(text).toContain('• +1 more');
    expect(text).not.toContain('wi-');
  });

  it('uses the singular for one', () => {
    expect(renderSpotCheck({ ...base, discrepancies: [{ workItemId: 'w', team: 'CE', artifactPath: '/x' }] })).toContain('1 discrepancy');
  });
});
