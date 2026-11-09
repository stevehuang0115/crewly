/**
 * Tests for ModelTierService — toggle, review, proposals → one owner card →
 * apply on yes, and the quality guard's revert proposal (crewly#1173).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import type { Team } from '../../types/index.js';
import type { OwnerDecision } from '../../types/decision.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { PrebuiltAsk } from '../decisions/decision.service.js';
import type { TokenUsageEvent } from '../monitoring/token-usage.service.js';
import { ModelTierStore } from './model-tier.store.js';
import { ModelTierError, ModelTierService, effectiveFromTier } from './model-tier.service.js';

const HOUR = 60 * 60 * 1000;

function makeTeam(): Team {
  return {
    id: 't1',
    name: 'Marketing',
    leaderIds: ['m-owen'],
    optimizeUsage: true,
    members: [
      { id: 'm-owen', name: 'Owen', sessionName: 'mkt-owen', role: 'team-leader', runtimeType: 'claude-code', canDelegate: true },
      { id: 'm-ella', name: 'Ella', sessionName: 'mkt-ella', role: 'developer', runtimeType: 'claude-code', parentMemberId: 'm-owen' },
      { id: 'm-sam', name: 'Sam', sessionName: 'mkt-sam', role: 'developer', runtimeType: 'claude-code', parentMemberId: 'm-owen', modelId: 'opus' },
    ],
    projectIds: [],
    createdAt: '',
    updatedAt: '',
  } as unknown as Team;
}

describe('ModelTierService', () => {
  let dir: string;
  let teams: Team[];
  let now: Date;
  let items: WorkItem[];
  let asks: PrebuiltAsk[];
  let decisions: Map<string, OwnerDecision>;
  let delivered: Array<{ session: string; text: string }>;
  let restarted: string[];
  let service: ModelTierService;
  const events: Array<[string, TokenUsageEvent]> = [];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tier-svc-'));
    teams = [makeTeam()];
    now = new Date('2026-10-08T12:00:00Z');
    items = [];
    asks = [];
    decisions = new Map();
    delivered = [];
    restarted = [];
    events.length = 0;
    events.push(['mkt-ella', { timestamp: '2026-10-07T00:00:00Z', agentId: 'x', model: 'claude-sonnet-5', input: 1000, cachedInput: 99_000, output: 2000 }]);
    service = new ModelTierService({
      store: ModelTierStore.inHome(dir),
      getTeams: async () => teams,
      saveTeam: async (t) => {
        teams = teams.map((x) => (x.id === t.id ? JSON.parse(JSON.stringify(t)) : x));
      },
      forEachEvent: (visit, since) => {
        for (const [s, e] of events) if (!since || Date.parse(e.timestamp) >= since.getTime()) visit(s, e);
      },
      workItems: async () => items,
      decisions: () => ({
        askPrebuilt: async (ask: PrebuiltAsk) => {
          asks.push(ask);
          const d = { id: `D-${asks.length}`, status: 'open', kind: ask.kind, tierChange: ask.tierChange, question: ask.question } as unknown as OwnerDecision;
          decisions.set(d.id, d);
          return d;
        },
        get: async (id: string) => decisions.get(id) ?? null,
      }),
      deliverToAgent: async (session, text) => {
        delivered.push({ session, text });
        return true;
      },
      teamChannelOf: async () => 'C-MKT',
      tlSkillsPath: '/skills/team-leader',
      restartIfIdle: async (session) => {
        restarted.push(session);
        return 'restarted';
      },
      now: () => now,
    });
  });

  afterEach(async () => {
    service.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const team = (): Team => teams[0];
  const member = (id: string) => team().members.find((m) => m.id === id)!;

  describe('settings', () => {
    it('shows the toggle, tier maps and each member model', async () => {
      const v = await service.settings('t1');
      expect(v.optimizeUsage).toBe(true);
      expect(v.tierMaps['claude-code']).toEqual({ strong: 'opus', mid: 'sonnet', weak: 'haiku' });
      expect(v.members.map((m) => [m.name, m.model])).toEqual([
        ['Owen', 'runtime default'],
        ['Ella', 'sonnet'],
        ['Sam', 'opus'],
      ]);
    });

    it('updates the toggle, team map and member tiers, and refuses bad input', async () => {
      await service.updateSettings('t1', { optimizeUsage: false, tierModels: { 'claude-code': { weak: 'claude-haiku-5-5' } }, memberTiers: { 'm-ella': 'weak' } });
      expect(team().optimizeUsage).toBe(false);
      expect(member('m-ella').tier).toBe('weak');
      expect((await service.settings('t1')).members.find((m) => m.name === 'Ella')!.model).toBe('claude-haiku-5-5');
      await service.updateSettings('t1', { memberTiers: { 'm-ella': '' } });
      expect(member('m-ella').tier).toBeUndefined();
      await expect(service.updateSettings('t1', { optimizeUsage: 'yes' })).rejects.toMatchObject({ status: 400 });
      await expect(service.updateSettings('t1', { memberTiers: { 'm-ella': 'super' } })).rejects.toMatchObject({ status: 400 });
      await expect(service.updateSettings('t1', { memberTiers: { nobody: 'weak' } })).rejects.toMatchObject({ status: 400 });
      await expect(service.updateSettings('t1', { tierModels: { 'claude-code': { weak: 'a b' } } })).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('review', () => {
    it('sends the lead the report and the instructions', async () => {
      const r = await service.startReview('t1', 'on_demand');
      expect(r.lead).toBe('Owen');
      expect(delivered).toHaveLength(1);
      expect(delivered[0].session).toBe('mkt-owen');
      expect(delivered[0].text).toContain('[MODEL TIER REVIEW] Requested usage review for team Marketing');
      expect(delivered[0].text).toContain('| Ella | – → sonnet | 1 | 100k |');
      expect(delivered[0].text).toContain('bash /skills/team-leader/propose-tier-change/execute.sh --submit');
      expect((await service.settings('t1')).review.drafting).toBe(true);
    });

    it('refuses a team without a lead', async () => {
      teams[0] = { ...team(), leaderIds: [], members: team().members.map((m) => ({ ...m, role: 'developer', canDelegate: false })) } as Team;
      await expect(service.startReview('t1', 'on_demand')).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('proposals → one card → apply', () => {
    it('only the lead proposes, only while Optimize usage is on', async () => {
      await expect(service.propose('mkt-ella', { member: 'Sam', tier: 'weak', reason: 'x' })).rejects.toMatchObject({ status: 403 });
      await expect(service.propose(undefined, { member: 'Sam', tier: 'weak', reason: 'x' })).rejects.toMatchObject({ status: 403 });
      teams[0] = { ...team(), optimizeUsage: false };
      await expect(service.propose('mkt-owen', { member: 'Sam', tier: 'weak', reason: 'x' })).rejects.toMatchObject({ status: 409 });
    });

    it('validates member, tier and reason; the lead stays at mid or above', async () => {
      await expect(service.propose('mkt-owen', { member: 'Nobody', tier: 'weak', reason: 'x' })).rejects.toMatchObject({ status: 400 });
      await expect(service.propose('mkt-owen', { member: 'Ella', tier: 'tiny', reason: 'x' })).rejects.toMatchObject({ status: 400 });
      await expect(service.propose('mkt-owen', { member: 'Ella', tier: 'weak' })).rejects.toMatchObject({ status: 400 });
      await expect(service.propose('mkt-owen', { member: 'Owen', tier: 'weak', reason: 'x' })).rejects.toMatchObject({ status: 400 });
      await expect(service.propose('mkt-owen', { member: 'Owen', tier: 'mid', reason: 'mostly routing' })).resolves.toMatchObject({ added: 'change' });
    });

    it('bundles every proposal into ONE owner card in the team channel and applies it on yes', async () => {
      const a = await service.propose('mkt-owen', { member: 'ella', tier: 'weak', reason: 'polls the inbox and sorts tickets' });
      expect(a).toMatchObject({ added: 'change', change: 'Ella: no tier (sonnet) -> weak (haiku)' });
      await service.propose('mkt-owen', { member: 'Sam', tier: 'mid', reason: 'writes posts from briefs' });
      // proposing the same member again replaces the earlier entry
      await service.propose('mkt-owen', { member: 'Sam', tier: 'mid', reason: 'writes posts from approved briefs' });
      await service.propose('mkt-owen', { routing: 'polling / formatting / sorting -> Ella' });
      const sub = await service.propose('mkt-owen', { submit: true });
      expect(sub).toMatchObject({ submitted: true, decisionId: 'D-1', changes: 2, routing: 1 });
      expect(asks).toHaveLength(1);
      const ask = asks[0];
      expect(ask.kind).toBe('model_tier_change');
      expect(ask.asker).toBe('mkt-owen');
      expect(ask.place).toEqual({ slackChannelId: 'C-MKT' });
      expect(ask.defaultKey).toBe('b');
      expect(ask.yesKey).toBe('a');
      expect(ask.options.map((o) => o.label)).toEqual(['Apply', 'Keep as is']);
      expect(ask.question).toBe('Change model tiers for Marketing? Owen proposes: Ella no tier→weak, Sam no tier→mid.');
      expect(ask.body!.join('\n')).toContain('*Sam*: no tier (opus) → mid (sonnet) (clears the fixed model `opus`) — writes posts from approved briefs');
      expect(ask.body!.join('\n')).toContain('Routing: "polling / formatting / sorting -> Ella"');
      expect(ask.body!.join('\n')).toMatch(/saves about \$\d+\.\d\d a week/);
      expect(ask.tierChange!.changes).toHaveLength(2);
      expect((await service.settings('t1')).review.openDecisionId).toBe('D-1');
      // nothing changed yet
      expect(member('m-ella').tier).toBeUndefined();

      // a second submit while the card is open is refused
      await service.propose('mkt-owen', { member: 'Ella', tier: 'mid', reason: 'x' });
      await expect(service.propose('mkt-owen', { submit: true })).rejects.toMatchObject({ status: 409 });
      await service.propose('mkt-owen', { clear: true });

      const settled = { ...decisions.get('D-1')!, status: 'resolved', chosenKey: 'a' } as OwnerDecision;
      decisions.set('D-1', settled);
      const note = await service.onSettled(settled);
      expect(note).toContain('[MODEL TIERS] The owner approved D-1: Ella → weak (haiku), Sam → mid (sonnet)');
      expect(note).toContain('Idle members restart now on their new model');
      await service.restartsSettled();
      expect(restarted).toEqual(['mkt-ella', 'mkt-sam']);
      expect(note).toContain('Routing rules now in force');
      expect(member('m-ella').tier).toBe('weak');
      expect(member('m-sam').tier).toBe('mid');
      expect(member('m-sam').modelId).toBeUndefined();
      expect(team().tierRoutingRules).toEqual(['polling / formatting / sorting -> Ella']);
      const view = await service.settings('t1');
      expect(view.review.openDecisionId).toBeNull();
      expect(view.members.find((m) => m.name === 'Ella')!.model).toBe('haiku');
      expect(view.review.recent.map((r) => [r.memberName, r.guard])).toEqual([
        ['Sam', 'watching'],
        ['Ella', 'watching'],
      ]);
    });

    it('changes nothing when the owner keeps the tiers', async () => {
      await service.propose('mkt-owen', { member: 'Ella', tier: 'weak', reason: 'polls only' });
      await service.propose('mkt-owen', { submit: true });
      const d = { ...decisions.get('D-1')!, status: 'resolved', chosenKey: 'b' } as OwnerDecision;
      const note = await service.onSettled(d);
      expect(note).toContain('kept the tiers as they are');
      expect(member('m-ella').tier).toBeUndefined();
      expect((await service.settings('t1')).review.openDecisionId).toBeNull();
      const defaulted = { ...d, status: 'defaulted', chosenKey: 'b' } as OwnerDecision;
      await service.onSettled(defaulted);
      expect(member('m-ella').tier).toBeUndefined();
    });

    it('submit with nothing proposed closes the review without a card', async () => {
      await service.startReview('t1', 'on_demand');
      await expect(service.propose('mkt-owen', { submit: true })).resolves.toMatchObject({ submitted: false });
      expect(asks).toHaveLength(0);
      expect((await service.settings('t1')).review.drafting).toBe(false);
    });
  });

  describe('tick', () => {
    it('starts a due weekly review, not again within the week', async () => {
      const r1 = await service.tick();
      expect(r1.reviews).toHaveLength(1);
      expect(delivered[0].text).toContain('Weekly usage review');
      await service.propose('mkt-owen', { submit: true });
      now = new Date(now.getTime() + 24 * HOUR);
      expect((await service.tick()).reviews).toHaveLength(0);
      now = new Date(now.getTime() + 7 * 24 * HOUR);
      expect((await service.tick()).reviews).toHaveLength(1);
    });

    it('does not review teams with Optimize usage off', async () => {
      teams[0] = { ...team(), optimizeUsage: false };
      expect((await service.tick()).reviews).toHaveLength(0);
      expect(delivered).toHaveLength(0);
    });

    it('sends a draft the lead never submitted', async () => {
      await service.propose('mkt-owen', { member: 'Ella', tier: 'weak', reason: 'polls only' });
      now = new Date(now.getTime() + 3 * HOUR);
      const r = await service.tick();
      expect(r.autoSubmitted).toEqual(['t1']);
      expect(asks).toHaveLength(1);
    });
  });

  describe('quality guard', () => {
    const settledItem = (id: string, status: string, at: Date): WorkItem =>
      ({ id, target: 'mkt-ella', title: id, type: 'delegate', status, createdAt: at.toISOString(), completedAt: at.toISOString(), statusChangedAt: at.toISOString(), retryCount: 0 } as unknown as WorkItem);

    async function lowerElla(): Promise<void> {
      // Baseline: 10 items before the change, 1 sent back
      for (let i = 0; i < 10; i++) items.push(settledItem(`b${i}`, i === 0 ? 'rejected' : 'verified', new Date(now.getTime() - (20 - i) * HOUR)));
      await service.propose('mkt-owen', { member: 'Ella', tier: 'weak', reason: 'polls only' });
      await service.propose('mkt-owen', { submit: true });
      await service.onSettled({ ...decisions.get('D-1')!, status: 'resolved', chosenKey: 'a' } as OwnerDecision);
      expect(member('m-ella').tier).toBe('weak');
    }

    it('asks the owner to move a member back when its work got worse', async () => {
      await lowerElla();
      now = new Date(now.getTime() + HOUR);
      items.push(settledItem('a1', 'rejected', now), settledItem('a2', 'rejected', now), settledItem('a3', 'rejected', now));
      expect((await service.tick()).reverts).toEqual([]); // 3 < 5 items: wait
      items.push(settledItem('a4', 'verified', now), settledItem('a5', 'verified', now));
      const r = await service.tick();
      expect(r.reverts).toEqual(['D-2']);
      const ask = asks[1];
      expect(ask.tierChange!.kind).toBe('revert');
      expect(ask.tierChange!.changes[0]).toMatchObject({ memberName: 'Ella', from: 'weak', to: 'mid', clearTier: true });
      expect(ask.options[0].label).toBe('Move back');
      expect(ask.body!.join('\n')).toContain('Since then 3 of 5 sent back; before the change 1 of 10 sent back');
      expect((await service.settings('t1')).review.recent[0].guard).toBe('revert_proposed');
      // not asked twice
      expect((await service.tick()).reverts).toEqual([]);
      // owner says yes → the tier is removed again (Ella had none)
      await service.onSettled({ ...decisions.get('D-2')!, status: 'resolved', chosenKey: 'a' } as OwnerDecision);
      expect(member('m-ella').tier).toBeUndefined();
    });

    it('marks the change ok when quality held', async () => {
      await lowerElla();
      now = new Date(now.getTime() + HOUR);
      for (let i = 0; i < 5; i++) items.push(settledItem(`a${i}`, 'verified', now));
      expect((await service.tick()).reverts).toEqual([]);
      expect((await service.settings('t1')).review.recent[0].guard).toBe('ok');
    });
  });

  describe('auto mode (the lead decides, tells the owner)', () => {
    beforeEach(() => {
      teams[0] = { ...team(), tierChangeMode: 'auto' };
    });

    it('the owner sets the change mode; default approve; bad values refused', async () => {
      teams[0] = { ...team(), tierChangeMode: undefined };
      expect((await service.settings('t1')).tierChangeMode).toBe('approve');
      await service.updateSettings('t1', { tierChangeMode: 'auto' });
      expect(team().tierChangeMode).toBe('auto');
      expect((await service.settings('t1')).tierChangeMode).toBe('auto');
      await expect(service.updateSettings('t1', { tierChangeMode: 'silent' })).rejects.toMatchObject({ status: 400 });
    });

    it('the review tells the lead its changes apply at once', async () => {
      await service.startReview('t1', 'on_demand');
      expect(delivered[0].text).toContain('you decide: your changes apply as soon as you submit');
      expect(delivered[0].text).toContain('the owner gets one notice with Undo');
    });

    it('applies a submitted proposal at once and posts ONE notice with Undo instead of a card', async () => {
      await service.propose('mkt-owen', { member: 'Ella', tier: 'weak', reason: 'polls the inbox' });
      await service.propose('mkt-owen', { member: 'Sam', tier: 'mid', reason: 'writes posts from briefs' });
      await service.propose('mkt-owen', { routing: 'polling -> Ella' });
      const r = await service.propose('mkt-owen', { submit: true });
      expect(r).toMatchObject({ submitted: true, applied: true, changes: 2, routing: 1, noticeId: 'D-1' });
      // applied now, by the same path as the owner's Apply
      expect(member('m-ella').tier).toBe('weak');
      expect(member('m-sam').tier).toBe('mid');
      expect(member('m-sam').modelId).toBeUndefined();
      expect(team().tierRoutingRules).toEqual(['polling -> Ella']);
      await service.restartsSettled();
      expect(restarted).toEqual(['mkt-ella', 'mkt-sam']);

      expect(asks).toHaveLength(1);
      const ask = asks[0];
      expect(ask.kind).toBe('model_tier_change');
      expect(ask.place).toEqual({ slackChannelId: 'C-MKT' });
      expect(ask.title).toBe('Model tiers — Marketing');
      expect(ask.question).toBe('Owen changed model tiers for Marketing: Ella → weak, Sam → mid.');
      expect(ask.options.map((o) => o.label)).toEqual(['Undo', 'Keep']);
      expect(ask.defaultKey).toBe('b');
      expect(ask.yesKey).toBe('b');
      const body = ask.body!.join('\n');
      expect(body).toContain('*Ella*: no tier (sonnet) → weak (haiku) — polls the inbox');
      expect(body).toContain("(its fixed model `opus` was cleared)");
      expect(body).toContain('New work routing: "polling -> Ella"');
      expect(body).not.toMatch(/D-\d|TR-/);
      expect(ask.tierChange).toMatchObject({ kind: 'undo', notice: 'applied', removeRouting: ['polling -> Ella'] });
      // a notice does not hold up the next review
      const view = await service.settings('t1');
      expect(view.review.openDecisionId).toBeNull();
      expect(view.review.drafting).toBe(false);
    });

    it('Undo reverts exactly those changes, and only for members still on them', async () => {
      teams[0].tierRoutingRules = ['older rule'];
      await service.propose('mkt-owen', { member: 'Ella', tier: 'weak', reason: 'polls' });
      await service.propose('mkt-owen', { member: 'Sam', tier: 'mid', reason: 'briefs' });
      await service.propose('mkt-owen', { routing: 'polling -> Ella' });
      await service.propose('mkt-owen', { submit: true });
      // The owner moved Sam by hand since: Undo leaves Sam alone.
      await service.updateSettings('t1', { memberTiers: { 'm-sam': 'strong' } });
      await service.restartsSettled();
      restarted.length = 0;
      const note = await service.onSettled({ ...decisions.get('D-1')!, status: 'resolved', chosenKey: 'a' } as OwnerDecision);
      expect(note).toContain('[MODEL TIERS] The owner undid your tier changes: Ella → no tier (sonnet)');
      expect(note).toContain('1 member(s) were left as they are');
      expect(member('m-ella').tier).toBeUndefined();
      expect(member('m-sam').tier).toBe('strong');
      expect(team().tierRoutingRules).toEqual(['older rule']);
      await service.restartsSettled();
      expect(restarted).toEqual(['mkt-ella']);
      const recent = (await service.settings('t1')).review.recent;
      expect(recent.find((x) => x.memberName === 'Ella' && x.to === 'weak')!.guard).toBe('undone');
    });

    it('Undo restores a cleared fixed model', async () => {
      await service.propose('mkt-owen', { member: 'Sam', tier: 'mid', reason: 'briefs' });
      await service.propose('mkt-owen', { submit: true });
      await service.onSettled({ ...decisions.get('D-1')!, status: 'resolved', chosenKey: 'a' } as OwnerDecision);
      expect(member('m-sam').tier).toBeUndefined();
      expect(member('m-sam').modelId).toBe('opus');
    });

    it('Undo puts back what the member had when the change applied, not when it was proposed', async () => {
      await service.propose('mkt-owen', { member: 'Ella', tier: 'weak', reason: 'polls' });
      // The owner moved Ella by hand while the draft waited.
      await service.updateSettings('t1', { memberTiers: { 'm-ella': 'strong' } });
      await service.propose('mkt-owen', { submit: true });
      expect(member('m-ella').tier).toBe('weak');
      await service.onSettled({ ...decisions.get('D-1')!, status: 'resolved', chosenKey: 'a' } as OwnerDecision);
      expect(member('m-ella').tier).toBe('strong');
    });

    it('Undo of an older batch leaves a member a later batch changed again', async () => {
      await service.propose('mkt-owen', { member: 'Ella', tier: 'weak', reason: 'polls' });
      await service.propose('mkt-owen', { submit: true });
      await service.propose('mkt-owen', { member: 'Ella', tier: 'mid', reason: 'more work' });
      await service.propose('mkt-owen', { submit: true });
      await service.propose('mkt-owen', { member: 'Ella', tier: 'weak', reason: 'quiet again' });
      await service.propose('mkt-owen', { submit: true });
      await service.onSettled({ ...decisions.get('D-1')!, status: 'resolved', chosenKey: 'a' } as OwnerDecision);
      expect(member('m-ella').tier).toBe('weak');
    });

    it('Undo puts back routing rules the batch pushed out', async () => {
      const old = Array.from({ length: 20 }, (_, i) => `rule ${i}`);
      teams[0].tierRoutingRules = [...old];
      await service.propose('mkt-owen', { routing: 'polling -> Ella' });
      await service.propose('mkt-owen', { submit: true });
      expect(team().tierRoutingRules).toEqual([...old.slice(1), 'polling -> Ella']);
      await service.onSettled({ ...decisions.get('D-1')!, status: 'resolved', chosenKey: 'a' } as OwnerDecision);
      expect([...team().tierRoutingRules!].sort()).toEqual([...old].sort());
    });

    it('two submits at the same time apply once', async () => {
      await service.propose('mkt-owen', { member: 'Ella', tier: 'weak', reason: 'polls' });
      const both = await Promise.allSettled([service.propose('mkt-owen', { submit: true }), service.propose('mkt-owen', { submit: true })]);
      expect(both.filter((r) => r.status === 'fulfilled' && (r.value as { applied?: boolean }).applied)).toHaveLength(1);
      expect(asks).toHaveLength(1);
    });

    it('Keep, the deadline or a skip change nothing and tell the lead nothing', async () => {
      await service.propose('mkt-owen', { member: 'Ella', tier: 'weak', reason: 'polls' });
      await service.propose('mkt-owen', { submit: true });
      for (const d of [
        { status: 'resolved', chosenKey: 'b' },
        { status: 'defaulted', chosenKey: 'b' },
        { status: 'skipped' },
      ]) {
        expect(await service.onSettled({ ...decisions.get('D-1')!, ...d } as OwnerDecision)).toBeNull();
        expect(member('m-ella').tier).toBe('weak');
      }
    });

    it('keeps the phase 1 limits: the lead stays at mid or above, the orchestrator takes no tier', async () => {
      await expect(service.propose('mkt-owen', { member: 'Owen', tier: 'weak', reason: 'x' })).rejects.toMatchObject({ status: 400 });
      teams[0].members.push({ id: 'm-orc', name: 'Orc', sessionName: 'crewly-orc', role: 'orchestrator' } as never);
      await expect(service.propose('mkt-owen', { member: 'Orc', tier: 'weak', reason: 'x' })).rejects.toMatchObject({ status: 400 });
    });

    it('refuses to apply when owner notices cannot be posted', async () => {
      const blind = new ModelTierService({
        store: ModelTierStore.inHome(dir),
        getTeams: async () => teams,
        saveTeam: async () => undefined,
        forEachEvent: () => undefined,
        workItems: async () => [],
        decisions: () => null,
        deliverToAgent: async () => true,
        tlSkillsPath: '/skills/team-leader',
        now: () => now,
      });
      await blind.propose('mkt-owen', { member: 'Ella', tier: 'weak', reason: 'polls' });
      await expect(blind.propose('mkt-owen', { submit: true })).rejects.toMatchObject({ status: 503 });
      expect(member('m-ella').tier).toBeUndefined();
    });
  });

  describe('quality guard in auto mode', () => {
    const settledItem = (id: string, status: string, at: Date): WorkItem =>
      ({ id, target: 'mkt-ella', title: id, type: 'delegate', status, createdAt: at.toISOString(), completedAt: at.toISOString(), statusChangedAt: at.toISOString(), retryCount: 0 } as unknown as WorkItem);

    it('moves the member back at once, tells the lead and the owner, and "Keep the lower tier" undoes the move', async () => {
      teams[0] = { ...team(), tierChangeMode: 'auto' };
      for (let i = 0; i < 10; i++) items.push(settledItem(`b${i}`, i === 0 ? 'rejected' : 'verified', new Date(now.getTime() - (20 - i) * HOUR)));
      await service.propose('mkt-owen', { member: 'Ella', tier: 'weak', reason: 'polls only' });
      await service.propose('mkt-owen', { submit: true });
      expect(member('m-ella').tier).toBe('weak');
      now = new Date(now.getTime() + HOUR);
      items.push(settledItem('a1', 'rejected', now), settledItem('a2', 'rejected', now), settledItem('a3', 'rejected', now), settledItem('a4', 'verified', now), settledItem('a5', 'verified', now));
      await service.restartsSettled();
      restarted.length = 0;
      const r = await service.tick();
      expect(r.reverts).toEqual(['D-2']);
      // moved back without asking
      expect(member('m-ella').tier).toBeUndefined();
      await service.restartsSettled();
      expect(restarted).toEqual(['mkt-ella']);
      const ask = asks[1];
      expect(ask.title).toBe('Model tiers — quality check, Marketing');
      expect(ask.question).toBe("Ella's work was sent back more often on the weak tier, so it was moved back to no tier (sonnet).");
      expect(ask.body!.join('\n')).toContain('Since moving to weak: 3 of 5 sent back; before: 1 of 10 sent back.');
      expect(ask.options.map((o) => o.label)).toEqual(['Keep the lower tier', 'OK']);
      expect(ask.defaultKey).toBe('b');
      expect(ask.tierChange).toMatchObject({ kind: 'undo', notice: 'reverted' });
      expect(delivered.some((d) => d.session === 'mkt-owen' && d.text.startsWith("[MODEL TIERS] Quality check: Ella's work was sent back more often on weak"))).toBe(true);
      expect((await service.settings('t1')).review.recent.find((x) => x.to === 'weak')!.guard).toBe('auto_reverted');
      expect((await service.tick()).reverts).toEqual([]);

      const note = await service.onSettled({ ...decisions.get('D-2')!, status: 'resolved', chosenKey: 'a' } as OwnerDecision);
      expect(note).toContain('The owner chose to keep the lower tier');
      expect(member('m-ella').tier).toBe('weak');
      // the owner's choice is not watched again
      expect((await service.settings('t1')).review.recent[0].guard).toBe('not_watched');
      expect((await service.tick()).reverts).toEqual([]);
    });
  });

  it('effectiveFromTier reads a reviewed member on the sonnet default as mid', () => {
    expect(effectiveFromTier({ from: null, fromModel: 'sonnet' }, 'claude-code')).toBe('mid');
    expect(effectiveFromTier({ from: null, fromModel: 'runtime default' }, 'claude-code')).toBe('strong');
    expect(effectiveFromTier({ from: 'weak', fromModel: 'opus' }, 'claude-code')).toBe('weak');
  });

  it('ModelTierError carries the status', () => {
    const e = new ModelTierError(409, 'x');
    expect(e.status).toBe(409);
    expect(e.name).toBe('ModelTierError');
  });
});
