/**
 * Tests for the bundle deployment store: round trip, unsafe ids refused,
 * unreadable files treated as missing, listing.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import type { BundleDeployment } from '../../types/solution-bundle.types.js';
import { BundleDeploymentStore } from './bundle-state.store.js';

/** A minimal deployment. */
function deployment(templateId: string): BundleDeployment {
  return {
    templateId,
    templateVersion: '1.0.0',
    jobId: `job-${templateId}`,
    status: 'done',
    runtime: 'claude-code',
    answers: { business_name: 'x' },
    startedAt: '2026-09-25T00:00:00.000Z',
    updatedAt: '2026-09-25T00:00:00.000Z',
    teams: [],
    steps: [],
    connectors: [],
    firstWeek: [],
    schedules: {},
    channels: {},
  };
}

describe('BundleDeploymentStore', () => {
  let home: string;
  let store: BundleDeploymentStore;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'bundle-store-'));
    store = new BundleDeploymentStore(home);
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('writes under <home>/bundles and reads back', async () => {
    await store.write(deployment('smb-marketing-team'));
    expect(store.fileFor('smb-marketing-team')).toBe(path.join(home, 'bundles', 'smb-marketing-team.json'));
    expect(await store.read('smb-marketing-team')).toEqual(deployment('smb-marketing-team'));
  });

  it('returns null for a template never deployed or an unreadable file', async () => {
    expect(await store.read('nothing')).toBeNull();
    mkdirSync(path.join(home, 'bundles'), { recursive: true });
    writeFileSync(path.join(home, 'bundles', 'broken.json'), '{');
    expect(await store.read('broken')).toBeNull();
    writeFileSync(path.join(home, 'bundles', 'other.json'), JSON.stringify(deployment('not-other')));
    expect(await store.read('other')).toBeNull();
  });

  it('refuses ids that are not safe file names', () => {
    expect(() => store.fileFor('../escape')).toThrow(/Invalid template id/);
    expect(() => store.fileFor('A_B')).toThrow(/Invalid template id/);
  });

  it('lists every readable deployment, sorted', async () => {
    expect(await store.list()).toEqual([]);
    await store.write(deployment('b-one'));
    await store.write(deployment('a-one'));
    writeFileSync(path.join(home, 'bundles', 'junk.txt'), 'x');
    expect((await store.list()).map((d) => d.templateId)).toEqual(['a-one', 'b-one']);
  });
});
