/**
 * Tests for the ask-owner contract (specs/2026-10-01-decision-cards.md §1).
 */
import { DecisionContractError, defaultDeadline, isYesNoOptions, readsAsEitherOr, isVagueQuestion, parseOptions, resolveDefault, validateAskOwner } from './decision-contract.js';

const NOW = new Date(2026, 9, 1, 10, 30, 0); // Oct 1 2026 10:30 local

const ok = {
  question: 'Send the partner email on Monday?',
  options: ['Send Monday — after the review call', 'Hold — wait for legal'],
  default: 'Hold',
};

function rejects(input: Record<string, unknown>, match: RegExp): void {
  expect(() => validateAskOwner(input, NOW)).toThrow(DecisionContractError);
  expect(() => validateAskOwner(input, NOW)).toThrow(match);
}

describe('validateAskOwner', () => {
  it('accepts a structured ask with the default deadline (next day 12:00 local)', () => {
    const ask = validateAskOwner(ok, NOW);
    expect(ask.question).toBe('Send the partner email on Monday?');
    expect(ask.options).toEqual([
      { key: 'a', label: 'Send Monday', detail: 'after the review call' },
      { key: 'b', label: 'Hold', detail: 'wait for legal' },
    ]);
    expect(ask.defaultKey).toBe('b');
    expect(ask.deadline).toEqual(new Date(2026, 9, 2, 12, 0, 0));
    expect(ask.sensitive).toBeUndefined();
  });

  it('defaultDeadline is tomorrow at noon even late in the evening', () => {
    expect(defaultDeadline(new Date(2026, 9, 1, 23, 59))).toEqual(new Date(2026, 9, 2, 12, 0, 0));
  });

  it('accepts object options, sensitive, ticket + project, explicit deadline', () => {
    const ask = validateAskOwner(
      { question: 'Deploy v2 to production tonight?', options: [{ label: 'Deploy', detail: 'at 22:00' }, { label: 'Wait' }, { label: 'Cancel' }], default: 'wait', deadline: '2026-10-05T09:00:00', sensitive: 'Deploy', ticket: 'APP-12', project: 'p1' },
      NOW,
    );
    expect(ask.options.map((o) => o.key)).toEqual(['a', 'b', 'c']);
    expect(ask.options[0].detail).toBe('at 22:00');
    // "wait" is also a label here → the option wins over the wait default
    expect(ask.defaultKey).toBe('b');
    expect(ask.sensitive).toBe('deploy');
    expect(ask.ticketId).toBe('APP-12');
    expect(ask.project).toBe('p1');
    expect(ask.deadline.getTime()).toBe(Date.parse('2026-10-05T09:00:00'));
  });

  it('rejects missing, too few and too many options', () => {
    rejects({ ...ok, options: undefined }, /options are required/);
    rejects({ ...ok, options: ['Yes'] }, /give 2–5 options \(got 1\)/);
    rejects({ ...ok, options: ['A1', 'B1', 'C1', 'D1', 'E1', 'F1'], default: 'A1' }, /got 6/);
  });

  it('rejects vague questions with an example', () => {
    rejects({ ...ok, question: 'thoughts?' }, /too vague.*Example: ask-owner/);
    rejects({ ...ok, question: 'What do you think?' }, /too vague/);
    rejects({ ...ok, question: '可以吗' }, /too vague/);
    rejects({ ...ok, question: 'OK?' }, /too vague/);
    expect(isVagueQuestion('Any thoughts?!')).toBe(true);
    expect(isVagueQuestion('Send the email Monday?')).toBe(false);
  });

  it('rejects a multi-line or too long question, and no question', () => {
    rejects({ ...ok, question: 'Send it?\nIt is ready since yesterday' }, /ONE line/);
    rejects({ ...ok, question: `Send ${'x'.repeat(300)}?` }, /too long/);
    rejects({ ...ok, question: '' }, /question is required/);
  });

  it('rejects an unknown or missing default', () => {
    rejects({ ...ok, default: 'Maybe' }, /not one of the options/);
    rejects({ ...ok, default: undefined }, /default is required/);
  });

  it('rejects a past or unreadable deadline', () => {
    rejects({ ...ok, deadline: '2020-01-01T00:00:00Z' }, /in the past/);
    rejects({ ...ok, deadline: 'next tuesday' }, /not a date-time/);
  });

  it('rejects a bad sensitive kind and a ticket without a project', () => {
    rejects({ ...ok, sensitive: 'legal' }, /sensitive must be one of email \| publish \| deploy \| spend/);
    rejects({ ...ok, ticket: 'APP-1' }, /--project/);
  });

  it('rejects duplicate and over-long labels', () => {
    rejects({ ...ok, options: ['Hold', 'hold'] }, /both "hold"/);
    rejects({ ...ok, options: ['x'.repeat(41), 'Hold'] }, /too long for a button/);
  });
});

describe('resolveDefault', () => {
  const options = parseOptions(['Send Monday', 'Hold', 'Cancel it']);
  it('takes a label, key, number or wait', () => {
    expect(resolveDefault('hold', options)).toBe('b');
    expect(resolveDefault('c', options)).toBe('c');
    expect(resolveDefault('1', options)).toBe('a');
    expect(resolveDefault(2, options)).toBe('b');
    expect(resolveDefault('WAIT', options)).toBe('wait');
  });
});

describe('multiple-choice cards (2–5 options)', () => {
  it('accepts five options with keys a–e', () => {
    const ask = validateAskOwner({ ...ok, options: ['A1', 'B1', 'C1', 'D1', 'E1'], default: 'wait' }, NOW);
    expect(ask.options.map((o) => o.key)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('either/or detection', () => {
  it('recognises plain yes/no option pairs only', () => {
    expect(isYesNoOptions([{ label: 'Yes' }, { label: 'No' }])).toBe(true);
    expect(isYesNoOptions([{ label: '是' }, { label: '否' }])).toBe(true);
    expect(isYesNoOptions([{ label: 'Change it now' }, { label: 'No' }])).toBe(false);
    expect(isYesNoOptions([{ label: 'Yes' }, { label: 'No' }, { label: 'Later' }])).toBe(false);
  });

  it('reads a second question starting with 还是 / 或者 / or as the other half', () => {
    expect(readsAsEitherOr('要我按这个把晚餐卡改掉吗？', '还是先按现在的版本试一周再看？')).toBe(true);
    expect(readsAsEitherOr('Change the card now?', 'Or keep the current one for a week?')).toBe(true);
    expect(readsAsEitherOr('Change the card now?', '或者先试一周？')).toBe(true);
  });

  it('reads a first question that ends in an either/or as one too', () => {
    expect(readsAsEitherOr('现在发，还是明天再发？', 'Use the short version?')).toBe(true);
    expect(readsAsEitherOr('Ship it today, or wait for review?', 'Use the short version?')).toBe(true);
  });

  it('leaves unrelated question pairs alone', () => {
    expect(readsAsEitherOr('Send the partner email on Monday?', 'Use the short version of the draft?')).toBe(false);
    expect(readsAsEitherOr('Order the box for the lab?', 'Orders go out Friday, ok?')).toBe(false);
  });
});
