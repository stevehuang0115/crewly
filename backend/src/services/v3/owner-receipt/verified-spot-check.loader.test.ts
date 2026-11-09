/**
 * Tests for the spot-check loader (#1315).
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { WorkItem } from '../../../types/v2/work-item.types.js';
import { createSpotCheckLoader } from './verified-spot-check.loader.js';

const NOW = new Date('2026-10-21T12:00:00Z');

/**
 * A verified WorkItem with one file artifact.
 *
 * @param id - Item id
 * @param file - Artifact path
 * @returns WorkItem
 */
function item(id: string, file: string): WorkItem {
  return {
    id,
    type: 'task',
    owner: 'team_lead',
    target: 'atlas',
    title: id,
    status: 'verified',
    createdAt: '2026-10-20T00:00:00Z',
    completedAt: '2026-10-21T10:00:00Z',
    output: { evidence: [{ type: 'artifact', path: file }] },
  } as unknown as WorkItem;
}

describe('createSpotCheckLoader', () => {
  it('checks the real disk: an existing file passes, a deleted one is a discrepancy', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spot-check-'));
    try {
      const here = path.join(dir, 'here.md');
      await fs.writeFile(here, 'x');
      const load = createSpotCheckLoader({
        listWorkItems: async () => [item('a', here), item('b', path.join(dir, 'gone.md'))],
        loadTeamIndex: async () => new Map([['atlas', 'Think Tank']]),
      });
      const r = await load(NOW);
      expect(r.sampled).toBe(2);
      expect(r.discrepancies).toEqual([{ workItemId: 'b', team: 'Think Tank', artifactPath: path.join(dir, 'gone.md') }]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('uses the injected file check', async () => {
    const load = createSpotCheckLoader({
      listWorkItems: async () => [item('a', '/nowhere/a.md')],
      loadTeamIndex: async () => new Map(),
      exists: async () => true,
    });
    expect((await load(NOW)).discrepancies).toEqual([]);
  });
});
