/**
 * Tests for TempMemberService — a lead adds / removes temporary members
 * within the team's headcount, they are removed automatically, and a
 * permanent seat goes to the owner as one card
 * (specs/2026-11-26-temp-members-seat-requests.md).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { TEMP_MEMBER_CONSTANTS } from '../../constants.js';
import type { Team, TeamMember } from '../../types/index.js';
import type { OwnerDecision } from '../../types/decision.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { PrebuiltAsk } from '../decisions/decision.service.js';
import { TempMemberStore } from './temp-member.store.js';
import { TempMemberError, TempMemberService, parseTempHeadcount, tempCountsByTeam, tempHeadcountOf, temporaryMembersOf, type NewMemberInput } from './temp-member.service.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const E = TEMP_MEMBER_CONSTANTS.ERRORS;

function makeTeam(over: Partial<Team> = {}): Team {
  return {
    id: 't1',
    name: 'Marketing',
    leaderIds: ['m-owen'],
    members: [
      { id: 'm-owen', name: 'Owen', sessionName: 'mkt-owen', agentId: 'mkt-owen', role: 'team-leader', runtimeType: 'claude-code' },
      { id: 'm-ella', name: 'Ella', sessionName: '', agentId: 'mkt-ella', role: 'developer', runtimeType: 'claude-code' },
    ],
    projectIds: [],
    createdAt: '',
    updatedAt: '',
    ...over,
  } as unknown as Team;
}

const item = (over: Partial<WorkItem>): WorkItem => ({ id: 'wi-1', status: 'queued', createdAt: '2026-11-26T12:00:00.000Z', ...over }) as unknown as WorkItem;

describe('temp member helpers', () => {
  it('tempHeadcountOf: default 2 when unset or invalid, 0 disables, capped', () => {
    expect(tempHeadcountOf({})).toBe(2);
    expect(tempHeadcountOf({ tempHeadcount: 0 })).toBe(0);
    expect(tempHeadcountOf({ tempHeadcount: 5 })).toBe(5);
    expect(tempHeadcountOf({ tempHeadcount: -1 })).toBe(2);
    expect(tempHeadcountOf({ tempHeadcount: 1.5 })).toBe(2);
    expect(tempHeadcountOf({ tempHeadcount: 99 })).toBe(TEMP_MEMBER_CONSTANTS.MAX_HEADCOUNT);
  });

  it('parseTempHeadcount: whole numbers 0..max, null restores the default', () => {
    expect(parseTempHeadcount(3)).toEqual({ ok: true, value: 3 });
    expect(parseTempHeadcount(0)).toEqual({ ok: true, value: 0 });
    expect(parseTempHeadcount(null)).toEqual({ ok: true, value: undefined });
    for (const bad of [-1, 2.5, '3', 11, true, {}]) expect(parseTempHeadcount(bad).ok).toBe(false);
  });

  it('tempCountsByTeam counts opened and removed since a time, per team', () => {
    const e = (type: 'created' | 'removed' | 'converted', teamId: string, at: string) => ({ type, teamId, at }) as never;
    const counts = tempCountsByTeam(
      [e('created', 't1', '2026-11-25T23:00:00Z'), e('created', 't1', '2026-11-26T01:00:00Z'), e('removed', 't1', '2026-11-26T02:00:00Z'), e('converted', 't1', '2026-11-26T03:00:00Z'), e('created', 't2', '2026-11-26T04:00:00Z')],
      Date.parse('2026-11-26T00:00:00Z'),
    );
    expect(counts.get('t1')).toEqual({ opened: 1, removed: 1 });
    expect(counts.get('t2')).toEqual({ opened: 1, removed: 0 });
  });
});

describe('TempMemberService', () => {
  let dir: string;
  let teams: Team[];
  let now: Date;
  let items: WorkItem[];
  let asks: PrebuiltAsk[];
  let decisions: Map<string, OwnerDecision>;
  let delivered: Array<{ session: string; text: string }>;
  let busy: Set<string>;
  let pressure: boolean;
  let kept: number;
  let cardsRunning: boolean;
  let activity: Map<string, number>;
  let store: TempMemberStore;
  let service: TempMemberService;
  let seq: number;

  const team = (): Team => teams[0];
  const temps = (): TeamMember[] => temporaryMembersOf(team());
  const add = (input: Record<string, unknown> = {}, caller = 'mkt-owen', teamId = 't1') => service.addTemp(caller, teamId, { role: 'developer', reason: 'two launches this week', ...input });
  const refusal = async (p: Promise<unknown>): Promise<TempMemberError> => {
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(TempMemberError);
      return err as TempMemberError;
    }
    throw new Error('expected a refusal');
  };
  const settle = (id: string, over: Partial<OwnerDecision>): OwnerDecision => {
    const d = { ...decisions.get(id)!, ...over } as OwnerDecision;
    decisions.set(id, d);
    return d;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'temp-svc-'));
    teams = [makeTeam()];
    now = new Date('2026-11-26T12:00:00.000Z');
    items = [];
    asks = [];
    decisions = new Map();
    delivered = [];
    busy = new Set();
    pressure = false;
    kept = 0;
    cardsRunning = true;
    activity = new Map();
    seq = 0;
    store = TempMemberStore.inHome(dir);
    service = new TempMemberService({
      store,
      getTeams: async () => teams,
      addMember: async (teamId: string, input: NewMemberInput) => {
        seq += 1;
        const member = { id: `member-${seq}-abcdefgh`, name: input.name, sessionName: '', role: input.role, runtimeType: 'claude-code', ...(input.temporary ? { temporary: input.temporary } : {}), ...(input.parentMemberId ? { parentMemberId: input.parentMemberId } : {}) } as unknown as TeamMember;
        teams.find((t) => t.id === teamId)!.members.push(member);
        return member;
      },
      removeMember: async (teamId: string, memberId: string) => {
        const t = teams.find((x) => x.id === teamId)!;
        const i = t.members.findIndex((m) => m.id === memberId);
        if (i === -1) return false;
        t.members.splice(i, 1);
        return true;
      },
      saveTeam: async () => undefined,
      knownRoles: async () => ['developer', 'designer', 'qa', 'team-leader', 'orchestrator'],
      underMemoryPressure: () => pressure,
      workItems: async () => items,
      isBusy: async (session: string) => busy.has(session),
      lastActivityAt: (session: string) => activity.get(session) ?? null,
      noMemberFitsCount: () => kept,
      decisions: () =>
        cardsRunning
          ? {
              askPrebuilt: async (ask: PrebuiltAsk) => {
                asks.push(ask);
                const d = { id: `D-${asks.length}`, status: 'open', kind: ask.kind, question: ask.question, options: ask.options, defaultKey: ask.defaultKey, asker: ask.asker } as unknown as OwnerDecision;
                decisions.set(d.id, d);
                return d;
              },
              get: async (id: string) => decisions.get(id) ?? null,
            }
          : null,
      deliverToAgent: async (session: string, text: string) => {
        delivered.push({ session, text });
        return true;
      },
      teamChannelOf: async () => 'C-MKT',
      tlSkillsPath: '/skills/team-leader',
      now: () => now,
    });
  });

  afterEach(async () => {
    service.stop();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  // ------------------------------------------------------------------ add

  describe('addTemp', () => {
    it('adds a temporary member through the add path and tells the lead how to use it', async () => {
      const out = await add({ workItemId: 'wi-7' });
      const [m] = temps();
      expect(m).toMatchObject({ name: 'Temp-Developer-1', role: 'developer' });
      expect(m.modelId).toBeUndefined();
      expect(m.temporary).toEqual({ createdBy: 'mkt-owen', createdAt: now.toISOString(), reason: 'two launches this week', workItemId: 'wi-7', expiresAt: new Date(now.getTime() + 3 * DAY).toISOString() });
      const session = 'marketing-temp-developer-1-member-1';
      expect(out).toMatchObject({ member: { id: m.id, name: 'Temp-Developer-1', role: 'developer', sessionName: session, agentId: session }, headcount: { used: 1, limit: 2 } });
      expect(String(out.delegate)).toBe(`bash /skills/team-leader/delegate-task/execute.sh --to ${session} --task "<the work>"`);
      expect(String(out.note)).toContain('starts when you assign it work');
      expect(String(out.note)).toContain('removed automatically when its work is accepted or after it sits unused');
      expect(out.hint).toBeUndefined();
      expect(await store.events()).toEqual([expect.objectContaining({ type: 'created', teamId: 't1', teamName: 'Marketing', role: 'developer', reason: 'two launches this week', by: 'mkt-owen', workItemId: 'wi-7', memberId: m.id, session })]);
    });

    it('uses the name the lead gave, and refuses one that is taken', async () => {
      await add({ name: 'Kai' });
      expect(temps()[0].name).toBe('Kai');
      const err = await refusal(add({ name: 'ella' }));
      expect(err).toMatchObject({ status: 409, code: E.NAME_TAKEN });
    });

    it('makes the member report to the lead on a team with a hierarchy', async () => {
      team().members[1].parentMemberId = 'm-owen';
      await add();
      expect(temps()[0].parentMemberId).toBe('m-owen');
    });

    it('refuses a caller that does not lead THAT team', async () => {
      teams.push(makeTeam({ id: 't2', name: 'Sales', leaderIds: ['m-zoe'], members: [{ id: 'm-zoe', name: 'Zoe', sessionName: 'sales-zoe', role: 'team-leader' }] as never }));
      for (const [caller, teamId] of [['mkt-ella', 't1'], ['sales-zoe', 't1'], ['mkt-owen', 't2'], [undefined, 't1']] as const) {
        const err = await refusal(service.addTemp(caller, teamId, { role: 'developer', reason: 'x' }));
        expect(err).toMatchObject({ status: 403, code: E.NOT_LEAD });
      }
      expect((await refusal(add({}, 'mkt-owen', 'nope'))).status).toBe(404);
      expect(temps()).toHaveLength(0);
    });

    it('refuses an unknown role, a lead role and a missing reason, naming what to use', async () => {
      const unknown = await refusal(add({ role: 'wizard' }));
      expect(unknown).toMatchObject({ status: 400, code: E.UNKNOWN_ROLE });
      expect(unknown.message).toContain('developer, designer, qa');
      expect(unknown.message).not.toContain('team-leader');
      expect(await refusal(add({ role: 'Team-Leader' }))).toMatchObject({ status: 400, code: E.ROLE_NOT_ALLOWED });
      expect(await refusal(add({ reason: '  ' }))).toMatchObject({ status: 400, code: E.REASON_REQUIRED });
    });

    it('refuses when the headcount is used up and points to request-seat', async () => {
      await add();
      await add({ role: 'designer' });
      const err = await refusal(add());
      expect(err).toMatchObject({ status: 409, code: E.HEADCOUNT_FULL });
      expect(err.message).toContain('used up (2 of 2: Temp-Developer-1 (developer), Temp-Designer-1 (designer))');
      expect(err.message).toContain('/skills/team-leader/request-seat/execute.sh --role developer');
      expect(err.message).toContain('remove-temp-member');
      expect(temps()).toHaveLength(2);
    });

    it('honours the owner\'s headcount: 0 disables, a higher one allows more', async () => {
      team().tempHeadcount = 0;
      const off = await refusal(add());
      expect(off).toMatchObject({ status: 409, code: E.HEADCOUNT_DISABLED });
      expect(off.message).toContain('request-seat');
      team().tempHeadcount = 3;
      await add();
      await add();
      await add();
      expect((await refusal(add())).code).toBe(E.HEADCOUNT_FULL);
    });

    it('two adds at once cannot overrun the headcount', async () => {
      team().tempHeadcount = 1;
      const results = await Promise.allSettled([add(), add()]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(temps()).toHaveLength(1);
    });

    it('refuses under memory pressure', async () => {
      pressure = true;
      const err = await refusal(add());
      expect(err).toMatchObject({ status: 409, code: E.MEMORY_PRESSURE });
      expect(err.message).toContain('short of memory');
      expect(err.message).toContain('request-seat');
      expect(temps()).toHaveLength(0);
    });

    it('tells the lead to request a seat the third time the same role is opened in 14 days', async () => {
      team().tempHeadcount = 5;
      await add();
      now = new Date(now.getTime() + 2 * DAY);
      const second = await add();
      expect(second.hint).toBeUndefined();
      now = new Date(now.getTime() + 2 * DAY);
      const other = await add({ role: 'designer' });
      expect(other.hint).toBeUndefined();
      const third = await add();
      expect(String(third.hint)).toContain('3rd temporary developer on Marketing in 14 days');
      expect(String(third.hint)).toContain('request-seat');
      expect(temps().map((m) => m.name)).toEqual(['Temp-Developer-1', 'Temp-Developer-2', 'Temp-Designer-1', 'Temp-Developer-3']);
    });

    it('does not count openings older than 14 days for the hint', async () => {
      team().tempHeadcount = 5;
      await add();
      await add();
      now = new Date(now.getTime() + 15 * DAY);
      expect((await add()).hint).toBeUndefined();
    });
  });

  // --------------------------------------------------------------- remove

  describe('removeTemp', () => {
    it('removes a temporary member by name and records it', async () => {
      await add();
      const out = await service.removeTemp('mkt-owen', 't1', { member: 'temp-developer-1', reason: 'launch moved' });
      expect(out).toMatchObject({ removed: true, member: { name: 'Temp-Developer-1' }, headcount: { used: 0, limit: 2 } });
      expect(temps()).toHaveLength(0);
      expect((await store.events()).map((e) => [e.type, e.reason, e.by])).toEqual([
        ['created', 'two launches this week', 'mkt-owen'],
        ['removed', 'launch moved', 'mkt-owen'],
      ]);
    });

    it('refuses a permanent member, an unknown one and a non-lead', async () => {
      await add();
      expect(await refusal(service.removeTemp('mkt-owen', 't1', { member: 'Ella' }))).toMatchObject({ status: 409, code: E.NOT_TEMPORARY });
      expect(await refusal(service.removeTemp('mkt-owen', 't1', { member: 'Nobody' }))).toMatchObject({ status: 404, code: E.MEMBER_NOT_FOUND });
      expect(await refusal(service.removeTemp('mkt-ella', 't1', { member: 'Temp-Developer-1' }))).toMatchObject({ status: 403, code: E.NOT_LEAD });
      expect(team().members.map((m) => m.name)).toEqual(['Owen', 'Ella', 'Temp-Developer-1']);
    });

    it('refuses one that holds work or is mid-turn unless forced', async () => {
      const out = await add();
      const session = (out.member as { sessionName: string }).sessionName;
      items = [item({ id: 'wi-9', target: session, status: 'running' })];
      const held = await refusal(service.removeTemp('mkt-owen', 't1', { member: session }));
      expect(held).toMatchObject({ status: 409, code: E.MEMBER_BUSY });
      expect(held.message).toContain('wi-9');
      items = [];
      busy.add(session);
      expect((await refusal(service.removeTemp('mkt-owen', 't1', { member: session }))).code).toBe(E.MEMBER_BUSY);
      await service.removeTemp('mkt-owen', 't1', { member: session, force: true });
      expect(temps()).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------------- tick

  describe('tick', () => {
    let session: string;

    beforeEach(async () => {
      const out = await add({ workItemId: 'wi-7' });
      session = (out.member as { sessionName: string }).sessionName;
    });

    it('keeps a fresh member', async () => {
      now = new Date(now.getTime() + HOUR);
      expect(await service.tick()).toEqual({ removed: [], kept: 1 });
      expect(delivered).toEqual([]);
    });

    it('removes it 30 idle minutes after its bound work was accepted, with one note to the lead', async () => {
      const done = new Date(now.getTime() + HOUR).toISOString();
      items = [item({ id: 'wi-7', target: session, status: 'verified', completedAt: done })];
      now = new Date(Date.parse(done) + 29 * MIN);
      expect((await service.tick()).removed).toEqual([]);
      now = new Date(Date.parse(done) + 31 * MIN);
      const out = await service.tick();
      expect(out.removed).toEqual([expect.objectContaining({ name: 'Temp-Developer-1', why: 'its work (wi-7) was accepted' })]);
      expect(temps()).toHaveLength(0);
      expect(delivered).toHaveLength(1);
      expect(delivered[0].session).toBe('mkt-owen');
      expect(delivered[0].text).toContain('[TEMP MEMBER] Temp-Developer-1 (temporary developer) was removed from Marketing: its work (wi-7) was accepted');
      expect((await store.events()).slice(-1)[0]).toMatchObject({ type: 'removed', by: 'system', workItemId: 'wi-7' });
    });

    it('counts terminal output as activity for the idle wait', async () => {
      const done = new Date(now.getTime() + HOUR).toISOString();
      items = [item({ id: 'wi-7', target: session, status: 'done', completedAt: done })];
      now = new Date(Date.parse(done) + 40 * MIN);
      activity.set(session, now.getTime() - 5 * MIN);
      expect((await service.tick()).removed).toEqual([]);
    });

    it('never removes a member that is mid-turn or holds live work, whatever its age', async () => {
      now = new Date(now.getTime() + 5 * DAY);
      busy.add(session);
      expect(await service.tick()).toEqual({ removed: [], kept: 1 });
      busy.clear();
      for (const status of TEMP_MEMBER_CONSTANTS.LIVE_WORK_STATUSES) {
        items = [item({ id: 'wi-8', target: session, status })];
        expect((await service.tick()).removed).toEqual([]);
      }
      expect(temps()).toHaveLength(1);
      items = [];
      expect((await service.tick()).removed).toHaveLength(1);
    });

    it('reads an unknown busy state as busy', async () => {
      now = new Date(now.getTime() + 5 * DAY);
      (service as unknown as { deps: { isBusy: () => Promise<boolean> } }).deps.isBusy = async () => Promise.reject(new Error('tracker down'));
      expect(await service.tick()).toEqual({ removed: [], kept: 1 });
    });

    it('removes it after 6 hours without work', async () => {
      now = new Date(now.getTime() + 5 * HOUR + 50 * MIN);
      expect((await service.tick()).removed).toEqual([]);
      now = new Date(now.getTime() + 20 * MIN);
      expect((await service.tick()).removed).toEqual([expect.objectContaining({ why: 'it had no work for 6 hours' })]);
    });

    it('waits for the lead\'s review of reported work, up to the 3-day limit', async () => {
      items = [item({ id: 'wi-7', target: session, status: 'done_by_worker', completedAt: now.toISOString() })];
      now = new Date(now.getTime() + 2 * DAY);
      expect((await service.tick()).removed).toEqual([]);
      now = new Date(now.getTime() + DAY + MIN);
      expect((await service.tick()).removed).toEqual([expect.objectContaining({ why: 'it reached the 3-day limit for temporary members' })]);
    });

    it('measures "unused" from its last finished work, not from creation', async () => {
      const done = new Date(now.getTime() + 5 * HOUR).toISOString();
      items = [item({ id: 'wi-other', target: session, status: 'done', completedAt: done })];
      now = new Date(now.getTime() + 7 * HOUR);
      expect((await service.tick()).removed).toEqual([]);
    });

    it('leaves permanent members and a member the owner just made permanent alone', async () => {
      now = new Date(now.getTime() + 5 * DAY);
      const stale = makeTeam();
      stale.members.push({ ...temps()[0] });
      delete temps()[0].temporary;
      (service as unknown as { deps: { getTeams: () => Promise<Team[]> } }).deps.getTeams = (() => {
        let calls = 0;
        return async () => (calls++ === 0 ? [stale] : teams);
      })();
      expect((await service.tick()).removed).toEqual([]);
      expect(team().members).toHaveLength(3);
    });
  });

  // -------------------------------------------------------- seat requests

  describe('requestSeat', () => {
    const request = (input: Record<string, unknown> = {}, caller = 'mkt-owen') => service.requestSeat(caller, 't1', { role: 'developer', reason: 'client work doubles every month', ...input });

    it('writes the card in Chinese for a Chinese-writing owner', async () => {
      (service as unknown as { deps: { ownerLanguage?: () => Promise<'zh'> } }).deps.ownerLanguage = async () => 'zh';
      kept = 2;
      await request();
      const ask = asks[0];
      expect(ask.title).toBe('Owen 申请给 Marketing 增加一个长期 developer');
      expect(ask.question).toBe('给 Marketing 团队增加一个长期的 developer 席位吗？');
      expect(ask.body?.[0]).toBe('原因：client work doubles every month');
      expect(ask.body?.[2]).toContain('Owen 有 2 次因为没有组员能接而自己做');
      expect(ask.options.map((o: { label: string }) => o.label)).toEqual(['同意', '先不']);
      expect(ask.defaultKey).toBe(asks[0].options[1].key);
    });

    it('posts one owner card with the reason and the evidence, default Not now, 7 days', async () => {
      team().tempHeadcount = 5;
      await add();
      await add();
      await service.removeTemp('mkt-owen', 't1', { member: 'Temp-Developer-1' });
      await add({ role: 'designer' });
      kept = 4;
      const out = await request();
      expect(out).toMatchObject({ requested: true, decisionId: 'D-1' });
      expect(asks).toHaveLength(1);
      const ask = asks[0];
      expect(ask.kind).toBe('team_seat');
      expect(ask.asker).toBe('mkt-owen');
      expect(ask.title).toBe('Owen asks for a permanent developer on Marketing');
      expect(ask.question).toBe('Add a permanent developer to Marketing?');
      expect(ask.body).toEqual([
        'Why: client work doubles every month',
        '• In the last 14 days the team opened 2 temporary developer members.',
        '• In the last 14 days Owen kept work 4 times because no member could take it.',
        '• The team has 4 members now, 2 of them temporary.',
        'On Approve, Temp-Developer-2 (temporary now) becomes a permanent member and keeps its work and memory.',
      ]);
      expect(ask.options.map((o) => [o.key, o.label])).toEqual([['a', 'Approve'], ['b', 'Not now']]);
      expect(ask.defaultKey).toBe('b');
      expect(ask.yesKey).toBe('a');
      expect(ask.deadline.getTime() - now.getTime()).toBe(7 * DAY);
      expect(ask.place).toEqual({ slackChannelId: 'C-MKT' });
      expect(await store.seatRequests()).toEqual([expect.objectContaining({ decisionId: 'D-1', teamId: 't1', role: 'developer', status: 'open', askerSession: 'mkt-owen' })]);
    });

    it('says a new member joins when no temporary member of the role exists', async () => {
      await request({ name: 'Kai' });
      expect(asks[0].body).toContain('On Approve, a new developer named Kai joins the team. It starts when it is given work.');
      expect(asks[0].body).toContain('• In the last 14 days the team opened 0 temporary developer members.');
      expect(asks[0].body).toContain('• The team has 2 members now.');
    });

    it('allows one open request per team and role', async () => {
      await request();
      const err = await refusal(request());
      expect(err).toMatchObject({ status: 409, code: E.SEAT_REQUEST_OPEN });
      expect(err.message).toContain('D-1');
      await request({ role: 'designer' });
      expect(asks).toHaveLength(2);
    });

    it('refuses a non-lead, a bad role and a missing card service', async () => {
      expect(await refusal(request({}, 'mkt-ella'))).toMatchObject({ status: 403, code: E.NOT_LEAD });
      expect(await refusal(request({ role: 'tech-lead' }))).toMatchObject({ status: 400, code: E.ROLE_NOT_ALLOWED });
      expect(await refusal(request({ reason: '' }))).toMatchObject({ status: 400, code: E.REASON_REQUIRED });
      cardsRunning = false;
      expect(await refusal(request())).toMatchObject({ status: 503, code: E.CARDS_UNAVAILABLE });
      expect(asks).toHaveLength(0);
    });

    it('passes on the decision service\'s refusal', async () => {
      (service as unknown as { deps: { decisions: () => unknown } }).deps.decisions = () => ({
        askPrebuilt: async () => {
          throw Object.assign(new Error('The owner skipped this question (D-3)'), { status: 409 });
        },
        get: async () => null,
      });
      const err = await refusal(request());
      expect(err.status).toBe(409);
      expect(err.message).toContain('The owner skipped this question');
      expect(await store.seatRequests()).toEqual([]);
    });
  });

  describe('onSettled', () => {
    const request = (input: Record<string, unknown> = {}) => service.requestSeat('mkt-owen', 't1', { role: 'developer', reason: 'client work doubles', ...input });

    it('Approve makes the oldest live temporary member of the role permanent', async () => {
      await add();
      now = new Date(now.getTime() + HOUR);
      await add();
      const [first, second] = temps();
      await request();
      const note = await service.onSettled(settle('D-1', { status: 'resolved', chosenKey: 'a' }));
      const kept1 = team().members.find((m) => m.id === first.id)!;
      expect(kept1.temporary).toBeUndefined();
      expect(kept1.name).toBe('Developer-1');
      expect(kept1.agentId).toBe('marketing-temp-developer-1-member-1');
      expect(team().members.find((m) => m.id === second.id)!.temporary).toBeDefined();
      expect(note).toContain('[SEAT REQUEST] The owner approved a permanent developer on Marketing (D-1): Developer-1 is now a permanent member');
      expect(note).toContain('delegate-task --to marketing-temp-developer-1-member-1');
      expect((await store.events()).slice(-1)[0]).toMatchObject({ type: 'converted', by: 'owner', memberId: first.id });
      expect((await store.seatRequests())[0]).toMatchObject({ status: 'approved', memberId: first.id });
      // The converted member is permanent: the tick never removes it.
      now = new Date(now.getTime() + 10 * DAY);
      await service.tick();
      expect(team().members.some((m) => m.id === first.id)).toBe(true);
    });

    it('Approve with a requested name renames the converted member', async () => {
      await add();
      await request({ name: 'Kai' });
      await service.onSettled(settle('D-1', { status: 'resolved', chosenKey: 'a' }));
      expect(team().members.map((m) => m.name)).toEqual(['Owen', 'Ella', 'Kai']);
      expect(temps()).toHaveLength(0);
    });

    it('Approve without a temporary member adds a permanent one through the add path', async () => {
      await request();
      const note = await service.onSettled(settle('D-1', { status: 'resolved', chosenKey: 'a' }));
      const added = team().members[2];
      expect(added).toMatchObject({ name: 'Developer-1', role: 'developer' });
      expect(added.temporary).toBeUndefined();
      expect(note).toContain('Developer-1 joined as a permanent developer; it starts when you assign it work');
      expect(await store.events()).toEqual([]);
    });

    it('Not now and the deadline change nothing and block the same seat for 14 days', async () => {
      await add();
      await request();
      const note = await service.onSettled(settle('D-1', { status: 'resolved', chosenKey: 'b' }));
      expect(note).toContain('[SEAT REQUEST] The owner said "not now" to a permanent developer on Marketing (D-1). Nothing changed.');
      expect(note).toContain('requested again from 2026-12-10');
      expect(temps()).toHaveLength(1);
      now = new Date(now.getTime() + 13 * DAY);
      const err = await refusal(request());
      expect(err).toMatchObject({ status: 409, code: E.SEAT_RECENTLY_DECLINED });
      expect(err.message).toContain('said "not now"');
      expect(err.message).toContain('2026-12-10');
      await request({ role: 'designer' });
      now = new Date(now.getTime() + 2 * DAY);
      await request();
      expect(asks).toHaveLength(3);
      const expired = await service.onSettled(settle('D-3', { status: 'defaulted', chosenKey: 'b' }));
      expect(expired).toContain('said "not now"');
      expect((await refusal(request())).code).toBe(E.SEAT_RECENTLY_DECLINED);
    });

    it('a card that vanished without its handler running counts as not now', async () => {
      await request();
      settle('D-1', { status: 'cancelled' });
      expect((await refusal(request())).code).toBe(E.SEAT_RECENTLY_DECLINED);
    });

    it('acts once per card, ignores other cards and a parked one', async () => {
      await request();
      expect(await service.onSettled({ id: 'D-77', status: 'resolved', chosenKey: 'a' } as OwnerDecision)).toBeNull();
      expect(await service.onSettled(settle('D-1', { status: 'parked' }))).toBeNull();
      expect((await store.seatRequests())[0].status).toBe('open');
      await service.onSettled(settle('D-1', { status: 'resolved', chosenKey: 'a' }));
      expect(await service.onSettled(decisions.get('D-1')!)).toBeNull();
      expect(team().members).toHaveLength(3);
    });

    it('tells the lead when an approved seat could not be filled', async () => {
      await request();
      (service as unknown as { deps: { addMember: () => Promise<never> } }).deps.addMember = async () => Promise.reject(new Error('disk full'));
      const note = await service.onSettled(settle('D-1', { status: 'resolved', chosenKey: 'a' }));
      expect(note).toContain('adding the member failed (disk full). Tell the owner.');
    });
  });

  it('status lists the headcount and the temporary members', async () => {
    await add();
    expect(await service.status('t1')).toEqual({
      teamId: 't1',
      headcount: { used: 1, limit: 2 },
      members: [expect.objectContaining({ name: 'Temp-Developer-1', role: 'developer', sessionName: 'marketing-temp-developer-1-member-1' })],
    });
  });
});
