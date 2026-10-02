/**
 * Tests for the daily token caps: per agent, per team, all agents, boosts.
 */
import type { OwnerDecision } from '../../types/decision.types.js';
import type { SystemAskInput } from '../decisions/decision.service.js';
import { SpendCapError, SpendCapService, boostOfLabel, suggestedBoost, type SpendCapServiceDeps } from './spend-cap.service.js';
import { MemorySpendCapStore } from './spend-cap.store.js';
import type { SpendSummary } from './spend-ledger.service.js';

/** CJK characters: the harness writes English only. */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;

const M = 1_000_000;

/** Fake ledger: tokens per session set directly. */
class FakeLedger {
  used: Record<string, number> = {};
  usedToday(session: string): number {
    return this.used[session] ?? 0;
  }
  groupToday(sessions: readonly string[]): number {
    return [...new Set(sessions)].reduce((n, s) => n + this.usedToday(s), 0);
  }
  totalToday(): number {
    return Object.values(this.used).reduce((s, v) => s + v, 0);
  }
  invalidate(): void {}
  summarize(): SpendSummary {
    const agents = Object.entries(this.used).map(([session, t]) => ({ session, runtimes: ['claude-code'], todayTokens: t, windowTokens: t, windowCachedTokens: 0, daily: [t] }));
    return {
      today: '2026-10-02',
      days: [{ date: '2026-10-02', totalTokens: this.totalToday(), byAgent: { ...this.used }, byRuntime: {} }],
      agents,
      byRuntime: {},
      totalTokens: this.totalToday(),
      cachedTokens: 0,
      todayTokens: this.totalToday(),
      p90AgentDayTokens: 3.4 * M,
    };
  }
}

/** Fake decision service. */
class FakeDecisions {
  asked: SystemAskInput[] = [];
  replies: Array<{ id: string; text: string }> = [];
  async askSystem(input: SystemAskInput): Promise<OwnerDecision> {
    this.asked.push(input);
    return { id: `D-${this.asked.length}` } as OwnerDecision;
  }
  async replyInThread(id: string, text: string): Promise<boolean> {
    this.replies.push({ id, text });
    return true;
  }
}

/** Settle a card the way DecisionService does (option a/b/c from the asked labels). */
function settled(id: string, ask: SystemAskInput, choiceIndex: number, status: OwnerDecision['status'] = 'resolved'): OwnerDecision {
  const options = (ask.options as string[]).map((label, i) => ({ key: 'abc'[i], label: label.split(' — ')[0] }));
  return { id, kind: ask.kind, system: ask.system, options, chosenKey: options[choiceIndex]?.key, status } as OwnerDecision;
}

describe('SpendCapService', () => {
  let now: Date;
  let ledger: FakeLedger;
  let notices: string[];
  let decisions: FakeDecisions;
  let released: string[][];
  let store: MemorySpendCapStore;

  const make = (over: Partial<SpendCapServiceDeps> = {}): SpendCapService =>
    new SpendCapService({
      store,
      ledger,
      notifyOwner: async (t) => {
        notices.push(t);
      },
      decisions: () => decisions,
      displayNameOf: (s) => ({ 'crewly-orc': 'Orc', 'ella-1': 'Ella', 'owen-1': 'Owen', 'nova-1': 'Nova' })[s] ?? s,
      knownSessions: async () => ['crewly-orc', 'ella-1', 'owen-1', 'nova-1'],
      teams: async () => [
        { id: 'team-ce', name: 'CE', members: ['owen-1', 'nova-1'] },
        { id: 'team-mk', name: 'Marketing', members: ['ella-1'] },
      ],
      onReleased: async (s) => {
        released.push(s);
      },
      now: () => now,
      ...over,
    });

  beforeEach(() => {
    now = new Date(2026, 9, 2, 15, 0);
    ledger = new FakeLedger();
    notices = [];
    decisions = new FakeDecisions();
    released = [];
    store = new MemorySpendCapStore();
  });

  it('is off by default: nothing is stopped however many tokens are used', async () => {
    const svc = make();
    ledger.used['crewly-orc'] = 900 * M;
    await svc.evaluate();
    expect(svc.stopOf('crewly-orc')).toBeNull();
    expect(notices).toEqual([]);
    expect(decisions.asked).toEqual([]);
  });

  it('sends the 80% heads-up once', async () => {
    const svc = make();
    await svc.setCaps({ agents: { 'crewly-orc': '5M' } });
    ledger.used['crewly-orc'] = 4.1 * M;
    await svc.evaluate();
    await svc.evaluate();
    ledger.used['crewly-orc'] = 4.5 * M;
    await svc.evaluate();
    expect(notices).toEqual(['Heads-up: Orc has used 4.1M tokens of the 5M tokens daily token cap today (82%). At 5M it stops taking new turns until midnight.']);
    expect(svc.stopOf('crewly-orc')).toBeNull();
  });

  it('hard-stops at 100% (live, before the tick) and posts ONE decision card with boost options', async () => {
    const svc = make();
    await svc.setCaps({ defaultAgentCapTokens: 5 * M });
    ledger.used['ella-1'] = 5.01 * M;
    expect(svc.stopOf('ella-1')).toMatchObject({ session: 'ella-1', scope: 'agent', capTokens: 5 * M });
    await svc.evaluate();
    await svc.evaluate();
    expect(decisions.asked).toHaveLength(1);
    const card = decisions.asked[0];
    expect(card.kind).toBe('spend_cap');
    expect(card.system).toEqual({ key: 'ella-1', defaultIsDecline: true });
    expect(card.question).toBe('Ella hit its daily token cap (5M tokens) and is stopped until midnight. Boost it for today?');
    expect(card.options).toEqual(['Boost +5M tokens today — runs again until midnight', 'Unlimited today — no cap until midnight', 'Keep stopped — resets at midnight']);
    expect(card.default).toBe('Keep stopped');
    expect(card.deadline.getTime()).toBe(new Date(2026, 9, 3, 0, 0).getTime());
    expect(svc.stopOf('crewly-orc')).toBeNull();
  });

  it('falls back to a plain notice when decision cards are not wired', async () => {
    const svc = make({ decisions: () => null });
    await svc.setCaps({ agents: { 'crewly-orc': 2 * M } });
    ledger.used['crewly-orc'] = 2.5 * M;
    await svc.evaluate();
    expect(notices.at(-1)).toBe('Orc hit its daily token cap (2M tokens) and is stopped until midnight. Messages are queued. Reply `boost orc by 2M today` or `unlimited today for orc`.');
  });

  describe('team caps', () => {
    it('stops every member when the team together hits its cap; other teams run', async () => {
      const svc = make();
      await svc.setCaps({ teams: { 'team-ce': '50M' } });
      ledger.used = { 'owen-1': 30 * M, 'nova-1': 21 * M, 'ella-1': 90 * M };
      await svc.evaluate();
      expect(svc.stopOf('owen-1')).toMatchObject({ scope: 'team', teamId: 'team-ce', teamName: 'CE', capTokens: 50 * M, usedTokens: 51 * M });
      expect(svc.stopOf('nova-1')).toMatchObject({ scope: 'team' });
      expect(svc.stopOf('ella-1')).toBeNull();
      expect(svc.stopOf('crewly-orc')).toBeNull();
      expect(decisions.asked).toHaveLength(1);
      expect(decisions.asked[0].system).toEqual({ key: 'team:team-ce', defaultIsDecline: true });
      expect(decisions.asked[0].question).toBe('Team CE hit its daily token cap (50M tokens); its members are stopped until midnight. Boost it for today?');
    });

    it('sends the team 80% notice once', async () => {
      const svc = make();
      await svc.setCaps({ teams: { 'team-ce': 50 * M } });
      ledger.used = { 'owen-1': 30 * M, 'nova-1': 11 * M };
      await svc.evaluate();
      await svc.evaluate();
      expect(notices).toEqual(['Heads-up: Team CE has used 41M tokens of the 50M tokens daily token cap today (82%). At 50M its members stop taking new turns until midnight.']);
    });

    it('a null team cap removes it', async () => {
      const svc = make();
      await svc.setCaps({ teams: { 'team-ce': 50 * M } });
      await svc.setCaps({ teams: { 'team-ce': null } });
      expect(svc.getConfig().teamCapsTokens).toEqual({});
    });
  });

  describe('boosts', () => {
    it('"+X today" on a team lifts its stop until local midnight, then it expires', async () => {
      const svc = make();
      await svc.setCaps({ teams: { 'team-ce': 50 * M } });
      ledger.used = { 'owen-1': 51 * M };
      await svc.evaluate();
      expect(svc.stopOf('owen-1')).not.toBeNull();
      const b = await svc.boost({ scope: 'team', id: 'CE', extraTokens: '20M' });
      expect(b).toMatchObject({ target: 'team:team-ce', extraTokens: 20 * M, until: new Date(2026, 9, 3, 0, 0).toISOString() });
      expect(svc.stopOf('owen-1')).toBeNull();
      expect(released).toEqual([['owen-1', 'nova-1']]);
      ledger.used = { 'owen-1': 70 * M };
      expect(svc.stopOf('owen-1')).toMatchObject({ capTokens: 70 * M });

      // A minute before midnight it is still in force; at midnight it is gone.
      now = new Date(2026, 9, 2, 23, 59);
      ledger.used = { 'owen-1': 60 * M };
      expect(svc.stopOf('owen-1')).toBeNull();
      now = new Date(2026, 9, 3, 0, 0, 1);
      expect(svc.activeBoosts()).toEqual([]);
      expect(svc.stopOf('owen-1')).toMatchObject({ capTokens: 50 * M });
    });

    it('"unlimited today" for everyone lifts every cap; it ends at midnight', async () => {
      const svc = make();
      await svc.setCaps({ defaultAgentCapTokens: 1 * M, teams: { 'team-ce': 2 * M }, totalCapTokens: 3 * M });
      ledger.used = { 'crewly-orc': 5 * M, 'owen-1': 5 * M };
      expect(svc.stopOf('crewly-orc')).not.toBeNull();
      await svc.boost({ scope: 'all', unlimited: true });
      expect(svc.stopOf('crewly-orc')).toBeNull();
      expect(svc.stopOf('owen-1')).toBeNull();
      now = new Date(2026, 9, 3, 0, 0, 1);
      expect(svc.stopOf('crewly-orc')).not.toBeNull();
    });

    it('an agent boost covers only that agent (own, team and total caps)', async () => {
      const svc = make();
      await svc.setCaps({ teams: { 'team-ce': 10 * M } });
      ledger.used = { 'owen-1': 6 * M, 'nova-1': 6 * M };
      await svc.boost({ scope: 'agent', id: 'Nova', unlimited: true });
      expect(svc.stopOf('nova-1')).toBeNull();
      expect(svc.stopOf('owen-1')).toMatchObject({ scope: 'team' });
    });

    it('validates input and honours a custom end time', async () => {
      const svc = make();
      await expect(svc.boost({ scope: 'team', id: 'nope', extraTokens: 5 })).rejects.toThrow('No team called "nope"');
      await expect(svc.boost({ scope: 'all' })).rejects.toThrow(/extraTokens/);
      await expect(svc.boost({ scope: 'all', extraTokens: '5M', until: '2020-01-01T00:00:00Z' })).rejects.toThrow(/future/);
      await expect(svc.boost({ scope: 'weird' as 'all', extraTokens: 5 })).rejects.toThrow(SpendCapError);
      const until = new Date(2026, 9, 2, 18, 0).toISOString();
      const b = await svc.boost({ scope: 'all', extraTokens: 5 * M, until });
      expect(b.until).toBe(until);
      now = new Date(2026, 9, 2, 18, 0, 1);
      expect(svc.activeBoosts()).toEqual([]);
    });

    it('a boost can be ended early', async () => {
      const svc = make();
      const b = await svc.boost({ scope: 'all', unlimited: true });
      expect(await svc.removeBoost(b.id)).toBe(true);
      expect(await svc.removeBoost(b.id)).toBe(false);
      expect(svc.activeBoosts()).toEqual([]);
    });

    it('boostForTeam: team and everyone boosts count (for the autopilot budget)', async () => {
      const svc = make();
      await svc.boost({ scope: 'team', id: 'team-ce', extraTokens: 20 * M });
      await svc.boost({ scope: 'all', extraTokens: 5 * M });
      await svc.boost({ scope: 'agent', id: 'owen-1', extraTokens: 99 * M });
      expect(svc.boostForTeam('team-ce')).toEqual({ extra: 25 * M, unlimited: false });
      expect(svc.boostForTeam('team-mk')).toEqual({ extra: 5 * M, unlimited: false });
    });
  });

  it('resets at local midnight: stop lifted, queued messages released', async () => {
    const svc = make();
    await svc.setCaps({ agents: { 'crewly-orc': 5 * M } });
    ledger.used['crewly-orc'] = 6 * M;
    await svc.evaluate();
    expect(svc.stopOf('crewly-orc')).not.toBeNull();
    released.length = 0;

    now = new Date(2026, 9, 3, 0, 0, 30);
    ledger.used = {};
    await svc.evaluate();
    expect(svc.stopOf('crewly-orc')).toBeNull();
    expect(released).toEqual([['crewly-orc']]);
    expect(store.read()!.day).toEqual({ date: '2026-10-03', warned: [], stopped: [], cards: {} });
    ledger.used['crewly-orc'] = 5 * M;
    expect(svc.stopOf('crewly-orc')).toMatchObject({ capTokens: 5 * M });
  });

  it('"Boost +X today" on the card lifts the stop and releases the queue', async () => {
    const svc = make();
    await svc.setCaps({ agents: { 'crewly-orc': 5 * M } });
    ledger.used['crewly-orc'] = 5.5 * M;
    await svc.evaluate();
    await svc.onSettled(settled('D-1', decisions.asked[0], 0));
    expect(svc.stopOf('crewly-orc')).toBeNull();
    expect(svc.activeBoosts()).toMatchObject([{ target: 'crewly-orc', extraTokens: 5 * M, by: 'card' }]);
    expect(released).toEqual([['crewly-orc']]);
    expect(decisions.replies.at(-1)).toEqual({ id: 'D-1', text: 'Done: +5M tokens for Orc until midnight. Queued messages are being delivered.' });
  });

  it('"Unlimited today" on a team card lifts the team cap', async () => {
    const svc = make();
    await svc.setCaps({ teams: { 'team-ce': 5 * M } });
    ledger.used = { 'owen-1': 6 * M };
    await svc.evaluate();
    await svc.onSettled(settled('D-1', decisions.asked[0], 1));
    expect(svc.stopOf('owen-1')).toBeNull();
    expect(decisions.replies.at(-1)?.text).toBe('Done: no cap for team CE until midnight. Queued messages are being delivered.');
  });

  it('"Keep stopped" leaves it stopped', async () => {
    const svc = make();
    await svc.setCaps({ agents: { 'crewly-orc': 5 * M } });
    ledger.used['crewly-orc'] = 5.5 * M;
    await svc.evaluate();
    await svc.onSettled(settled('D-1', decisions.asked[0], 2));
    expect(svc.stopOf('crewly-orc')).not.toBeNull();
    expect(decisions.replies.at(-1)?.text).toBe('OK, Orc stays stopped until midnight. Messages stay queued.');
  });

  it('ignores a card from an earlier day', async () => {
    const svc = make();
    await svc.setCaps({ agents: { 'crewly-orc': 5 * M } });
    ledger.used['crewly-orc'] = 5.5 * M;
    await svc.evaluate();
    now = new Date(2026, 9, 3, 9, 0);
    await svc.onSettled(settled('D-1', decisions.asked[0], 0));
    expect(svc.activeBoosts()).toEqual([]);
    expect(decisions.replies.at(-1)?.text).toBe('This card is from an earlier day; the cap has already reset at midnight.');
  });

  it('the all-agents total cap stops every agent', async () => {
    const svc = make();
    await svc.setCaps({ totalCapTokens: 10 * M });
    ledger.used = { 'crewly-orc': 6 * M, 'ella-1': 4 * M };
    await svc.evaluate();
    expect(svc.stopOf('ella-1')).toMatchObject({ scope: 'total', capTokens: 10 * M });
    expect(decisions.asked).toHaveLength(1);
    expect(decisions.asked[0].question).toBe('All agents together hit the daily token cap (10M tokens); every agent is stopped until midnight. Boost it for today?');
    await svc.boost({ scope: 'all', extraTokens: 10 * M });
    expect(svc.stopOf('ella-1')).toBeNull();
    expect(released[0].sort()).toEqual(['crewly-orc', 'ella-1', 'nova-1', 'owen-1']);
  });

  it('per-agent override beats the default; null exempts; "default" drops the override', async () => {
    const svc = make();
    await svc.setCaps({ defaultAgentCapTokens: 5 * M, agents: { 'crewly-orc': 2 * M, 'ella-1': null } });
    expect(svc.ownCapOf('crewly-orc')).toEqual({ capTokens: 2 * M, source: 'override' });
    expect(svc.ownCapOf('ella-1')).toEqual({ capTokens: null, source: 'exempt' });
    expect(svc.ownCapOf('other')).toEqual({ capTokens: 5 * M, source: 'default' });
    await svc.setCaps({ agents: { 'ella-1': 'default' } });
    expect(svc.ownCapOf('ella-1')).toEqual({ capTokens: 5 * M, source: 'default' });
  });

  it('rejects bad caps', async () => {
    const svc = make();
    await expect(svc.setCaps({ defaultAgentCapTokens: -1 })).rejects.toThrow(SpendCapError);
    await expect(svc.setCaps({ totalCapTokens: 'lots' })).rejects.toThrow(/positive number of tokens/);
  });

  it('view: agents and teams with caps, boosts, stops and a suggested default', async () => {
    const svc = make();
    await svc.setCaps({ agents: { 'crewly-orc': 1 * M }, teams: { 'team-ce': 10 * M } });
    await svc.boost({ scope: 'team', id: 'team-ce', extraTokens: 5 * M });
    ledger.used = { 'crewly-orc': 2 * M, 'owen-1': 3 * M };
    const v = await svc.view(7);
    expect(v.agents.find((a) => a.session === 'crewly-orc')).toMatchObject({ name: 'Orc', capTokens: 1 * M, capSource: 'override', stopped: true, stopReason: 'Orc hit its daily token cap (1M tokens)' });
    expect(v.agents.find((a) => a.session === 'nova-1')).toMatchObject({ todayTokens: 0, teamId: 'team-ce', stopped: false, boosted: true });
    expect(v.teams.find((t) => t.teamId === 'team-ce')).toMatchObject({ name: 'CE', todayTokens: 3 * M, baseCapTokens: 10 * M, capTokens: 15 * M, extraTokens: 5 * M, stopped: false });
    expect(v.teams.find((t) => t.teamId === 'team-ce')?.boosts).toHaveLength(1);
    expect(v.suggestedAgentCapTokens).toBe(4 * M);
    expect(v.totalCapTodayTokens).toBeNull();
  });

  it('persists caps and boosts across a restart', async () => {
    const svc = make();
    await svc.setCaps({ defaultAgentCapTokens: 3 * M });
    await svc.boost({ scope: 'all', extraTokens: M });
    const again = make();
    expect(again.getConfig().defaultAgentCapTokens).toBe(3 * M);
    expect(again.activeBoosts()).toHaveLength(1);
  });

  it('writes English only', async () => {
    const svc = make();
    await svc.setCaps({ agents: { 'crewly-orc': 5 * M }, totalCapTokens: 100 * M, teams: { 'team-ce': 5 * M } });
    ledger.used = { 'crewly-orc': 4.5 * M, 'owen-1': 4.5 * M };
    await svc.evaluate();
    ledger.used = { 'crewly-orc': 6 * M, 'owen-1': 6 * M };
    await svc.evaluate();
    await svc.onSettled(settled('D-1', decisions.asked[0], 2));
    await svc.onSettled(settled('D-2', decisions.asked[1], 0));
    const texts = [...notices, ...decisions.asked.flatMap((a) => [a.title, a.question, ...(a.body ?? []), ...(a.options as string[])]), ...decisions.replies.map((r) => r.text)];
    expect(texts.length).toBeGreaterThan(5);
    for (const t of texts) expect(t).not.toMatch(CJK);
  });
});

describe('boost helpers', () => {
  it('suggestedBoost is the cap rounded up to a whole million', () => {
    expect(suggestedBoost(5 * M)).toBe(5 * M);
    expect(suggestedBoost(2.5 * M)).toBe(3 * M);
    expect(suggestedBoost(10)).toBe(M);
  });
  it('boostOfLabel reads the option label', () => {
    expect(boostOfLabel('Boost +20M tokens today')).toBe(20 * M);
    expect(boostOfLabel('Unlimited today')).toBe('unlimited');
    expect(boostOfLabel('Keep stopped')).toBeNull();
    expect(boostOfLabel(undefined)).toBeNull();
  });
});
