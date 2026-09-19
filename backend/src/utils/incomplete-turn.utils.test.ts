import { appendIncompleteNotice, type IncompleteTurn } from './incomplete-turn.utils.js';

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

  it('keeps the partial text and warns that the work may be unfinished', () => {
    const out = appendIncompleteNotice("I'll create the team", turn());
    expect(out).toContain("I'll create the team");
    expect(out).toContain('my turn was interrupted');
    expect(out).toContain('Ask me to continue');
  });

  it('names the right cause for each reason', () => {
    expect(appendIncompleteNotice('x', turn({ reason: 'truncated' }))).toContain('length limit');
    expect(appendIncompleteNotice('x', turn({ reason: 'steps-exhausted' }))).toContain('ran out of steps');
    expect(appendIncompleteNotice('x', turn({ reason: 'content-filter' }))).toContain('refused');
  });

  it('still says something when the turn produced no text at all', () => {
    const out = appendIncompleteNotice('   ', turn());
    expect(out.startsWith('_⚠️')).toBe(true);
    expect(out).toContain('my turn was interrupted');
  });
});
