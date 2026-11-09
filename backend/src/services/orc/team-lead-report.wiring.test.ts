import type { Team } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { leadReportForStatus, resolveLeadReport, type LeadReportSources } from './team-lead-report.wiring.js';

const ORC_DM = { kind: 'owner', receivedBy: 'orchestrator', slackChannelId: 'D0ORC', threadTs: '1792000000.000100' };
const MKT = {
  id: 'mkt',
  name: 'Marketing',
  members: [
    { id: 'ella', name: 'Ella', sessionName: 'ella', role: 'team-leader' },
    { id: 'luna', name: 'Luna', sessionName: 'luna', role: 'developer' },
  ],
} as unknown as Team;

const item = (over: Partial<WorkItem> = {}): WorkItem =>
  ({ id: 'wi-1', type: 'delegate', owner: 'agent', target: 'luna', title: 'T', status: 'queued', createdAt: new Date().toISOString(), metadata: { origin: ORC_DM }, ...over }) as WorkItem;

function sources(channels: Awaited<ReturnType<LeadReportSources['channels']>>): LeadReportSources & { teams: jest.Mock } {
  return { channels: async () => channels, teams: jest.fn(async () => [MKT]) };
}

describe('resolveLeadReport', () => {
  it('stamps orc-delegated owner work with the lead and the team channel', async () => {
    const s = sources([{ teamId: 'mkt', slackChannelId: 'C0MKT', slackChannelName: 'marketing' }]);
    await expect(resolveLeadReport({ workItem: item(), creator: 'crewly-orc', items: [] }, s)).resolves.toMatchObject({ lead: 'ella', worker: 'luna', channelName: 'marketing' });
  });

  it('no team channels → null without reading the team store', async () => {
    for (const channels of [null, []]) {
      const s = sources(channels);
      await expect(resolveLeadReport({ workItem: item(), creator: 'crewly-orc', items: [] }, s)).resolves.toBeNull();
      expect(s.teams).not.toHaveBeenCalled();
    }
  });

  it('never throws', async () => {
    const s: LeadReportSources = { channels: async () => Promise.reject(new Error('slack')), teams: async () => [] };
    await expect(resolveLeadReport({ workItem: item(), creator: 'crewly-orc', items: [] }, s)).resolves.toBeNull();
  });
});

describe('leadReportForStatus', () => {
  const stamp = { lead: 'ella', worker: 'luna', teamId: 'mkt', teamName: 'Marketing', slackChannelId: 'C0MKT', channelName: 'marketing' };

  it('the stamp of the work item a status report names', async () => {
    const pool = async () => [item({ id: 'wi-7', status: 'running', startedAt: new Date().toISOString(), metadata: { origin: ORC_DM, leadReport: stamp } })];
    await expect(leadReportForStatus({ sender: 'luna', workItemId: 'wi-7' }, pool)).resolves.toEqual(stamp);
  });

  it('unstamped work or a failing pool → null', async () => {
    await expect(leadReportForStatus({ sender: 'luna', workItemId: 'wi-1' }, async () => [item()])).resolves.toBeNull();
    await expect(leadReportForStatus({ sender: 'luna' }, async () => Promise.reject(new Error('x')))).resolves.toBeNull();
  });
});
