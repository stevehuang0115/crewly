/**
 * Tests for the team-lead-required service.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TEAM_LEAD_REQUIRED_CONSTANTS } from '../../constants.js';
import type { OwnerDecision } from '../../types/decision.types.js';
import type { Team, TeamMember } from '../../types/index.js';
import { resetNoLeadWarnings, setTeamLead } from '../../utils/team.utils.js';
import { parseOptions, resolveDefault } from '../decisions/decision-contract.js';
import type { SystemAskInput } from '../decisions/decision.service.js';
import {
  TeamLeadRequiredService,
  leadCandidates,
  newLeadNote,
  teamLeadCard,
  teamNeedsLead,
} from './team-lead-required.service.js';
import { TeamLeadRequiredStore } from './team-lead-required.store.js';

const DAY = 24 * 60 * 60 * 1000;

/** A member. */
function member(id: string, name: string, role: string, extra: Partial<TeamMember> = {}): TeamMember {
  return { id, name, role, sessionName: `s-${id}`, ...extra } as unknown as TeamMember;
}

/** A team. */
function makeTeam(id: string, name: string, members: TeamMember[], extra: Partial<Team> = {}): Team {
  return { id, name, members, ...extra } as unknown as Team;
}

/** The Flopost team of the incident: a product manager and a developer, no lead. */
function flopost(): Team {
  return makeTeam('flopost', 'Flopost', [member('dex', 'Dex', 'developer'), member('pia', 'Pia', 'product-manager')]);
}

describe('teamNeedsLead', () => {
  beforeEach(() => resetNoLeadWarnings());

  it('is true for two members with no lead', () => {
    expect(teamNeedsLead(flopost())).toBe(true);
  });

  it('is false with a lead role, an explicit lead, one member, an archived team or the orchestrator team', () => {
    expect(teamNeedsLead(makeTeam('t', 'T', [member('a', 'A', 'team-leader'), member('b', 'B', 'developer')]))).toBe(false);
    expect(teamNeedsLead({ ...flopost(), leaderIds: ['pia'] } as Team)).toBe(false);
    expect(teamNeedsLead(makeTeam('t', 'T', [member('a', 'A', 'developer')]))).toBe(false);
    expect(teamNeedsLead(makeTeam('t', 'T', [member('a', 'A', 'developer'), member('o', 'Orc', 'orchestrator')]))).toBe(false);
    expect(teamNeedsLead({ ...flopost(), archived: true } as Team)).toBe(false);
    expect(teamNeedsLead({ ...flopost(), id: 'orchestrator' } as Team)).toBe(false);
  });
});

describe('leadCandidates', () => {
  beforeEach(() => resetNoLeadWarnings());

  it('offers a product manager / tpm first, then the routing fallback, then the others; at most three', () => {
    const team = makeTeam('t', 'T', [
      member('a', 'Ann', 'developer'),
      member('b', 'Bo', 'designer'),
      member('c', 'Cy', 'tpm'),
      member('d', 'Di', 'product-manager'),
      member('e', 'Ed', 'qa'),
    ]);
    expect(leadCandidates(team).map((m) => m.name)).toEqual(['Cy', 'Di', 'Ann']);
  });

  it('prefers the member flagged canDelegate as the fallback, never the orchestrator, and drops a repeated name', () => {
    const team = makeTeam('t', 'T', [
      member('o', 'Orc', 'orchestrator'),
      member('a', 'Ann', 'developer'),
      member('a2', 'ann', 'designer'),
      member('b', 'Bo', 'developer', { canDelegate: true }),
    ]);
    expect(leadCandidates(team).map((m) => m.id)).toEqual(['b', 'a']);
  });
});

describe('teamLeadCard / newLeadNote', () => {
  it('asks in plain words within the card limits', () => {
    const card = teamLeadCard(flopost());
    expect(card.title).toBe('Team Flopost has no lead');
    expect(card.question).toBe('Who should lead team Flopost? Without a lead, nobody on the team can assign work, start members or review results.');
    expect(card.question.length).toBeLessThanOrEqual(280);
    expect(card.body[0]).toBe('*Members:* Dex (developer), Pia (product-manager)');
    for (const text of [card.title, card.question, ...card.body]) expect(text).not.toMatch(/[㐀-鿿]/);
  });

  it('tells the new lead what it has and who to hand work to', () => {
    const team = flopost();
    const note = newLeadNote(team, team.members[1], '/pkg/tl');
    expect(note).toMatch(/^\[TEAM LEAD\] The owner made you the lead of team Flopost\./);
    expect(note).toContain('delegate-task');
    expect(note).toContain('start-agent');
    expect(note).toContain('/pkg/tl/delegate-task/execute.sh');
    expect(note).toContain('Hand hands-on work to your members: Dex (developer).');
    expect(newLeadNote(team, team.members[1])).not.toContain('execute.sh');
  });
});

describe('TeamLeadRequiredService', () => {
  let dir: string;
  let store: TeamLeadRequiredStore;
  let teams: Team[];
  let now: number;
  let cards: Map<string, OwnerDecision>;
  let asks: SystemAskInput[];
  let delivered: Array<{ session: string; text: string }>;
  let setLead: jest.Mock;
  let cancelled: string[];
  let service: TeamLeadRequiredService;
  let decisionsUp: boolean;

  /** Settle a card the way the decision service would, and tell the handler. */
  async function settle(id: string, patch: Partial<OwnerDecision>): Promise<void> {
    const d = { ...(cards.get(id) as OwnerDecision), ...patch };
    cards.set(id, d);
    await service.onSettled(d);
  }

  beforeEach(() => {
    resetNoLeadWarnings();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-lead-svc-'));
    store = TeamLeadRequiredStore.inHome(dir);
    teams = [flopost()];
    now = Date.parse('2026-11-26T12:00:00.000Z');
    cards = new Map();
    asks = [];
    delivered = [];
    cancelled = [];
    decisionsUp = true;
    setLead = jest.fn(async (team: Team, memberId: string) => {
      setTeamLead(team, memberId, 'set');
    });
    const decisions = {
      askSystem: async (input: SystemAskInput): Promise<OwnerDecision> => {
        asks.push(input);
        const id = `D-${asks.length}`;
        const d = {
          id,
          kind: input.kind,
          system: input.system,
          status: 'open',
          options: (input.options as Array<{ label: string; detail?: string }>).map((o, i) => ({ key: 'abcde'[i], ...o })),
        } as unknown as OwnerDecision;
        cards.set(id, d);
        return d;
      },
      get: async (id: string) => cards.get(id) ?? null,
      cancelWhere: async (filter: (d: OwnerDecision) => boolean) => {
        let n = 0;
        for (const d of [...cards.values()]) {
          if (d.status !== 'open' || !filter(d)) continue;
          n += 1;
          cancelled.push(d.id);
          await settle(d.id, { status: 'cancelled' });
        }
        return n;
      },
    };
    service = new TeamLeadRequiredService({
      store,
      getTeams: async () => teams,
      decisions: () => (decisionsUp ? decisions : null),
      setLead,
      deliverToAgent: async (session, text) => {
        delivered.push({ session, text });
        return true;
      },
      tlSkillsPath: '/pkg/tl',
      now: () => new Date(now),
    });
  });

  afterEach(() => {
    service.stop();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('posts one card for a team without a lead: candidates by name and role, Not now as the declining default, 7 days', async () => {
    await service.tick();
    expect(asks).toHaveLength(1);
    const ask = asks[0];
    expect(ask.kind).toBe('team_lead');
    expect(ask.system).toEqual({ key: 'flopost', defaultIsDecline: true });
    expect(ask.title).toBe('Team Flopost has no lead');
    expect(ask.options).toEqual([
      { label: 'Pia', detail: 'product-manager' },
      { label: 'Dex', detail: 'developer' },
      { label: 'Not now', detail: TEAM_LEAD_REQUIRED_CONSTANTS.NOT_NOW_DETAIL },
    ]);
    expect(ask.default).toBe('Not now');
    expect(ask.deadline.getTime()).toBe(now + 7 * DAY);
    expect(ask.sensitive).toBeUndefined();
    // The real card contract accepts it.
    const parsed = parseOptions(ask.options);
    expect(parsed.map((o) => o.key)).toEqual(['a', 'b', 'c']);
    expect(resolveDefault(ask.default, parsed)).toBe('c');
    expect(store.get('flopost')).toMatchObject({ status: 'asked', decisionId: 'D-1', candidates: [{ memberId: 'pia', label: 'Pia' }, { memberId: 'dex', label: 'Dex' }] });
  });

  it('never posts a second card while one is open, also across concurrent checks', async () => {
    await Promise.all([service.tick(), service.tick()]);
    await service.tick();
    expect(asks).toHaveLength(1);
  });

  it('asks nothing for teams that have a lead, are too small, or while cards are not running', async () => {
    teams = [makeTeam('a', 'A', [member('l', 'Lee', 'tech-lead'), member('m', 'Mo', 'developer')]), makeTeam('b', 'B', [member('x', 'Xi', 'developer')])];
    await service.tick();
    expect(asks).toHaveLength(0);
    teams = [flopost()];
    decisionsUp = false;
    await service.tick();
    expect(asks).toHaveLength(0);
    expect(store.get('flopost')).toBeNull();
  });

  it("applies the owner's pick through setLead and tells the new lead once", async () => {
    await service.tick();
    await settle('D-1', { status: 'resolved', chosenKey: 'a' });
    expect(setLead).toHaveBeenCalledTimes(1);
    expect(setLead.mock.calls[0][1]).toBe('pia');
    expect(teams[0].leaderIds).toEqual(['pia']);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].session).toBe('s-pia');
    expect(delivered[0].text).toContain('lead of team Flopost');
    expect(store.get('flopost')).toBeNull();
    // Settling again (a replay) and the next check change nothing.
    await service.onSettled(cards.get('D-1') as OwnerDecision);
    await service.tick();
    expect(setLead).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveLength(1);
    expect(asks).toHaveLength(1);
  });

  it.each([
    ['Not now', { status: 'resolved', chosenKey: 'c' }],
    ['the deadline', { status: 'defaulted', chosenKey: 'c' }],
    ['a skip', { status: 'skipped' }],
  ] as Array<[string, Partial<OwnerDecision>]>)('remembers %s and does not ask again for 30 days', async (_name, patch) => {
    await service.tick();
    await settle('D-1', patch);
    expect(setLead).not.toHaveBeenCalled();
    expect(delivered).toHaveLength(0);
    expect(store.get('flopost')).toMatchObject({ status: 'snoozed', snoozedUntil: new Date(now + 30 * DAY).toISOString() });
    now += 29 * DAY;
    await service.tick();
    expect(asks).toHaveLength(1);
    now += 2 * DAY;
    await service.tick();
    expect(asks).toHaveLength(2);
    expect(store.get('flopost')).toMatchObject({ status: 'asked', decisionId: 'D-2' });
  });

  it('withdraws the open card and forgets the team when it gains a lead elsewhere', async () => {
    await service.tick();
    setTeamLead(teams[0], 'dex', 'set');
    await service.tick();
    expect(cancelled).toEqual(['D-1']);
    expect(store.get('flopost')).toBeNull();
    expect(setLead).not.toHaveBeenCalled();
    expect(asks).toHaveLength(1);
  });

  it('makes a late answer a no-op when the team already has a lead', async () => {
    await service.tick();
    setTeamLead(teams[0], 'dex', 'set');
    await settle('D-1', { status: 'resolved', chosenKey: 'a' });
    expect(setLead).not.toHaveBeenCalled();
    expect(delivered).toHaveLength(0);
    expect(teams[0].leaderIds).toEqual(['dex']);
    expect(store.get('flopost')).toBeNull();
  });

  it('ignores a card that is not the team\'s current one, and other kinds', async () => {
    await service.tick();
    await service.onSettled({ ...(cards.get('D-1') as OwnerDecision), id: 'D-old', status: 'resolved', chosenKey: 'a' });
    await service.onSettled({ ...(cards.get('D-1') as OwnerDecision), kind: 'spend_cap', status: 'resolved', chosenKey: 'a' });
    expect(setLead).not.toHaveBeenCalled();
    expect(store.get('flopost')).toMatchObject({ status: 'asked', decisionId: 'D-1' });
  });

  it('acts on an answer that settled while the handler was not listening', async () => {
    await service.tick();
    cards.set('D-1', { ...(cards.get('D-1') as OwnerDecision), status: 'resolved', chosenKey: 'b' });
    await service.tick();
    expect(setLead.mock.calls[0][1]).toBe('dex');
    expect(asks).toHaveLength(1);
    expect(store.get('flopost')).toBeNull();
  });

  it('asks again when the card vanished, and when the picked member left the team', async () => {
    await service.tick();
    cards.delete('D-1');
    await service.tick();
    expect(asks).toHaveLength(2);
    teams[0].members = [member('dex', 'Dex', 'developer'), member('zed', 'Zed', 'designer')];
    await settle('D-2', { status: 'resolved', chosenKey: 'a' });
    expect(setLead).not.toHaveBeenCalled();
    expect(store.get('flopost')).toBeNull();
    await service.tick();
    expect(asks).toHaveLength(3);
  });

  it('withdraws the card of a deleted team and keeps going when one ask fails', async () => {
    await service.tick();
    teams = [makeTeam('other', 'Other', [member('a', 'Ann', 'developer'), member('b', 'Bo', 'developer')])];
    await service.tick();
    expect(cancelled).toEqual(['D-1']);
    expect(store.get('flopost')).toBeNull();
    expect(store.get('other')).toMatchObject({ status: 'asked' });
  });

  it('a failed delivery to the new lead does not undo the change or throw', async () => {
    const warn = jest.fn();
    service = new TeamLeadRequiredService({
      store,
      getTeams: async () => teams,
      decisions: () => ({ askSystem: jest.fn(), get: async () => null, cancelWhere: async () => 0 }),
      setLead,
      deliverToAgent: async () => {
        throw new Error('down');
      },
      now: () => new Date(now),
      logger: { info: jest.fn(), warn },
    });
    store.set({ teamId: 'flopost', status: 'asked', updatedAt: 'x', decisionId: 'D-9', candidates: [{ memberId: 'pia', label: 'Pia' }] });
    await expect(
      service.onSettled({ id: 'D-9', kind: 'team_lead', system: { key: 'flopost' }, status: 'resolved', chosenKey: 'a', options: [{ key: 'a', label: 'Pia' }] } as unknown as OwnerDecision),
    ).resolves.toBeNull();
    expect(setLead).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Could not tell the new lead', expect.anything());
  });
});
