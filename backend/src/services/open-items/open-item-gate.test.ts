import { siblingQuestion, gateVerdict, isDeadGate } from './open-item-gate.js';
import type { RequestOpenItem } from '../../types/v2/open-item.types.js';

const base = { agent: 'a', createdAt: '2026-10-09T16:31:00Z' };
const promise = (over: Partial<RequestOpenItem> = {}): RequestOpenItem => ({ ...base, id: 'c-1', type: 'commitment', text: 'x', sourceMessageId: 'm1', status: 'waiting_owner', ...over });
const question = (over: Partial<RequestOpenItem> = {}): RequestOpenItem => ({ ...base, id: 'q-1', type: 'question', text: 'y?', sourceMessageId: 'm1', status: 'open', ...over });

describe('siblingQuestion', () => {
  it('prefers gateItemId', () => {
    expect(siblingQuestion(promise({ gateItemId: 'q-2' }), [question(), question({ id: 'q-2' })])?.id).toBe('q-2');
  });
  it('falls back to the question of the same source message', () => {
    expect(siblingQuestion(promise(), [question({ sourceMessageId: 'other', id: 'q-9' }), question()])?.id).toBe('q-1');
  });
  it('is null with no question', () => {
    expect(siblingQuestion(promise(), [])).toBeNull();
  });
});

describe('gateVerdict', () => {
  const opts = [{ key: 'a', label: 'Yes' }, { key: 'b', label: 'No' }, { key: 'c', label: 'Reply in thread' }];
  const d = (status: string, chosenKey?: string) => ({ status, chosenKey, yesKey: 'a', options: opts }) as never;
  it.each([
    ['open', undefined, 'wait'],
    ['parked', undefined, 'wait'],
    ['resolved', 'a', 'open'],
    ['defaulted', undefined, 'open'],
    ['resolved', 'b', 'declined'],
    ['resolved', 'c', 'wait'],
    ['skipped', undefined, 'skipped'],
    ['cancelled', undefined, 'declined'],
    ['expired', undefined, 'declined'],
  ])('%s/%s → %s', (status, key, verdict) => {
    expect(gateVerdict(d(status, key))).toBe(verdict);
  });
});

describe('isDeadGate', () => {
  it('true when the sibling question is closed and there is no card', () => {
    expect(isDeadGate(promise(), [promise(), question({ status: 'skipped' })])).toBe(true);
  });
  it('true with no sibling at all', () => {
    expect(isDeadGate(promise(), [promise()])).toBe(true);
  });
  it('false while the sibling question is open', () => {
    expect(isDeadGate(promise(), [promise(), question()])).toBe(false);
  });
  it('false with a gate card and no sibling (an ask-owner card)', () => {
    expect(isDeadGate(promise({ gateDecisionId: 'D-1' }), [promise({ gateDecisionId: 'D-1' })])).toBe(false);
  });
  it('true for a skipped sibling even though it had a card (TKT-374 D-541)', () => {
    expect(isDeadGate(promise({ gateDecisionId: 'D-541' }), [promise({ gateDecisionId: 'D-541' }), question({ status: 'skipped', decisionId: 'D-541' })])).toBe(true);
  });
  it('false for an answered sibling: the answer decides, not the silence', () => {
    expect(isDeadGate(promise(), [promise(), question({ status: 'resolved', decisionId: 'D-1' })])).toBe(false);
  });
  it('false for non-waiting items', () => {
    expect(isDeadGate(promise({ status: 'open' }), [])).toBe(false);
  });
});
