/**
 * Tests for decision card rendering and answer parsing (specs/2026-10-01-decision-cards.md §3).
 */
import {
  buttonValue,
  choiceFromReaction,
  choiceFromText,
  formatWhen,
  noOption,
  parseButtonValue,
  renderOpenCard,
  renderSettledCard,
  ticketThreadRootText,
} from './decision-card.js';
import type { OwnerDecision } from '../../types/decision.types.js';

const NOW = new Date(2026, 9, 1, 10, 0, 0);

function decision(extra: Partial<OwnerDecision> = {}): OwnerDecision {
  return {
    id: 'D-7',
    question: 'Send the draft to the 3 partners?',
    options: [
      { key: 'a', label: 'Send Monday', detail: 'after the review call' },
      { key: 'b', label: 'Hold', detail: 'wait for legal' },
    ],
    defaultKey: 'b',
    deadline: new Date(2026, 9, 2, 12, 0).toISOString(),
    requestedBy: 'tl-sam',
    asker: 'dev-ann',
    ticket: { projectId: 'p1', projectPath: '/p', id: 'APP-12', title: 'Partner outreach email' },
    status: 'open',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...extra,
  };
}

const blocksOf = (b: unknown) => b as Array<Record<string, any>>;

describe('renderOpenCard', () => {
  it('header, question, details, option buttons + remind, context line', () => {
    const blocks = blocksOf(renderOpenCard(decision(), 'inst-1', NOW));
    expect(blocks[0]).toMatchObject({ type: 'header', text: { text: 'APP-12 · Partner outreach email' } });
    expect(blocks[1].text.text).toBe('Send the draft to the 3 partners?');
    expect(blocks[2].text.text).toContain('• *Send Monday* — after the review call');
    const actions = blocks.find((b) => b.type === 'actions')!;
    expect(actions.elements.map((e: any) => e.action_id)).toEqual(['decision:a', 'decision:b', 'decision:remind']);
    expect(actions.elements.map((e: any) => e.text.text)).toEqual(['Send Monday', 'Hold', 'Remind me tomorrow']);
    expect(JSON.parse(actions.elements[0].value)).toEqual({ d: 'D-7', o: 'a', i: 'inst-1' });
    expect(JSON.parse(actions.elements[2].value)).toEqual({ d: 'D-7', o: 'remind', i: 'inst-1' });
    expect(actions.elements[1].style).toBe('primary');
    const context = blocks[blocks.length - 1];
    expect(context.type).toBe('context');
    expect(context.elements[0].text).toBe("If no answer by tomorrow 12:00, I'll go with Hold. · D-7");
  });

  it('wait default and sensitive asks say they will not act', () => {
    const wait = blocksOf(renderOpenCard(decision({ defaultKey: 'wait' }), 'i', NOW));
    expect(wait[wait.length - 1].elements[0].text).toContain("I'll keep waiting.");
    const sensitive = blocksOf(renderOpenCard(decision({ sensitive: 'email' }), 'i', NOW));
    expect(sensitive[sensitive.length - 1].elements[0].text).toContain("This needs your OK (email); I won't go ahead without an answer.");
    const actions = sensitive.find((b) => b.type === 'actions')!;
    expect(actions.elements.some((e: any) => e.style === 'primary')).toBe(false);
  });

  it('a non-ticket decision is headed by its id; no detail section without details', () => {
    const blocks = blocksOf(renderOpenCard(decision({ ticket: undefined, options: [{ key: 'a', label: 'Yes' }, { key: 'b', label: 'No' }], defaultKey: 'a' }), 'i', NOW));
    expect(blocks[0].text.text).toBe('Decision D-7');
    expect(blocks.filter((b) => b.type === 'section')).toHaveLength(1);
  });

  it('shows a pending reminder', () => {
    const blocks = blocksOf(renderOpenCard(decision({ remindAt: new Date(2026, 9, 2, 9, 0).toISOString() }), 'i', NOW));
    expect(blocks[blocks.length - 1].elements[0].text).toMatch(/^⏰ Reminding you tomorrow 09:00\./);
  });
});

describe('renderSettledCard', () => {
  it('"✔ <owner> chose *X* · time" with no buttons', () => {
    const d = decision({ status: 'resolved', chosenKey: 'a', answeredBy: 'U1', resolvedAt: new Date(2026, 9, 1, 14, 5).toISOString() });
    const blocks = blocksOf(renderSettledCard(d, 'Steve', NOW));
    expect(blocks.some((b) => b.type === 'actions')).toBe(false);
    expect(blocks[blocks.length - 1].elements[0].text).toBe('✔ Steve chose *Send Monday* · 14:05');
  });

  it('a free-text answer, a defaulted, a parked card', () => {
    const text = blocksOf(renderSettledCard(decision({ status: 'resolved', answerText: 'only two of them', answeredBy: 'U1', resolvedAt: NOW.toISOString() }), undefined, NOW));
    expect(text[text.length - 1].elements[0].text).toBe('✔ <@U1> answered: “only two of them” · 10:00');
    const def = blocksOf(renderSettledCard(decision({ status: 'defaulted', chosenKey: 'b', deadline: NOW.toISOString() }), undefined, NOW));
    expect(def[def.length - 1].elements[0].text).toBe('No answer by 10:00 — going with Hold.');
    const parked = blocksOf(renderSettledCard(decision({ status: 'parked' }), undefined, NOW));
    expect(parked[parked.length - 1].elements[0].text).toMatch(/^⏸ Parked/);
  });
});

describe('answers', () => {
  const d = decision();
  const yesNo = decision({ options: [{ key: 'a', label: 'Send it' }, { key: 'b', label: 'No' }], defaultKey: 'wait' });

  it('reactions: ✅ = default (else first), ❌ = a "no" option when present, ⏰ = remind', () => {
    expect(choiceFromReaction(d, 'white_check_mark')).toEqual({ kind: 'option', key: 'b' });
    expect(choiceFromReaction(yesNo, 'white_check_mark')).toEqual({ kind: 'option', key: 'a' });
    expect(choiceFromReaction(d, '+1::skin-tone-3')).toEqual({ kind: 'option', key: 'b' });
    expect(choiceFromReaction(yesNo, 'x')).toEqual({ kind: 'option', key: 'b' });
    // "Hold" reads as no
    expect(choiceFromReaction(d, 'x')).toEqual({ kind: 'option', key: 'b' });
    const noNo = decision({ options: [{ key: 'a', label: 'Monday' }, { key: 'b', label: 'Friday' }], defaultKey: 'a' });
    expect(choiceFromReaction(noNo, 'x')).toBeNull();
    expect(choiceFromReaction(d, 'alarm_clock')).toEqual({ kind: 'remind' });
    expect(choiceFromReaction(d, 'tada')).toBeNull();
  });

  it('free text: label, number, go with, yes, no, remind, anything else', () => {
    expect(choiceFromText(d, 'send monday')).toEqual({ kind: 'option', key: 'a' });
    expect(choiceFromText(d, '2')).toEqual({ kind: 'option', key: 'b' });
    expect(choiceFromText(d, 'go with Hold')).toEqual({ kind: 'option', key: 'b' });
    expect(choiceFromText(yesNo, 'yes')).toEqual({ kind: 'option', key: 'a' });
    expect(choiceFromText(d, '好的')).toEqual({ kind: 'option', key: 'b' });
    expect(choiceFromText(yesNo, 'no')).toEqual({ kind: 'option', key: 'b' });
    expect(choiceFromText(d, 'remind me tomorrow')).toEqual({ kind: 'remind' });
    expect(choiceFromText(d, '<@U9> only send to two of them')).toEqual({ kind: 'text', text: 'only send to two of them' });
    expect(choiceFromText(d, '   ')).toBeNull();
  });

  it('noOption finds Chinese "no" labels', () => {
    expect(noOption([{ key: 'a', label: '发' }, { key: 'b', label: '不要发' }])?.key).toBe('b');
  });
});

describe('helpers', () => {
  it('button value round-trips; junk is null', () => {
    expect(parseButtonValue(buttonValue('D-1', 'a', 'i1'))).toEqual({ d: 'D-1', o: 'a', i: 'i1' });
    expect(parseButtonValue('nope')).toBeNull();
    expect(parseButtonValue('{"x":1}')).toBeNull();
  });

  it('formatWhen and the thread root', () => {
    expect(formatWhen(new Date(2026, 9, 1, 14, 5), NOW)).toBe('14:05');
    expect(formatWhen(new Date(2026, 9, 3, 12, 0), NOW)).toBe('Sat Oct 3 12:00');
    expect(ticketThreadRootText({ id: 'APP-12', title: 'Partner outreach' })).toBe('*APP-12 · Partner outreach*');
  });
});

describe('system decisions (specs/2026-10-01-runtime-terms-consent.md)', () => {
  const terms = decision({
    ticket: undefined,
    title: 'Antigravity CLI · Terms of Service (mbp)',
    question: 'Antigravity CLI on mbp needs Google\'s Terms of Service accepted once. Do you agree?',
    body: ['*Links:* <https://antigravity.google/terms|Terms of Service>', '*A separate item, pre-checked on the screen:* data sharing'],
    options: [
      { key: 'a', label: 'Agree, no data sharing' },
      { key: 'b', label: 'Agree + share data' },
      { key: 'c', label: "Don't agree" },
    ],
    defaultKey: 'c',
    sensitive: 'runtime_terms',
    system: { kind: 'runtime_terms', key: 'antigravity-cli', defaultIsDecline: true },
  });

  it('uses the title, shows the body sections, offers exactly its options (no snooze)', () => {
    const blocks = blocksOf(renderOpenCard(terms, 'inst-1', NOW));
    expect(blocks[0].text.text).toBe('Antigravity CLI · Terms of Service (mbp)');
    expect(blocks[2].text.text).toContain('https://antigravity.google/terms');
    expect(blocks[3].text.text).toContain('pre-checked');
    const actions = blocks.find((b) => b.type === 'actions');
    expect(actions?.elements.map((e: any) => e.text.text)).toEqual(['Agree, no data sharing', 'Agree + share data', "Don't agree"]);
    expect(actions?.elements.some((e: any) => e.style === 'primary')).toBe(false);
    expect(blocks.at(-1)?.elements[0].text).toBe("Nothing is accepted until you answer. No answer by tomorrow 12:00: Don't agree. · D-7");
  });

  it('settles like any card', () => {
    const settled = blocksOf(renderSettledCard({ ...terms, status: 'defaulted', chosenKey: 'c', answeredVia: 'deadline' }, undefined, NOW));
    expect(settled.at(-1)?.elements[0].text).toBe("No answer by tomorrow 12:00 — going with Don't agree.");
  });
});
