/**
 * The status snapshot shape round-trips as JSON (it is what Cloud
 * validates: crewly-services auth/src/drive/drive-briefing.contract.ts).
 */

import type { BriefingSnapshot } from './drive-briefing.contract.js';

describe('BriefingSnapshot', () => {
  it('a full snapshot survives JSON unchanged', () => {
    const s: BriefingSnapshot = {
      v: 1,
      generatedAt: '2026-10-09T10:00:00.000Z',
      teams: [{ name: 'CE', lead: 'Owen', agents: ['Owen'], open: 1, inProgress: 1, review: 0, blocked: 0, doneToday: 2 }],
      agents: [{ session: 'owen-1', name: 'Owen', team: 'CE', state: 'working', activity: { title: 'Pricing', since: '2026-10-09T09:00:00.000Z', ref: 'CE-14' }, lastToOwner: [{ at: '2026-10-09T09:30:00.000Z', text: 'Done.' }] }],
      items: [{ ref: 'CE-14', kind: 'ticket', title: 'Pricing', status: 'in_progress', assignee: 'Owen', team: 'CE', project: 'ce', updatedAt: '2026-10-09T09:00:00.000Z', last: 'Draft up.' }],
      waiting: [{ ref: 'D-7', kind: 'decision', from: 'Ella', summary: 'Which cut?', since: '2026-10-09T09:00:00.000Z', urgency: 'high' }],
    };
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});
