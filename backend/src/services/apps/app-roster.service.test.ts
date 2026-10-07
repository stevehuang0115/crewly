/**
 * Tests for AppRosterService — who the owner can @mention in an app comment:
 * archived and paused teams left out, the orchestrator as "Orc", pushed only
 * when the list changed (or once a day), failures retried.
 */

import { AppRosterService, buildRoster, isRosterAgent, type RosterTeam, buildRosterTeams, cleanRosterChannels } from './app-roster.service.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }) }) },
}));

const TEAMS: RosterTeam[] = [
  {
    name: 'Research',
    members: [
      { sessionName: 'crewly-research-atlas-0a1b2c3d', name: 'Atlas' },
      { sessionName: '', agentId: 'crewly-research-kai-11223344', name: '  Kai  ' },
      { sessionName: 'crewly-research-atlas-0a1b2c3d', name: 'Atlas again' },
      { sessionName: 'bad session', name: 'Nope' },
    ],
  },
  { name: 'Old', archived: true, members: [{ sessionName: 'crewly-old-zed-00000000', name: 'Zed' }] },
  { name: 'Paused', paused: { pausedAt: '2026-10-01T00:00:00Z' }, members: [{ sessionName: 'crewly-paused-pia-00000001', name: 'Pia' }] },
  { name: '', members: [{ sessionName: 'crewly-orc', name: 'Orchestrator' }, { sessionName: 'crewly-x-noname-00000002' }] },
];

describe('buildRoster', () => {
  it('lists members of active, unpaused teams once, then the orchestrator as Orc', () => {
    expect(buildRoster(TEAMS)).toEqual([
      { session: 'crewly-research-atlas-0a1b2c3d', name: 'Atlas', team: 'Research' },
      { session: 'crewly-research-kai-11223344', name: 'Kai', team: 'Research' },
      { session: 'crewly-x-noname-00000002', name: 'crewly-x-noname-00000002', team: null },
      { session: 'crewly-orc', name: 'Orc', team: null },
    ]);
    expect(buildRoster([])).toEqual([{ session: 'crewly-orc', name: 'Orc', team: null }]);
  });

  it('isRosterAgent: only mentionable agents of this machine', () => {
    expect(isRosterAgent(TEAMS, 'crewly-research-kai-11223344')).toBe(true);
    expect(isRosterAgent(TEAMS, 'crewly-orc')).toBe(true);
    expect(isRosterAgent(TEAMS, 'crewly-paused-pia-00000001')).toBe(false);
    expect(isRosterAgent(TEAMS, 'crewly-old-zed-00000000')).toBe(false);
  });
});

describe('AppRosterService.pushIfChanged', () => {
  let teams: RosterTeam[];
  let now: number;
  let request: jest.Mock;
  let available: boolean;
  let svc: AppRosterService;

  beforeEach(() => {
    teams = [{ name: 'Research', members: [{ sessionName: 'crewly-research-atlas-0a1b2c3d', name: 'Atlas' }] }];
    now = 1_000_000;
    available = true;
    request = jest.fn().mockResolvedValue({ agents: 2, changed: true });
    svc = new AppRosterService({ client: { isAvailable: () => available, request }, getTeams: async () => teams, now: () => now });
  });

  it('pushes once, then only when the list changes or a day has passed', async () => {
    expect(await svc.pushIfChanged()).toBe(true);
    expect(request).toHaveBeenCalledWith('PUT', '/roster', {
      body: { agents: [{ session: 'crewly-research-atlas-0a1b2c3d', name: 'Atlas', team: 'Research' }, { session: 'crewly-orc', name: 'Orc', team: null }], teams: [], channels: [] },
      timeoutMs: 20_000,
    });
    expect(await svc.pushIfChanged()).toBe(false);
    teams[0]!.members!.push({ sessionName: 'crewly-research-kai-11223344', name: 'Kai' });
    expect(await svc.pushIfChanged()).toBe(true);
    now += 23 * 3600_000;
    expect(await svc.pushIfChanged()).toBe(false);
    now += 2 * 3600_000;
    expect(await svc.pushIfChanged()).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('retries after a failure; does nothing while signed out; one push at a time', async () => {
    request.mockRejectedValueOnce(new Error('502'));
    expect(await svc.pushIfChanged()).toBe(false);
    expect(await svc.pushIfChanged()).toBe(true);
    available = false;
    teams[0]!.members!.push({ sessionName: 'crewly-research-kai-11223344', name: 'Kai' });
    expect(await svc.pushIfChanged()).toBe(false);
    available = true;
    const [a, b] = await Promise.all([svc.pushIfChanged(), svc.pushIfChanged()]);
    expect([a, b]).toEqual([true, true]);
    expect(request).toHaveBeenCalledTimes(3);
  });
});

describe('teams and channels (app owners, crewly-services apps/SPEC.md §15)', () => {
  it('buildRoster carries team ids; buildRosterTeams lists non-archived teams with ids (paused included)', () => {
    const teams: RosterTeam[] = [
      { id: 't-res', name: 'Research', members: [{ sessionName: 'crewly-research-atlas-0a1b2c3d', name: 'Atlas' }] },
      { id: 't-old', name: 'Old', archived: true, members: [] },
      { id: 't-p', name: 'Paused', paused: { pausedAt: 'x' }, members: [] },
      { name: 'No id', members: [] },
      { id: 'bad id!', name: 'Bad', members: [] },
    ];
    expect(buildRoster(teams)[0]).toEqual({ session: 'crewly-research-atlas-0a1b2c3d', name: 'Atlas', team: 'Research', teamId: 't-res' });
    expect(buildRosterTeams(teams)).toEqual([{ id: 't-res', name: 'Research' }, { id: 't-p', name: 'Paused' }]);
  });

  it('cleanRosterChannels drops bad ids and sessions, strips #, de-duplicates members', () => {
    expect(
      cleanRosterChannels([
        { id: 'huddle-1', name: '#daily-brief', members: ['crewly-a-ella-00000001', 'crewly-a-ella-00000001', 'bad session!'], slack: true },
        { id: 'bad id!', name: 'x', members: [] },
      ]),
    ).toEqual([{ id: 'huddle-1', name: 'daily-brief', members: ['crewly-a-ella-00000001'], slack: true }]);
  });

  it('pushes teams and channels, and pushes again when a channel changes; a channel read failure still pushes agents', async () => {
    const request = jest.fn().mockResolvedValue({});
    let channels = [{ id: 'h1', name: 'brief', members: ['crewly-research-atlas-0a1b2c3d'] }];
    let fail = false;
    const svc = new AppRosterService({
      client: { isAvailable: () => true, request },
      getTeams: async () => [{ id: 't-res', name: 'Research', members: [{ sessionName: 'crewly-research-atlas-0a1b2c3d', name: 'Atlas' }] }],
      getChannels: async () => {
        if (fail) throw new Error('boom');
        return channels;
      },
    });
    expect(await svc.pushIfChanged()).toBe(true);
    expect(request.mock.calls[0][2].body).toMatchObject({ teams: [{ id: 't-res', name: 'Research' }], channels: [{ id: 'h1', name: 'brief', members: ['crewly-research-atlas-0a1b2c3d'] }] });
    expect(await svc.pushIfChanged()).toBe(false);
    channels = [{ id: 'h1', name: 'brief', members: [] }];
    expect(await svc.pushIfChanged()).toBe(true);
    fail = true;
    expect(await svc.pushIfChanged()).toBe(true);
    expect(request.mock.calls[2][2].body.channels).toEqual([]);
  });
});
