/**
 * Tests for the signal digest card: layout, buttons per open action, outcome
 * lines once answered, escaping, and the button value round trip.
 *
 * @module services/signal-digest/signal-digest-card.test
 */

import type { SignalDigest, SignalDigestItem } from '../../types/signal-digest.types.js';
import { digestFallbackText, escapeMrkdwn, itemOutcomeLine, parseSignalButtonValue, renderDigestCard, signalButtonValue } from './signal-digest-card.js';

const item = (n: number, extra: Partial<SignalDigestItem> = {}): SignalDigestItem => ({
  n,
  key: `k${n}`,
  source: 'gsc',
  signal: `signal ${n}`,
  proposal: `proposal ${n}`,
  expectedEffect: `effect ${n}`,
  effort: 'S',
  status: 'open',
  ...extra,
});

const digest = (items: SignalDigestItem[]): SignalDigest => ({
  id: 'SD-3',
  site: 'visa.careerengine.us',
  asker: 'tl-owen',
  items,
  createdAt: '2026-10-02T13:00:00.000Z',
  updatedAt: '2026-10-02T13:00:00.000Z',
});

type Block = { type: string; text?: { text: string }; elements?: Array<{ text?: unknown; action_id?: string; value?: string; style?: string }>; block_id?: string };

describe('renderDigestCard', () => {
  it('header, context, then per action a section and Do / Skip buttons', () => {
    const blocks = renderDigestCard(digest([item(1), item(2), item(3)]), 'inst-1', 'Owen') as unknown as Block[];
    expect(blocks[0]).toMatchObject({ type: 'header', text: { text: 'Daily signals · visa.careerengine.us' } });
    expect(blocks[1].type).toBe('context');
    expect(JSON.stringify(blocks[1])).toMatch(/Owen · .* · Do opens an experiment ticket .* · SD-3/);
    expect(blocks.filter((b) => b.type === 'section')).toHaveLength(3);
    const actions = blocks.filter((b) => b.type === 'actions');
    expect(actions).toHaveLength(3);
    const [doBtn, skipBtn] = actions[1].elements ?? [];
    expect(doBtn).toMatchObject({ action_id: 'decision:signal:2:do', style: 'primary' });
    expect(skipBtn).toMatchObject({ action_id: 'decision:signal:2:skip' });
    expect(JSON.parse(doBtn.value as string)).toEqual({ s: 'SD-3', n: 2, o: 'do', i: 'inst-1' });
    expect(blocks[2].text?.text).toBe('*1. proposal 1*\nSignal: signal 1\nExpected: effect 1 · Effort: S');
  });

  it('an answered action shows its outcome instead of buttons', () => {
    const blocks = renderDigestCard(
      digest([item(1, { status: 'do', ticketId: 'CE-12' }), item(2, { status: 'skip' }), item(3, { status: 'expired' }), item(4, { status: 'do', ticketError: 'no project' })]),
      'i',
    ) as unknown as Block[];
    expect(blocks.filter((b) => b.type === 'actions')).toHaveLength(0);
    const outcomes = blocks.filter((b, i) => i > 1 && b.type === 'context').map((b) => JSON.stringify(b.elements));
    expect(outcomes[0]).toContain('✔ Do → CE-12');
    expect(outcomes[0]).not.toContain('EXP');
    expect(outcomes[1]).toContain('⤼ Skipped');
    expect(outcomes[2]).toContain('replaced by a newer digest');
    expect(outcomes[3]).toContain('no ticket: no project');
  });

  it('a Do with an experiment card names both', () => {
    const blocks = renderDigestCard(digest([item(1, { status: 'do', ticketId: 'CE-12', experimentId: 'EXP-3' }), item(2), item(3)]), 'i');
    expect(JSON.stringify(blocks)).toContain('✔ Do → CE-12 · EXP-3');
  });

  it('escapes Slack control characters in agent text', () => {
    const blocks = renderDigestCard(digest([item(1, { proposal: 'Fix <script> & co' }), item(2), item(3)]), 'i') as unknown as Block[];
    expect(blocks[2].text?.text).toContain('Fix &lt;script&gt; &amp; co');
    expect(escapeMrkdwn('a<b>&')).toBe('a&lt;b&gt;&amp;');
  });
});

describe('button values', () => {
  it('round-trip, and reject anything that is not a digest button', () => {
    expect(parseSignalButtonValue(signalButtonValue('SD-1', 3, 'skip', 'inst'))).toEqual({ s: 'SD-1', n: 3, o: 'skip', i: 'inst' });
    expect(parseSignalButtonValue('{"d":"D-7","o":"a","i":"x"}')).toBeNull();
    expect(parseSignalButtonValue('{"s":"SD-1","n":1,"o":"maybe"}')).toBeNull();
    expect(parseSignalButtonValue('{"s":"SD-1","n":1.5,"o":"do"}')).toBeNull();
    expect(parseSignalButtonValue('{broken')).toBeNull();
    expect(parseSignalButtonValue(undefined)).toBeNull();
    expect(parseSignalButtonValue('{"s":"SD-1","n":1,"o":"do"}')).toEqual({ s: 'SD-1', n: 1, o: 'do', i: '' });
  });
});

describe('itemOutcomeLine / digestFallbackText', () => {
  it('open items have no outcome line', () => {
    expect(itemOutcomeLine(item(1))).toBeNull();
  });

  it('fallback text counts what still waits', () => {
    expect(digestFallbackText(digest([item(1), item(2), item(3)]))).toBe('Daily signals · visa.careerengine.us: 3 actions');
    expect(digestFallbackText(digest([item(1, { status: 'skip' }), item(2), item(3)]))).toBe('Daily signals · visa.careerengine.us: 3 actions (2 waiting)');
  });
});
