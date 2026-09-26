import { appendIncompleteNotice, stripNarration, type IncompleteTurn } from './incomplete-turn.utils.js';

const turn = (over: Partial<IncompleteTurn> = {}): IncompleteTurn => ({
  reason: 'abnormal-finish',
  detail: 'provider bailed',
  finishReason: 'other',
  recoveryAttempts: 1,
  ...over,
});

describe('appendIncompleteNotice', () => {
  it('leaves a healthy turn exactly as it is', () => {
    expect(appendIncompleteNotice('Team created.', undefined)).toBe('Team created.');
    expect(appendIncompleteNotice('', undefined)).toBe('');
  });

  it('keeps the real partial answer and warns, in Chinese, that the work may be unfinished', () => {
    const out = appendIncompleteNotice('团队已经建好，还差登录。', turn());
    expect(out).toContain('团队已经建好，还差登录。');
    expect(out).toContain('做到一半被打断');
    expect(out).toContain('回一句「继续」');
  });

  it('drops the thinking-aloud paragraphs of an interrupted turn (2026-09-26, Orc)', () => {
    const monologue = [
      "I'll start by checking the ticket acceptance criteria and confirming the current state before acting.",
      'I need to use the actual tool-calling mechanism. Let me check the CE team state and the codex install status.',
      'Let me see the top of the file where `targetTriple` and `platformPackage` are computed.',
      'Nova 已经建好，但 codex 起不来。',
    ].join('\n\n');
    const out = appendIncompleteNotice(monologue, turn());
    expect(out).not.toMatch(/I'll start|I need to|Let me/);
    expect(out).toContain('Nova 已经建好');
  });

  it('names the right cause for each reason', () => {
    expect(appendIncompleteNotice('x', turn({ reason: 'truncated' }))).toContain('长度上限');
    expect(appendIncompleteNotice('x', turn({ reason: 'steps-exhausted' }))).toContain('步数用完');
    expect(appendIncompleteNotice('x', turn({ reason: 'content-filter' }))).toContain('拒绝');
  });

  it('still says something when the turn produced no text at all', () => {
    const out = appendIncompleteNotice('   ', turn());
    expect(out.startsWith('_⚠️')).toBe(true);
    expect(out).toContain('被打断');
  });
});

describe('stripNarration', () => {
  it('keeps answers, drops "I will / Let me" paragraphs', () => {
    expect(stripNarration("Let me check.\n\nThe team is ready.")).toBe('The team is ready.');
    expect(stripNarration("I'll look.\n\nNow I'll read it.")).toBe('');
  });
});
