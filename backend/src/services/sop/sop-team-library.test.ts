/**
 * Tests for SOPService team-library merge: generateSOPContext({ teamId }) must
 * surface SOPs written to ~/.crewly/teams/<id>/sops/ (the team library the wiki
 * editor / update-sop skill write to), closing the read/write mismatch where
 * get-sops only read the global store.
 *
 * Uses a real temp CREWLY_HOME (no fs mock) so the directory walk is exercised.
 *
 * @module services/sop/sop-team-library.test
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SOPService } from './sop.service.js';

describe('SOPService — team SOP library merge', () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'sop-team-lib-'));
    process.env.CREWLY_HOME = home;
    // Global store dirs must exist so the index can be (re)built/written.
    await fs.mkdir(path.join(home, 'sops', 'system'), { recursive: true });
    await fs.mkdir(path.join(home, 'sops', 'custom'), { recursive: true });
    // A team SOP written by update-sop / the wiki editor.
    await fs.mkdir(path.join(home, 'teams', 't1', 'sops', 'marketing'), { recursive: true });
    await fs.writeFile(
      path.join(home, 'teams', 't1', 'sops', 'marketing', 'xhs-posting.md'),
      '---\ntitle: XHS Posting Checklist\ncategory: marketing\n---\n\n1. Draft hook.\n2. Post 7-9pm.\n',
      'utf-8',
    );
  });

  /** Fresh service bound to this test's temp home (avoids singleton basePath staleness). */
  const freshService = (): SOPService => SOPService.createWithPath(path.join(home, 'sops'));

  afterEach(async () => {
    delete process.env.CREWLY_HOME;
    await fs.rm(home, { recursive: true, force: true });
  });

  it('includes the team library SOP when teamId is provided', async () => {
    const svc = freshService();
    const ctx = await svc.generateSOPContext({
      role: 'generalist',
      taskContext: 'posting on xhs',
      teamId: 't1',
    });
    expect(ctx).toContain('## Team SOPs');
    expect(ctx).toContain('XHS Posting Checklist');
    expect(ctx).toContain('Draft hook');
    // frontmatter category is parsed, not dumped as body
    expect(ctx).toContain('Category: marketing');
    expect(ctx).not.toContain('title: XHS Posting Checklist');
  });

  it('omits the Team SOPs section when teamId is not provided', async () => {
    const svc = freshService();
    const ctx = await svc.generateSOPContext({ role: 'generalist', taskContext: 'posting on xhs' });
    expect(ctx).not.toContain('## Team SOPs');
  });

  it('tolerates a team with no SOP library (returns no Team SOPs section)', async () => {
    const svc = freshService();
    const ctx = await svc.generateSOPContext({
      role: 'generalist',
      taskContext: 'anything',
      teamId: 'team-with-no-sops',
    });
    expect(ctx).not.toContain('## Team SOPs');
  });
});
