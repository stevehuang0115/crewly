/**
 * Tests for the Slack directory: Cloud roster + live channel membership.
 *
 * @module services/slack/slack-directory.service.test
 */

import { SlackDirectoryService, type CloudDirectoryInstance } from './slack-directory.service.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
    }),
  },
}));

const CLOUD: CloudDirectoryInstance[] = [
  {
    instanceId: 'mac',
    deviceName: 'MacBook',
    live: true,
    teams: [
      { teamId: 't1', name: 'Think Tank', channelId: 'C-tt', agents: [{ agentSession: 'tt-atlas', displayName: 'Atlas', botUserId: 'UATLAS', installed: true }] },
    ],
  },
  {
    instanceId: 'mini',
    deviceName: 'mac-mini',
    live: true,
    teams: [
      { teamId: 't2', name: 'Portal', channelId: 'C-tt', agents: [{ agentSession: 'portal-mia', displayName: 'Mia', botUserId: 'UMIA', installed: true }, { agentSession: 'portal-bo', displayName: 'Bo', botUserId: null, installed: false }] },
    ],
  },
];

function build(over: Partial<ConstructorParameters<typeof SlackDirectoryService>[0]> = {}) {
  let now = 1_800_000_000_000;
  const svc = new SlackDirectoryService({
    getInstanceId: () => 'mac',
    fetchCloudDirectory: async () => CLOUD,
    listChannelMembers: async (id) => (id === 'C-tt' ? ['UATLAS', 'UMIA', 'UOTHER', 'UHUMAN'] : []),
    getUser: async (id) => (id === 'UOTHER' ? { name: 'Nova', isBot: true } : id === 'UHUMAN' ? { name: 'Steve', isBot: false } : null),
    localMemberName: (session) => (session === 'tt-atlas' ? 'Atlas TL' : null),
    now: () => now,
    ...over,
  });
  return { svc, tick: (ms: number) => (now += ms) };
}

describe('SlackDirectoryService', () => {
  it('merges Cloud agents (local first, with machine + team) and channel-only bots/humans, marking channel membership', async () => {
    const { svc } = build();
    const entries = await svc.list('C-tt');
    expect(entries.map((e) => [e.name, e.source, e.kind, e.inChannel, e.machine, e.mention])).toEqual([
      ['Atlas TL', 'this-machine', 'agent', true, 'this machine', '<@UATLAS>'],
      ['Bo', 'this-account', 'agent', true, 'mac-mini', null],
      ['Mia', 'this-account', 'agent', true, 'mac-mini', '<@UMIA>'],
      ['Nova', 'channel', 'bot', true, null, '<@UOTHER>'],
      ['Steve', 'channel', 'human', true, null, '<@UHUMAN>'],
    ]);
  });

  it('without a channel returns the account roster only; caches per key and refreshes after the TTL', async () => {
    const fetchCloudDirectory = jest.fn(async () => CLOUD);
    const { svc, tick } = build({ fetchCloudDirectory });
    expect((await svc.list()).map((e) => e.name)).toEqual(['Atlas TL', 'Bo', 'Mia']);
    await svc.list();
    expect(fetchCloudDirectory).toHaveBeenCalledTimes(1);
    tick(6 * 60 * 1000);
    await svc.list();
    expect(fetchCloudDirectory).toHaveBeenCalledTimes(2);
  });

  it('rosterLine names channel members with team, machine and how to @ them; empty when nothing is known', async () => {
    const { svc } = build();
    expect(await svc.rosterLine('C-tt')).toBe(
      'Atlas TL (Think Tank, this machine) → @Atlas TL · Bo (Portal, mac-mini) · Mia (Portal, mac-mini) → @Mia · Nova (bot, other system) → @Nova · Steve (human) → @Steve',
    );
    const offline = build({ fetchCloudDirectory: async () => null, listChannelMembers: async () => null });
    expect(await offline.svc.rosterLine('C-tt')).toBe('');
  });
});
