/**
 * Tests for the live-card filter of the on-request briefing: expired, stale,
 * answered-in-thread and duplicate cards / questions are left out.
 */

import type { OwnerDecision } from '../../types/decision.types.js';
import { conversationKey, liveCards, liveQuestionIds, ownerLastIndex, questionSimilarity } from './briefing-cards.js';

const NOW = Date.parse('2026-10-08T10:00:00.000Z');
const H = 60 * 60 * 1000;

function card(over: Partial<OwnerDecision> = {}): OwnerDecision {
  return {
    id: 'D-1',
    question: '这 10 部你看行不行？',
    options: [
      { key: 'a', label: '行' },
      { key: 'b', label: '换' },
    ],
    defaultKey: 'wait',
    deadline: new Date(NOW + 6 * H).toISOString(),
    requestedBy: 'pia',
    asker: 'pia',
    status: 'open',
    createdAt: new Date(NOW - 2 * H).toISOString(),
    updatedAt: new Date(NOW - 2 * H).toISOString(),
    ...over,
  };
}

const none = { now: NOW, conversationOf: () => null, ownerLastAt: () => 0 };

describe('liveCards', () => {
  it('keeps a fresh open card', () => {
    expect(liveCards([card()], none).live.map((d) => d.id)).toEqual(['D-1']);
  });

  it('drops settled, snoozed, expired and stale cards', () => {
    const { live, dropped } = liveCards(
      [
        card({ id: 'D-2', status: 'resolved' }),
        card({ id: 'D-3', remindAt: new Date(NOW + H).toISOString() }),
        card({ id: 'D-4', deadline: new Date(NOW - 30 * H).toISOString() }),
        card({ id: 'D-5', status: 'parked', createdAt: new Date(NOW - 8 * 24 * H).toISOString(), deadline: new Date(NOW - 7 * 24 * H).toISOString() }),
      ],
      none,
    );
    expect(live).toEqual([]);
    expect(dropped).toEqual([
      { id: 'D-2', reason: 'not_pending' },
      { id: 'D-3', reason: 'snoozed' },
      { id: 'D-4', reason: 'expired' },
      { id: 'D-5', reason: 'stale' },
    ]);
  });

  it('a card whose reminder came counts from the reminder', () => {
    const old = card({ id: 'D-6', createdAt: new Date(NOW - 9 * 24 * H).toISOString(), deadline: new Date(NOW - 8 * 24 * H).toISOString(), remindAt: new Date(NOW - H).toISOString() });
    expect(liveCards([old], none).live.map((d) => d.id)).toEqual(['D-6']);
  });

  it('drops a card the owner answered in its thread or its conversation', () => {
    const conv = conversationKey('ch', 'root');
    const { live, dropped } = liveCards([card({ id: 'D-7', ownerRepliedAt: new Date(NOW - H).toISOString() }), card({ id: 'D-8', question: 'Another thing?' })], {
      now: NOW,
      conversationOf: (d) => (d.id === 'D-8' ? conv : null),
      ownerLastAt: (k) => (k === conv ? NOW - H : 0),
    });
    expect(live).toEqual([]);
    expect(dropped.map((x) => x.reason)).toEqual(['answered', 'answered']);
  });

  it('keeps the newest of near-duplicate cards from one asker', () => {
    const { live, dropped } = liveCards(
      [card({ id: 'D-9', createdAt: new Date(NOW - 3 * H).toISOString() }), card({ id: 'D-10', question: '这10部你看行不行?' }), card({ id: 'D-11', asker: 'atlas' })],
      none,
    );
    expect(live.map((d) => d.id).sort()).toEqual(['D-10', 'D-11']);
    expect(dropped).toEqual([{ id: 'D-9', reason: 'duplicate' }]);
  });
});

describe('liveQuestionIds', () => {
  it('drops answered, stale and repeated questions', () => {
    const conv = conversationKey('dm', '');
    const keep = liveQuestionIds(
      [
        { id: 'q1', agent: 'leo', text: 'Include the pricing change?', createdAt: new Date(NOW - H).toISOString(), conversation: null },
        { id: 'q2', agent: 'leo', text: 'Include the pricing change?', createdAt: new Date(NOW - 2 * H).toISOString(), conversation: null },
        { id: 'q3', agent: 'leo', text: 'Ship it today?', createdAt: new Date(NOW - 3 * H).toISOString(), conversation: conv },
        { id: 'q4', agent: 'leo', text: 'Old one?', createdAt: new Date(NOW - 9 * 24 * H).toISOString(), conversation: null },
        { id: 'q5', agent: 'pia', text: '这 10 部你看行不行？', createdAt: new Date(NOW - H).toISOString(), conversation: null },
      ],
      [card()],
      { now: NOW, ownerLastAt: (k) => (k === conv ? NOW - 2 * H : 0) },
    );
    expect([...keep]).toEqual(['q1']);
  });
});

describe('helpers', () => {
  it('similarity ignores punctuation and markup', () => {
    expect(questionSimilarity('**Ship** it?', 'ship it')).toBe(1);
    expect(questionSimilarity('Ship it today?', 'Who is on call?')).toBeLessThan(0.3);
  });

  it('owner marks index keeps the latest per conversation', () => {
    const idx = ownerLastIndex([
      { channelId: 'a', root: '', lastAt: 1 },
      { channelId: 'a', root: '', lastAt: 5 },
    ]);
    expect(idx.get('a|')).toBe(5);
  });
});
