import { collectResultText, detectRecurringCadence, routineNudgeAlreadySent, triggerReferencesTicket, buildRoutineNudgeBrief } from './ticket-routine-nudge.js';
import type { Trigger } from '../../types/v2/trigger.types.js';

const trig = (over: Partial<Trigger>): Trigger => ({ id: 't', type: 'time', status: 'active', action: {}, ...over }) as Trigger;

describe('detectRecurringCadence', () => {
  it.each([
    'Publish at least 1 new card per day.',
    'Check the feed every Monday morning.',
    'Run a weekly audit',
    'Do this daily',
    'Twice a week is enough',
    'every weekday, pick one item',
    'Runs on Fridays',
    '每天至少一条新卡片',
    '每周一检查一次',
    '每个工作日早上挑一条',
    '每 2 天复查',
  ])('matches %s', (text) => {
    expect(detectRecurringCadence(text)).toBeTruthy();
  });

  it.each([
    'Updated the export and fixed the header row.',
    'Everyone reviewed the dailymotion embed',
    'Fixed 3 bugs. All tests pass.',
    'The standup was fine',
    '',
  ])('does not match %s', (text) => {
    expect(detectRecurringCadence(text)).toBeNull();
  });

  it('returns only the sentence naming the cadence', () => {
    expect(detectRecurringCadence('Audit finished. Post one card each day. Owen checks facts.')).toBe('Post one card each day.');
  });

  it('caps a long sentence', () => {
    expect(detectRecurringCadence(`daily ${'x'.repeat(1000)}`)!.length).toBeLessThan(300);
  });
});

describe('collectResultText', () => {
  it('collects nested string leaves only', () => {
    expect(collectResultText({ summary: 'a', n: 3, deep: { list: ['b', { c: 'c' }] } }, undefined, 'd')).toBe('a\nb\nc\nd');
  });

  it('caps the size', () => {
    expect(collectResultText({ a: 'x'.repeat(50000) }).length).toBeLessThanOrEqual(6000);
  });
});

describe('dedupe and trigger check', () => {
  it('sees the log marker', () => {
    expect(routineNudgeAlreadySent(['x', 'crewly-routine-nudge · routine nudge sent to lead (r)'])).toBe(true);
    expect(routineNudgeAlreadySent(['claimed'])).toBe(false);
  });

  it('matches a live trigger by name or action, whole id only', () => {
    expect(triggerReferencesTicket([trig({ name: 'CE-101-routine' })], 'CE-101')).toBe(true);
    expect(triggerReferencesTicket([trig({ action: { createWorkItem: { title: 'CE-101: pick a card' } } })], 'CE-101')).toBe(true);
    expect(triggerReferencesTicket([trig({ name: 'CE-1010-routine' })], 'CE-101')).toBe(false);
    expect(triggerReferencesTicket([trig({ name: 'CE-101-routine', status: 'cancelled' })], 'CE-101')).toBe(false);
    expect(triggerReferencesTicket([], 'CE-101')).toBe(false);
  });
});

describe('buildRoutineNudgeBrief', () => {
  it('has the quote and the command shape', () => {
    const brief = buildRoutineNudgeBrief({ ticketId: 'CE-101', title: 'Feed audit', quote: 'One card per day.', lead: 'ce-lead' });
    expect(brief).toContain('> One card per day.');
    expect(brief).toContain('schedule-followup --cron');
    expect(brief).toContain('--max-fires');
    expect(brief).toContain('CE-101-routine');
  });
});
