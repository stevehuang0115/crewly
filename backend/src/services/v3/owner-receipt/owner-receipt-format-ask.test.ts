/**
 * Tests for the one-time receipt format ask (#856 follow-up): when it asks,
 * what the card holds, and what each answer does — only "Turn on nightly"
 * turns the receipt on.
 *
 * @module services/v3/owner-receipt/owner-receipt-format-ask.test
 */

import type { ComponentLogger } from '../../core/logger.service.js';
import type { OwnerDecision } from '../../../types/decision.types.js';
import type { SystemAskInput } from '../../decisions/decision.service.js';
import { OwnerReceiptFormatAsk, formatAskBody, type FormatAskDecisions } from './owner-receipt-format-ask.js';
import { OwnerReceiptService } from './owner-receipt.service.js';
import { parseOptions, resolveDefault } from '../../decisions/decision-contract.js';

jest.mock('../../core/logger.service.js', () => ({
  LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }) }) },
}));

const logger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as unknown as ComponentLogger;
const SAMPLE = '*Crewly receipt · Sat 10/3*\n*Done today*\n• Think Tank: a daily 8 am question is set up';

/** 21:30 New York (the default receipt time is 21:00). */
const AFTER = new Date('2026-10-04T01:30:00Z');
/** 20:30 New York. */
const BEFORE = new Date('2026-10-04T00:30:00Z');

interface Harness {
  ask: OwnerReceiptFormatAsk;
  receipt: OwnerReceiptService;
  asked: SystemAskInput[];
  store: Map<string, OwnerDecision>;
  generate: jest.SpyInstance;
  setNow: (d: Date) => void;
}

async function harness(opts: { enabled?: boolean; sample?: string; decisionsOff?: boolean } = {}): Promise<Harness> {
  let now = AFTER;
  const receipt = new OwnerReceiptService({
    listRequests: async () => [],
    listWorkItems: async () => [],
    loadTeamIndex: async () => new Map(),
    statePath: null,
    now: () => now,
  });
  await receipt.updateSettings({ enabled: opts.enabled ?? false });
  const generate = jest.spyOn(receipt, 'generate').mockResolvedValue({ data: {} as never, text: opts.sample ?? SAMPLE });
  const asked: SystemAskInput[] = [];
  const store = new Map<string, OwnerDecision>();
  const decisions: FormatAskDecisions = {
    askSystem: async (input) => {
      asked.push(input);
      const id = `D-${asked.length}`;
      const d = {
        id,
        kind: input.kind,
        question: input.question,
        options: [
          { key: 'a', label: 'Turn on nightly', detail: 'this format' },
          { key: 'b', label: 'Keep per-ask format', detail: 'every ask, one line each' },
        ],
        defaultKey: 'b',
        status: 'open',
        card: { slackChannelId: 'D_OWNER', messageTs: '1.0', postedBy: 'crewly-orc', ownBot: true },
      } as unknown as OwnerDecision;
      store.set(id, d);
      return d;
    },
    get: async (id) => store.get(id) ?? null,
  };
  const ask = new OwnerReceiptFormatAsk({ receipt, decisions: () => (opts.decisionsOff ? null : decisions), logger, now: () => now });
  return { ask, receipt, asked, store, generate, setNow: (d) => (now = d) };
}

const settle = (h: Harness, id: string, patch: Partial<OwnerDecision>): OwnerDecision => {
  const d = { ...(h.store.get(id) as OwnerDecision), ...patch };
  h.store.set(id, d);
  return d;
};

describe('when it asks', () => {
  it('asks once at the receipt time while the receipt is off, with a real 24 h sample', async () => {
    const h = await harness();
    h.setNow(BEFORE);
    expect(await h.ask.tick()).toBeNull();
    h.setNow(AFTER);
    expect(await h.ask.tick()).toBe('D-1');
    expect(h.generate).toHaveBeenCalledWith({ from: new Date(AFTER.getTime() - 24 * 3600 * 1000).toISOString(), to: AFTER.toISOString() });
    expect(h.asked[0]).toMatchObject({
      kind: 'owner_receipt_format',
      system: { key: 'nightly-format', defaultIsDecline: true },
      title: 'Nightly receipt · try this format?',
      options: ['Turn on nightly — this format', 'Keep per-ask format — every ask, one line each'],
      default: 'Keep per-ask format',
    });
    expect(h.asked[0].body?.[0]).toBe('> *Crewly receipt · Sat 10/3*\n> *Done today*\n> • Think Tank: a daily 8 am question is set up');
    expect(h.asked[0].deadline.getTime() - AFTER.getTime()).toBe(3 * 24 * 3600 * 1000);
    expect((await h.receipt.getState()).formatAsk).toEqual({ decisionId: 'D-1', askedAt: AFTER.toISOString() });
    // While the card is open: no second card.
    expect(await h.ask.tick()).toBeNull();
    expect(h.asked).toHaveLength(1);
  });

  it('never asks while the receipt is on, or before decisions are running', async () => {
    const on = await harness({ enabled: true });
    expect(await on.ask.tick()).toBeNull();
    const off = await harness({ decisionsOff: true });
    expect(await off.ask.tick()).toBeNull();
    expect(on.asked).toHaveLength(0);
  });

  it('a blank sample (nothing to say) asks nothing and waits for the next day', async () => {
    const h = await harness({ sample: '' });
    expect(await h.ask.tick()).toBeNull();
    expect(await h.ask.tick()).toBeNull();
    expect(h.generate).toHaveBeenCalledTimes(1);
    h.generate.mockResolvedValue({ data: {} as never, text: SAMPLE });
    h.setNow(new Date(AFTER.getTime() + 24 * 3600 * 1000));
    expect(await h.ask.tick()).toBe('D-1');
  });
});

describe('the answer', () => {
  it('"Turn on nightly" turns the receipt on and records it; never asked again', async () => {
    const h = await harness();
    await h.ask.tick();
    await h.ask.onSettled(settle(h, 'D-1', { status: 'resolved', chosenKey: 'a' }));
    const state = await h.receipt.getState();
    expect(state.settings.enabled).toBe(true);
    expect(state.formatAsk).toMatchObject({ decisionId: 'D-1', answer: 'nightly', answeredAt: AFTER.toISOString() });
    await h.receipt.updateSettings({ enabled: false });
    expect(await h.ask.tick()).toBeNull();
  });

  it('"Keep per-ask format" leaves it off and records per_ask', async () => {
    const h = await harness();
    await h.ask.tick();
    await h.ask.onSettled(settle(h, 'D-1', { status: 'resolved', chosenKey: 'b' }));
    const state = await h.receipt.getState();
    expect(state.settings.enabled).toBe(false);
    expect(state.formatAsk?.answer).toBe('per_ask');
    expect(await h.ask.tick()).toBeNull();
  });

  it('no answer by the deadline leaves it off (no_answer) and does not ask again', async () => {
    const h = await harness();
    await h.ask.tick();
    await h.ask.onSettled(settle(h, 'D-1', { status: 'defaulted', chosenKey: 'b' }));
    expect((await h.receipt.getState()).formatAsk?.answer).toBe('no_answer');
    expect((await h.receipt.getState()).settings.enabled).toBe(false);
    expect(await h.ask.tick()).toBeNull();
  });

  it('a withdrawn or expired card may be asked again', async () => {
    const h = await harness();
    await h.ask.tick();
    await h.ask.onSettled(settle(h, 'D-1', { status: 'cancelled' }));
    expect((await h.receipt.getState()).formatAsk).toBeUndefined();
    expect(await h.ask.tick()).toBe('D-2');
  });

  it('catches up on an answer given while nobody listened (restart)', async () => {
    const h = await harness();
    await h.ask.tick();
    settle(h, 'D-1', { status: 'resolved', chosenKey: 'a' });
    expect(await h.ask.tick()).toBeNull();
    expect((await h.receipt.getState()).settings.enabled).toBe(true);
    expect(h.asked).toHaveLength(1);
  });

  it('ignores other kinds and decisions that are not the recorded one', async () => {
    const h = await harness();
    await h.ask.tick();
    await h.ask.onSettled({ ...(h.store.get('D-1') as OwnerDecision), id: 'D-9', status: 'resolved', chosenKey: 'a' });
    await h.ask.onSettled({ ...(h.store.get('D-1') as OwnerDecision), kind: 'spend_cap', status: 'resolved', chosenKey: 'a' });
    expect((await h.receipt.getState()).settings.enabled).toBe(false);
    expect((await h.receipt.getState()).formatAsk?.answer).toBeUndefined();
  });

  it('a lost decision record is cleared and asked again', async () => {
    const h = await harness();
    await h.ask.tick();
    h.store.clear();
    expect(await h.ask.tick()).toBe('D-2');
  });
});

describe('the real decision contract', () => {
  it('accepts the options and default, with the labels the answer handler reads', async () => {
    const h = await harness();
    await h.ask.tick();
    const options = parseOptions(h.asked[0].options);
    expect(options.map((o) => o.label)).toEqual(['Turn on nightly', 'Keep per-ask format']);
    expect(resolveDefault(h.asked[0].default, options)).toBe('b');
  });
});

describe('formatAskBody', () => {
  it('quotes every line of the sample and says nothing turns on by itself', () => {
    const [quoted, help] = formatAskBody('a\nb');
    expect(quoted).toBe('> a\n> b');
    expect(help).toContain('*Turn on nightly* sends this every night');
    expect(help).toContain('*Keep per-ask format* leaves it off');
    expect(help).toContain('Nothing is turned on unless you choose it.');
  });
});
