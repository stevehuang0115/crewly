import type { OwnerDecision } from '../../types/decision.types.js';
import type { SystemAskInput } from '../decisions/decision.service.js';
import { SpendCapError, SpendCapService, raiseAmountOf, suggestedRaise, type SpendCapServiceDeps } from './spend-cap.service.js';
import { MemorySpendCapStore } from './spend-cap.store.js';
import type { SpendSummary } from './spend-ledger.service.js';

/** CJK characters: the harness writes English only. */
const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿＀-￯]/;

/** Fake ledger: spend per session set directly. */
class FakeLedger {
  spend: Record<string, number> = {};
  spentToday(session: string): number {
    return this.spend[session] ?? 0;
  }
  totalToday(): number {
    return Object.values(this.spend).reduce((s, v) => s + v, 0);
  }
  invalidate(): void {}
  summarize(): SpendSummary {
    const agents = Object.entries(this.spend).map(([session, usd]) => ({ session, runtimes: ['crewly-agent'], todayUsd: usd, windowUsd: usd, daily: [usd] }));
    return { today: '2026-10-02', days: [{ date: '2026-10-02', totalUsd: this.totalToday(), byAgent: { ...this.spend }, byRuntime: {} }], agents, byRuntime: {}, totalUsd: this.totalToday(), todayUsd: this.totalToday(), p90AgentDayUsd: 3.4 };
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

/** Settle a card the way DecisionService does (option a/b from the asked labels). */
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
      displayNameOf: (s) => ({ 'crewly-orc': 'Orc', 'ella-1': 'Ella' })[s] ?? s,
      knownSessions: async () => ['crewly-orc', 'ella-1'],
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

  it('is off by default: nothing is stopped however much is spent', async () => {
    const svc = make();
    ledger.spend['crewly-orc'] = 500;
    await svc.evaluate();
    expect(svc.stopOf('crewly-orc')).toBeNull();
    expect(notices).toEqual([]);
    expect(decisions.asked).toEqual([]);
  });

  it('sends the 80% heads-up once', async () => {
    const svc = make();
    await svc.setCaps({ agents: { 'crewly-orc': 5 } });
    ledger.spend['crewly-orc'] = 4.1;
    await svc.evaluate();
    await svc.evaluate();
    ledger.spend['crewly-orc'] = 4.5;
    await svc.evaluate();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toBe('Heads-up: Orc has spent $4.10 of its $5.00 daily spend cap today (82%). At $5.00 it stops taking new turns until midnight.');
    expect(svc.stopOf('crewly-orc')).toBeNull();
  });

  it('hard-stops at 100% (live, before the tick) and posts ONE decision card', async () => {
    const svc = make();
    await svc.setCaps({ defaultAgentCapUsd: 5 });
    ledger.spend['ella-1'] = 5.01;
    const stop = svc.stopOf('ella-1');
    expect(stop).toMatchObject({ session: 'ella-1', scope: 'agent', capUsd: 5 });
    await svc.evaluate();
    await svc.evaluate();
    expect(decisions.asked).toHaveLength(1);
    const card = decisions.asked[0];
    expect(card.kind).toBe('spend_cap');
    expect(card.system).toEqual({ key: 'ella-1', defaultIsDecline: true });
    expect(card.question).toBe('Ella hit its daily spend cap ($5.00) and is stopped until midnight. Raise it for today?');
    expect(card.options).toEqual(['Raise to $10 today — runs again until midnight', 'Keep stopped — resets at midnight']);
    expect(card.default).toBe('Keep stopped');
    expect(card.sensitive).toBe('spend');
    expect(card.deadline.getTime()).toBe(new Date(2026, 9, 3, 0, 0).getTime());
    expect(svc.stopOf('crewly-orc')).toBeNull();
  });

  it('falls back to a plain notice when decision cards are not wired', async () => {
    const svc = make({ decisions: () => null });
    await svc.setCaps({ agents: { 'crewly-orc': 2 } });
    ledger.spend['crewly-orc'] = 2.5;
    await svc.evaluate();
    expect(notices.at(-1)).toBe('Orc hit its daily spend cap ($2.00) and is stopped until midnight. Its messages are queued. Reply `raise cap for orc to $4 today` to raise it.');
  });

  it('resets at local midnight: stop lifted, queued messages released, raises forgotten', async () => {
    const svc = make();
    await svc.setCaps({ agents: { 'crewly-orc': 5 } });
    ledger.spend['crewly-orc'] = 6;
    await svc.evaluate();
    expect(svc.stopOf('crewly-orc')).not.toBeNull();
    await svc.raiseToday('crewly-orc', 7);
    ledger.spend['crewly-orc'] = 7.5;
    await svc.evaluate();
    expect(svc.stopOf('crewly-orc')).not.toBeNull();
    released.length = 0;

    now = new Date(2026, 9, 3, 0, 0, 30);
    ledger.spend = {};
    await svc.evaluate();
    expect(svc.stopOf('crewly-orc')).toBeNull();
    expect(released).toEqual([['crewly-orc']]);
    expect(store.read()!.day).toEqual({ date: '2026-10-03', raised: {}, warned: [], stopped: [], cards: {} });
    // The cap itself is kept: the next day stops again at $5.
    ledger.spend['crewly-orc'] = 5;
    expect(svc.stopOf('crewly-orc')).toMatchObject({ capUsd: 5 });
  });

  it('"Raise to $Y today" on the card lifts the stop for today and releases the queue', async () => {
    const svc = make();
    await svc.setCaps({ agents: { 'crewly-orc': 5 } });
    ledger.spend['crewly-orc'] = 5.5;
    await svc.evaluate();
    const ask = decisions.asked[0];
    await svc.onSettled(settled('D-1', ask, 0));
    expect(svc.stopOf('crewly-orc')).toBeNull();
    expect(svc.capOf('crewly-orc')).toEqual({ capUsd: 10, source: 'raised' });
    expect(released).toEqual([['crewly-orc']]);
    expect(decisions.replies.at(-1)).toEqual({ id: 'D-1', text: "Raised Orc's cap to $10.00 for today. Queued messages are being delivered." });
  });

  it('"Keep stopped" leaves it stopped', async () => {
    const svc = make();
    await svc.setCaps({ agents: { 'crewly-orc': 5 } });
    ledger.spend['crewly-orc'] = 5.5;
    await svc.evaluate();
    await svc.onSettled(settled('D-1', decisions.asked[0], 1));
    expect(svc.stopOf('crewly-orc')).not.toBeNull();
    expect(decisions.replies.at(-1)?.text).toBe('OK, Orc stays stopped until midnight. Its messages stay queued.');
  });

  it('ignores a card from an earlier day', async () => {
    const svc = make();
    await svc.setCaps({ agents: { 'crewly-orc': 5 } });
    ledger.spend['crewly-orc'] = 5.5;
    await svc.evaluate();
    now = new Date(2026, 9, 3, 9, 0);
    await svc.onSettled(settled('D-1', decisions.asked[0], 0));
    expect(svc.capOf('crewly-orc')).toEqual({ capUsd: 5, source: 'override' });
    expect(decisions.replies.at(-1)?.text).toBe('This card is from an earlier day; the cap has already reset at midnight.');
  });

  it('the all-agents total cap stops every agent, and a raise of the total lifts it', async () => {
    const svc = make();
    await svc.setCaps({ totalCapUsd: 10 });
    ledger.spend = { 'crewly-orc': 6, 'ella-1': 4 };
    await svc.evaluate();
    expect(svc.stopOf('ella-1')).toMatchObject({ scope: 'total', capUsd: 10 });
    expect(svc.stopOf('crewly-orc')).toMatchObject({ scope: 'total' });
    expect(decisions.asked).toHaveLength(1);
    expect(decisions.asked[0].question).toBe('All agents together hit the daily total spend cap ($10.00); every agent is stopped until midnight. Raise it for today?');
    await svc.raiseToday('*', 20);
    expect(svc.stopOf('ella-1')).toBeNull();
    expect(released[0].sort()).toEqual(['crewly-orc', 'ella-1']);
  });

  it('per-agent override beats the default; null exempts; "default" drops the override', async () => {
    const svc = make();
    await svc.setCaps({ defaultAgentCapUsd: 5, agents: { 'crewly-orc': 2, 'ella-1': null } });
    expect(svc.capOf('crewly-orc')).toEqual({ capUsd: 2, source: 'override' });
    expect(svc.capOf('ella-1')).toEqual({ capUsd: null, source: 'exempt' });
    expect(svc.capOf('other')).toEqual({ capUsd: 5, source: 'default' });
    await svc.setCaps({ agents: { 'ella-1': 'default' } });
    expect(svc.capOf('ella-1')).toEqual({ capUsd: 5, source: 'default' });
  });

  it('rejects bad caps and raises not above today\'s spend', async () => {
    const svc = make();
    await expect(svc.setCaps({ defaultAgentCapUsd: -1 })).rejects.toThrow(SpendCapError);
    await expect(svc.setCaps({ totalCapUsd: 'lots' as unknown as number })).rejects.toThrow(/positive amount/);
    ledger.spend['crewly-orc'] = 8;
    await expect(svc.raiseToday('crewly-orc', 5)).rejects.toThrow('$5.00 is not above what Orc already spent today ($8.00); pick a higher amount');
  });

  it('a raised cap gets its own 80% notice and stop card', async () => {
    const svc = make();
    await svc.setCaps({ agents: { 'crewly-orc': 5 } });
    ledger.spend['crewly-orc'] = 5;
    await svc.evaluate();
    await svc.raiseToday('crewly-orc', 10);
    ledger.spend['crewly-orc'] = 8.5;
    await svc.evaluate();
    ledger.spend['crewly-orc'] = 10;
    await svc.evaluate();
    expect(decisions.asked).toHaveLength(2);
    expect(notices.filter((n) => n.startsWith('Heads-up'))).toHaveLength(1);
  });

  it('view: per-agent rows with caps, stops and a suggested default from the p90', async () => {
    const svc = make();
    await svc.setCaps({ agents: { 'crewly-orc': 1 } });
    ledger.spend['crewly-orc'] = 2;
    const v = await svc.view(7);
    const orc = v.agents.find((a) => a.session === 'crewly-orc')!;
    expect(orc).toMatchObject({ name: 'Orc', capUsd: 1, capSource: 'override', stopped: true, stopReason: 'Orc hit its daily spend cap ($1.00)' });
    expect(v.agents.find((a) => a.session === 'ella-1')).toMatchObject({ todayUsd: 0, capUsd: null, stopped: false });
    expect(v.suggestedAgentCapUsd).toBe(4);
    expect(v.totalCapTodayUsd).toBeNull();
  });

  it('persists caps across a restart', async () => {
    const svc = make();
    await svc.setCaps({ defaultAgentCapUsd: 3 });
    const again = make();
    expect(again.getConfig().defaultAgentCapUsd).toBe(3);
  });

  it('writes English only', async () => {
    const svc = make();
    await svc.setCaps({ agents: { 'crewly-orc': 5 }, totalCapUsd: 100 });
    ledger.spend['crewly-orc'] = 4.5;
    await svc.evaluate();
    ledger.spend['crewly-orc'] = 6;
    await svc.evaluate();
    await svc.onSettled(settled('D-1', decisions.asked[0], 1));
    const texts = [...notices, ...decisions.asked.flatMap((a) => [a.title, a.question, ...(a.body ?? []), ...(a.options as string[])]), ...decisions.replies.map((r) => r.text)];
    expect(texts.length).toBeGreaterThan(3);
    for (const t of texts) expect(t).not.toMatch(CJK);
  });
});

describe('raise helpers', () => {
  it('suggestedRaise doubles the cap, rounded up, and stays above the spend', () => {
    expect(suggestedRaise(5, 5.2)).toBe(10);
    expect(suggestedRaise(2.5, 2.6)).toBe(5);
    expect(suggestedRaise(1, 9.5)).toBe(11);
  });
  it('raiseAmountOf reads the option label', () => {
    expect(raiseAmountOf('Raise to $10 today')).toBe(10);
    expect(raiseAmountOf('Keep stopped')).toBeNull();
    expect(raiseAmountOf(undefined)).toBeNull();
  });
});
