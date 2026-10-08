/**
 * Tests for decision card rendering and answer parsing (specs/2026-10-01-decision-cards.md §3).
 */
import {
  answerFilesOf,
  buttonValue,
  closedReasonLabel,
  deadlineDefaultLine,
  describeAnswerFiles,
  slackTsAfter,
  waitReminderLine,
  canRemind,
  canSkip,
  isSkipWord,
  settledLine,
  skipChoice,
  choiceFromReaction,
  choiceFromText,
  defaultIsSafe,
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
  it('header, question, details, option buttons + remind + skip, context line', () => {
    const blocks = blocksOf(renderOpenCard(decision(), 'inst-1', NOW));
    expect(blocks[0]).toMatchObject({ type: 'header', text: { text: 'APP-12 · Partner outreach email' } });
    expect(blocks[1].text.text).toBe('Send the draft to the 3 partners?');
    expect(blocks[2].text.text).toContain('• *Send Monday* — after the review call');
    const actions = blocks.find((b) => b.type === 'actions')!;
    expect(actions.elements.map((e: any) => e.action_id)).toEqual(['decision:a', 'decision:b', 'decision:remind', 'decision:skip']);
    expect(actions.elements.map((e: any) => e.text.text)).toEqual(['Send Monday', 'Hold', 'Remind me tomorrow', 'Skip']);
    expect(JSON.parse(actions.elements[3].value)).toEqual({ d: 'D-7', o: 'skip', i: 'inst-1' });
    expect(JSON.parse(actions.elements[0].value)).toEqual({ d: 'D-7', o: 'a', i: 'inst-1' });
    expect(JSON.parse(actions.elements[2].value)).toEqual({ d: 'D-7', o: 'remind', i: 'inst-1' });
    expect(actions.elements[1].style).toBe('primary');
    const context = blocks[blocks.length - 1];
    expect(context.type).toBe('context');
    expect(context.elements[0].text).toBe("If no answer by tomorrow 12:00, I'll go with Hold. · D-7");
  });

  it('wait default and sensitive asks say they will not act', () => {
    const wait = blocksOf(renderOpenCard(decision({ defaultKey: 'wait' }), 'i', NOW));
    // Says what to do, never a bare "I'll keep waiting" (specs/2026-10-02-decision-card-thread-answers.md §2)
    expect(wait[wait.length - 1].elements[0].text).toBe("Tap an answer or reply in this thread — I'll hold this until you do. · D-7");
    expect(wait[wait.length - 1].elements[0].text).not.toContain('keep waiting');
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
    expect(def[def.length - 1].elements[0].text).toBe('No answer by 10:00, so I went with "Hold".');
    const named = blocksOf(renderSettledCard(decision({ status: 'defaulted', chosenKey: 'b', deadline: NOW.toISOString() }), undefined, NOW, 'Owen'));
    expect(named[named.length - 1].elements[0].text).toBe('No answer by 10:00, so Owen went with "Hold".');
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
    kind: 'runtime_terms',
    system: { key: 'antigravity-cli', defaultIsDecline: true },
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

  it('a declining system default and a held browser action default are safe; only those skip the snooze', () => {
    expect(defaultIsSafe(terms)).toBe(true);
    expect(defaultIsSafe({ kind: 'browser_action' })).toBe(true);
    expect(defaultIsSafe({ system: { key: 'x' }, kind: 'runtime_terms' })).toBe(false);
    expect(defaultIsSafe({})).toBe(false);
    expect(canRemind(terms)).toBe(false);
    expect(canRemind({ kind: 'browser_action' })).toBe(false);
    expect(canRemind({})).toBe(true);
  });

  it('settles like any card', () => {
    const settled = blocksOf(renderSettledCard({ ...terms, status: 'defaulted', chosenKey: 'c', answeredVia: 'deadline' }, undefined, NOW));
    expect(settled.at(-1)?.elements[0].text).toBe('No answer by tomorrow 12:00, so I went with "Don\'t agree".');
  });
});

describe('browser_action cards', () => {
  const browser = (extra: Partial<OwnerDecision> = {}) =>
    decision({
      kind: 'browser_action',
      sensitive: 'browser_action',
      ticket: undefined,
      question: 'Vera wants to click "Submit" on visa.careerengine.us/subscribe — it looks like submitting and can\'t be undone.',
      options: [
        { key: 'a', label: 'Let it' },
        { key: 'b', label: 'No' },
      ],
      defaultKey: 'b',
      yesKey: 'a',
      browser: { agentSession: 'ce-vera', agentName: 'Vera', pendingId: 'p1', target: 'click "Submit"', matched: 'submitting' },
      ...extra,
    });

  it('has Let it / No, no snooze, and says No is the answer at the deadline', () => {
    const blocks = blocksOf(renderOpenCard(browser(), 'inst', NOW));
    expect(blocks[0].text.text).toBe('Browser · Vera is waiting for your OK');
    const actions = blocks.find((b) => b.type === 'actions')!;
    expect(actions.elements.map((e: any) => e.text.text)).toEqual(['Let it', 'No']);
    expect(blocks.find((b) => b.type === 'context')!.elements[0].text).toContain('the answer is No');
  });

  it('yes words and ✅ mean Let it (not the default); 不行 / no mean No', () => {
    const d = browser();
    for (const w of ['批准', '可以', '好', 'yes', 'ok']) expect(choiceFromText(d, w)).toEqual({ kind: 'option', key: 'a' });
    for (const w of ['不行', '不要', 'no']) expect(choiceFromText(d, w)).toEqual({ kind: 'option', key: 'b' });
    expect(choiceFromReaction(d, 'white_check_mark')).toEqual({ kind: 'option', key: 'a' });
    expect(choiceFromReaction(d, 'x')).toEqual({ kind: 'option', key: 'b' });
  });

  it('an expired card names the agent who will ask again', () => {
    const blocks = blocksOf(renderSettledCard(browser({ status: 'expired', resolvedAt: NOW.toISOString() }), undefined, NOW));
    expect(blocks[2].elements[0].text).toBe('Expired — Vera will ask again · 10:00');
  });
});

describe('Skip (specs/2026-10-01-decision-skip.md)', () => {
  const sensitive = decision({ sensitive: 'email' });
  const terms = decision({
    kind: 'runtime_terms',
    sensitive: 'runtime_terms',
    system: { key: 'agy', defaultIsDecline: true },
    options: [
      { key: 'a', label: 'Agree' },
      { key: 'c', label: "Don't agree" },
    ],
    defaultKey: 'c',
  });
  const browser = decision({ kind: 'browser_action', sensitive: 'browser_action', options: [{ key: 'a', label: 'Let it' }, { key: 'b', label: 'No' }], defaultKey: 'b', yesKey: 'a' });

  it('the Skip button is on every card except sensitive, system and browser cards', () => {
    expect(canSkip(decision())).toBe(true);
    expect(canSkip(decision({ kind: 'reply_question' }))).toBe(true);
    for (const d of [sensitive, terms, browser]) {
      expect(canSkip(d)).toBe(false);
      const actions = blocksOf(renderOpenCard(d, 'i', NOW)).find((b) => b.type === 'actions')!;
      expect(actions.elements.some((e: any) => e.action_id === 'decision:skip')).toBe(false);
    }
  });

  it('skip means a real skip, or the safe "no" where Skip is not offered', () => {
    expect(skipChoice(decision())).toEqual({ kind: 'skip' });
    // "Hold" reads as no
    expect(skipChoice(sensitive)).toEqual({ kind: 'option', key: 'b' });
    expect(skipChoice(terms)).toEqual({ kind: 'option', key: 'c' });
    expect(skipChoice(browser)).toEqual({ kind: 'option', key: 'b' });
    // A sensitive ask with no "no" option: dropping it is the decline.
    expect(skipChoice(decision({ sensitive: 'spend', options: [{ key: 'a', label: 'Monthly' }, { key: 'b', label: 'Yearly' }], defaultKey: 'wait' }))).toEqual({ kind: 'skip' });
  });

  it('🚫 and ⏭️ reactions skip; ❌ still means the "no" option', () => {
    expect(choiceFromReaction(decision(), 'no_entry_sign')).toEqual({ kind: 'skip' });
    expect(choiceFromReaction(decision(), 'black_right_pointing_double_triangle_with_vertical_bar')).toEqual({ kind: 'skip' });
    expect(choiceFromReaction(decision(), 'next_track_button')).toEqual({ kind: 'skip' });
    expect(choiceFromReaction(decision(), 'x')).toEqual({ kind: 'option', key: 'b' });
    expect(choiceFromReaction(terms, 'no_entry_sign')).toEqual({ kind: 'option', key: 'c' });
  });

  it('thread replies "skip", 「不用了」, 「算了」, 「不管了」 skip', () => {
    for (const w of ['skip', 'Skip.', '不用了', '算了', '不管了！', 'never mind']) {
      expect(isSkipWord(w.toLowerCase())).toBe(true);
      expect(choiceFromText(decision(), w)).toEqual({ kind: 'skip' });
    }
    expect(choiceFromText(sensitive, '算了')).toEqual({ kind: 'option', key: 'b' });
    expect(isSkipWord('skip the intro and send it')).toBe(false);
    // An option literally labelled "Skip" is that option.
    const labelled = decision({ options: [{ key: 'a', label: 'Publish' }, { key: 'b', label: 'Skip' }] });
    expect(choiceFromText(labelled, 'skip')).toEqual({ kind: 'option', key: 'b' });
  });

  it('a skipped card says "⤼ <owner> skipped this · <time>" with no buttons', () => {
    const d = decision({ status: 'skipped', answeredBy: 'U1', resolvedAt: new Date(2026, 9, 1, 14, 5).toISOString() });
    const blocks = blocksOf(renderSettledCard(d, 'Steve', NOW));
    expect(blocks.some((b) => b.type === 'actions')).toBe(false);
    expect(blocks.at(-1)?.elements[0].text).toBe('⤼ Steve skipped this · 14:05');
    expect(settledLine(d, undefined, NOW)).toBe('⤼ <@U1> skipped this · 14:05');
  });
});

describe('thread answers, deadline lines and withdraw reasons (specs/2026-10-02-decision-card-thread-answers.md)', () => {
  it('a card answered in its thread reads "Answered in thread · <time>"', () => {
    const d = decision({ status: 'resolved', answeredVia: 'thread', answeredBy: 'U1', answerFiles: [{ name: 'Audio Clip.m4a', mimetype: 'audio/mp4' }], resolvedAt: new Date(2026, 9, 1, 20, 30).toISOString() });
    expect(settledLine(d, 'Steve', NOW)).toBe('✔ Answered in thread · 20:30');
  });

  it('a withdrawn card says why', () => {
    const at = new Date(2026, 9, 1, 12, 0).toISOString();
    const closed = (closedReason?: string) => settledLine(decision({ status: 'cancelled', resolvedAt: at, ...(closedReason ? { closedReason } : {}) }), undefined, NOW);
    expect(closed('already handled in this thread')).toBe('✓ Closed — already handled in this thread · 12:00');
    expect(closed('ticket done')).toBe('✓ Closed — ticket done · 12:00');
    expect(closed('superseded by D-9')).toBe('✓ Closed — replaced by D-9 · 12:00');
    expect(closed('cleared')).toBe('✓ Closed — cleared from the ticket · 12:00');
    expect(closed()).toBe('✓ Closed — no longer needed · 12:00');
    expect(closed('answered in D-7')).toBe('✓ Closed — answered in D-7 · 12:00');
    expect(closed('answered by your reply to D-7')).toBe('✓ Closed — answered by your reply to D-7 · 12:00');
    expect(closed()).not.toMatch(/^Withdrawn/);
    expect(closedReasonLabel('x'.repeat(300))).toHaveLength(120);
  });

  it('a non-wait default names who does what; a wait default is never "I\'ll keep waiting"', () => {
    const d = decision({ deadline: new Date(2026, 9, 1, 12, 0).toISOString() });
    expect(deadlineDefaultLine(d, NOW, 'Owen')).toBe('No answer by 12:00, so Owen will go with "Hold".');
    expect(deadlineDefaultLine(d, NOW)).toBe('No answer by 12:00, so I\'ll go with "Hold".');
    expect(deadlineDefaultLine(decision({ defaultKey: 'wait' }), NOW)).not.toContain('keep waiting');
  });

  it('the wait reminder carries the question and how to answer', () => {
    expect(waitReminderLine({ question: '关于在 CE 团队下加一个 codex agent 这件事——你看这样安排行不行？' }, 'U-OWNER')).toBe(
      '<@U-OWNER> Still waiting on you: 关于在 CE 团队下加一个 codex agent 这件事——你看这样安排行不行？ — tap an answer on the card above, or reply here.',
    );
    expect(waitReminderLine({ question: 'Ship it?' }, null)).toBe('Still waiting on you: Ship it? — tap an answer on the card above, or reply here.');
    expect(waitReminderLine([{ question: 'Ship it?' }, { question: 'Use the blue logo?' }], 'U1')).toBe(
      '<@U1> Still waiting on you for 2 questions in this thread:\n• Ship it?\n• Use the blue logo?\nTap an answer on each card above, or reply here.',
    );
  });

  it('Slack ts ordering is exact', () => {
    expect(slackTsAfter('1790901042.417179', '1790899545.203529')).toBe(true);
    expect(slackTsAfter('1790899545.203529', '1790899545.203529')).toBe(false);
    expect(slackTsAfter('1790899545.2', '1790899545.100000')).toBe(true);
    expect(slackTsAfter('300.1', '100.0002')).toBe(true);
    expect(slackTsAfter(undefined, '1.1')).toBe(false);
  });

  it('answer files keep name, type, link and a finished Slack transcript', () => {
    const files = answerFilesOf([
      { id: 'F1', name: 'Audio Clip.m4a', mimetype: 'audio/mp4', permalink: 'https://x.slack.com/files/F1', subtype: 'slack_audio', transcription: { status: 'complete', preview: { content: ' 不用了，Nova 就是那个 agent ' } } },
      { id: 'F2', name: 'shot.png', mimetype: 'image/png', permalink: 'https://x.slack.com/files/F2', transcription: { status: 'failed', preview: { content: 'garbage' } } },
    ]);
    expect(files).toEqual([
      { name: 'Audio Clip.m4a', mimetype: 'audio/mp4', permalink: 'https://x.slack.com/files/F1', transcript: '不用了，Nova 就是那个 agent' },
      { name: 'shot.png', mimetype: 'image/png', permalink: 'https://x.slack.com/files/F2' },
    ]);
    expect(describeAnswerFiles([files[0]])).toBe('a voice message');
    expect(describeAnswerFiles([files[1]])).toBe('an image');
    expect(describeAnswerFiles([{ name: 'plan.pdf', mimetype: 'application/pdf' }])).toBe('a file');
    expect(describeAnswerFiles(files)).toBe('2 files');
    expect(answerFilesOf(undefined)).toEqual([]);
  });
});

describe('closed cards lose their buttons (2026-10-08 card hygiene)', () => {
  it.each(['resolved', 'defaulted', 'parked', 'cancelled', 'expired', 'skipped'] as const)('a %s card has no actions block', (status) => {
    const d = decision({ status, chosenKey: status === 'resolved' || status === 'defaulted' ? 'a' : undefined, resolvedAt: new Date(2026, 9, 1, 12, 0).toISOString() });
    const blocks = blocksOf(renderSettledCard(d, 'Steve', NOW));
    expect(blocks.some((b) => b.type === 'actions')).toBe(false);
  });

  it('an expired question card reads "Closed — no longer needed"', () => {
    const d = decision({ status: 'expired', resolvedAt: new Date(2026, 9, 1, 12, 0).toISOString() });
    expect(settledLine(d, undefined, NOW)).toBe('✓ Closed — no longer needed · 12:00');
  });
});
