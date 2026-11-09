/**
 * Tests for the owner-facing card wording (crewly#1367, crewly#1369 §3).
 */
import {
  cardText,
  clipQuestion,
  contextSection,
  detailsLine,
  formatWhenZh,
  isMergeAsk,
  letterCount,
  localizeOptionLabel,
  localizeOptions,
  parseDecisionContext,
  questionFitsOwnerLanguage,
  stripInternalRefs,
} from './decision-wording.js';

describe('stripInternalRefs', () => {
  it('takes ticket ids, PR numbers, GOAL: and the worktree out of the D-822 title', () => {
    const r = stripInternalRefs(
      'CREW-646 · GOAL: Decide the fate of OPEN PR #1138 (approve-then-send Gmail card + wake on reply, CREW-257), worktree crewly-projec…',
    );
    expect(r.text).toBe('Decide the fate of OPEN (approve-then-send Gmail card + wake on reply)');
    expect(r.refs).toEqual(['PR #1138']);
  });

  it('leaves nothing meaningful when the title was only references', () => {
    const r = stripInternalRefs('CREW-646 · GOAL: PR #1138, worktree crewly-projects/wt-crew257?');
    expect(letterCount(r.text)).toBe(0);
  });

  it('removes branches, paths and worktree dirs, with the preposition they leave dangling', () => {
    expect(stripInternalRefs('Merge PR #1138 on branch fix/gmail-approve into main?').text).toBe('Merge into main?');
    expect(stripInternalRefs('Should we file the H-1B update for Ann in wt-foo at /Users/x/projects/a?').text).toBe('Should we file the H-1B update for Ann?');
  });

  it('moves links to the refs', () => {
    const r = stripInternalRefs('See https://github.com/o/r/pull/12 — merge it?');
    expect(r.text).toBe('merge it?');
    expect(r.refs).toEqual(['https://github.com/o/r/pull/12']);
  });

  it('handles Chinese questions and full-width brackets', () => {
    expect(stripInternalRefs('要不要合并 PR #1138（CREW-257）？')).toEqual({ text: '要不要合并？', refs: ['PR #1138'] });
  });

  it('leaves a plain question exactly as written', () => {
    const q = 'What should we go for, blue or green?';
    expect(stripInternalRefs(q)).toEqual({ text: q, refs: [] });
    expect(stripInternalRefs('Use H-1B wording on the page?').text).toBe('Use H-1B wording on the page?');
  });
});

describe('isMergeAsk', () => {
  it('detects merge words in the question or options', () => {
    expect(isMergeAsk('Merge the Gmail approve card?', [])).toBe(true);
    expect(isMergeAsk('要不要合并这个改动？', [])).toBe(true);
    expect(isMergeAsk('Ship it?', [{ label: 'Yes, merge' }, { label: 'Not now' }])).toBe(true);
    expect(isMergeAsk('Close PR #1138?', [{ label: 'Close' }, { label: 'Keep' }])).toBe(false);
    expect(isMergeAsk('Send the email?', [{ label: 'Send' }, { label: 'Hold' }])).toBe(false);
  });
});

describe('parseDecisionContext', () => {
  it('keeps short one-line fields and drops empty ones', () => {
    expect(parseDecisionContext({ requestedBy: ' Ella,\n Oct 6 ', ownerLastSaid: '', runtimeChanges: 'Starts a poller' })).toEqual({
      requestedBy: 'Ella, Oct 6',
      runtimeChanges: 'Starts a poller',
    });
    expect(parseDecisionContext(undefined)).toBeUndefined();
    expect(parseDecisionContext({})).toBeUndefined();
  });

  it('rejects non-objects, non-text and over-long fields', () => {
    expect(() => parseDecisionContext('x')).toThrow(/must be an object/);
    expect(() => parseDecisionContext({ runtimeChanges: 3 })).toThrow(/must be text/);
    expect(() => parseDecisionContext({ runtimeChanges: 'x'.repeat(201) })).toThrow(/too long/);
  });
});

describe('owner language', () => {
  it('only a Chinese owner is checked', () => {
    expect(questionFitsOwnerLanguage('Merge it?', 'en')).toBe(true);
    expect(questionFitsOwnerLanguage('Merge it?', null)).toBe(true);
    expect(questionFitsOwnerLanguage('Merge it?', 'zh')).toBe(false);
    expect(questionFitsOwnerLanguage('要不要合并 Gmail 审批卡片？', 'zh')).toBe(true);
  });

  it('localizes generic labels and names merge outcomes', () => {
    expect(localizeOptionLabel('Yes, merge', 'zh', true)).toBe('合并');
    expect(localizeOptionLabel('Not now', 'zh', true)).toBe('先不合');
    expect(localizeOptionLabel('Not now', 'zh')).toBe('先不');
    expect(localizeOptionLabel('Yes', 'zh')).toBe('好');
    expect(localizeOptionLabel('Send Monday', 'zh')).toBe('Send Monday');
    expect(localizeOptionLabel('Yes', 'en', true)).toBe('Yes');
  });

  it('keeps labels distinct when two map to the same word', () => {
    const out = localizeOptions([{ key: 'a', label: 'Not now' }, { key: 'b', label: 'Hold' }], 'zh', true);
    expect(out.map((o) => o.label)).toEqual(['先不合', 'Hold']);
  });

  it('has Chinese harness text', () => {
    expect(cardText('zh').remindButton).toBe('明天再问');
    expect(cardText(undefined).skipButton).toBe('Skip');
    expect(formatWhenZh(new Date(2026, 9, 2, 12, 0), new Date(2026, 9, 1, 10, 0))).toBe('明天 12:00');
    expect(formatWhenZh(new Date(2026, 9, 8, 9, 5), new Date(2026, 9, 1, 10, 0))).toBe('10月8日 周四 09:05');
  });
});

describe('card sections', () => {
  it('renders context lines in the owner language', () => {
    expect(contextSection({ requestedBy: 'Ella, Oct 6', runtimeChanges: 'Starts a Gmail poller' }, 'en', true)).toBe(
      '*Asked for by*: Ella, Oct 6\n*What merging changes*: Starts a Gmail poller',
    );
    expect(contextSection({ ownerLastSaid: '「我要的是视频」' }, 'zh')).toBe('*你上次说*：“我要的是视频”');
    expect(contextSection(undefined, 'en')).toBeNull();
    expect(contextSection({ link: 'x' }, 'en')).toBeNull();
  });

  it('details line: the link, refs it does not already cover', () => {
    expect(detailsLine({ context: { link: 'https://github.com/o/r/pull/9' }, details: ['PR #9', 'PR #10'] }, 'en')).toBe(
      'Details: https://github.com/o/r/pull/9 · PR #10',
    );
    expect(detailsLine({ details: ['PR #9'] }, 'zh')).toBe('详情：PR #9');
    expect(detailsLine({}, 'en')).toBeNull();
  });

  it('clips long questions for reminders', () => {
    expect(clipQuestion('a'.repeat(100), 10)).toBe(`${'a'.repeat(9)}…`);
    expect(clipQuestion('short')).toBe('short');
  });
});
