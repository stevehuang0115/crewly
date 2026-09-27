/**
 * Tests for the #841 stop classifier.
 *
 * The fixture half runs every stop message in `__fixtures__/stop-messages.json`
 * (real scrubbed stops plus labelled synthetic ones) and reports:
 * - N examined, split real / synthetic;
 * - false RETRY on the needs-a-human set (must be 0);
 * - false CONVERSION on real delivered completions (must be 0);
 * - false ESCALATE on the give-up set (reported; a safe-direction error).
 * It refuses to pass on an empty or under-sized set.
 */

import { readFileSync } from 'fs';
import * as path from 'path';
import { classifyStop, findExclusion, type StopSource } from './stop-classifier.js';

interface Fixture {
  id: string;
  source: StopSource;
  expected: 'retry' | 'escalate' | 'none';
  category: string | null;
  synthetic: boolean;
  text: string;
}

const fixtures = (
  JSON.parse(readFileSync(path.join(__dirname, '__fixtures__', 'stop-messages.json'), 'utf8')) as { fixtures: Fixture[] }
).fixtures;

const needsHuman = fixtures.filter((f) => f.expected === 'escalate');
const giveUps = fixtures.filter((f) => f.expected === 'retry');
const delivered = fixtures.filter((f) => f.expected === 'none');

describe('stop classifier: fixture set (#841)', () => {
  it('has enough real examples to mean something', () => {
    expect(needsHuman.filter((f) => !f.synthetic).length).toBeGreaterThanOrEqual(15);
    expect(delivered.filter((f) => !f.synthetic).length).toBeGreaterThanOrEqual(10);
    expect(giveUps.length).toBeGreaterThan(0);
  });

  it('never retries a stop that needs a human, converts a delivered completion, and reports its counts', () => {
    const verdicts = fixtures.map((f) => ({ f, v: classifyStop(f.text, f.source) }));
    const falseRetry = verdicts.filter(({ f, v }) => f.expected === 'escalate' && v.decision === 'retry');
    const falseConversion = verdicts.filter(({ f, v }) => f.expected === 'none' && v.decision !== 'none');
    const falseEscalate = verdicts.filter(({ f, v }) => f.expected === 'retry' && v.decision !== 'retry');
    const wrongCategory = verdicts.filter(
      ({ f, v }) => f.expected === 'escalate' && v.decision === 'escalate' && f.category && v.category !== f.category,
    );

    const real = fixtures.filter((f) => !f.synthetic).length;
    process.stdout.write(
      `[stop-classifier] ${fixtures.length} examined (${real} real, ${fixtures.length - real} synthetic): ` +
        `needs-human ${needsHuman.length}, give-up ${giveUps.length}, delivered ${delivered.length} | ` +
        `false-retry ${falseRetry.length}, false-conversion ${falseConversion.length}, ` +
        `false-escalate ${falseEscalate.length}, other-category ${wrongCategory.length}\n`,
    );

    expect(fixtures.length).toBeGreaterThan(0);
    expect(falseRetry.map(({ f, v }) => `${f.id} -> ${v.decision}/${v.category}`)).toEqual([]);
    expect(falseConversion.map(({ f, v }) => `${f.id} -> ${v.decision}/${v.category}`)).toEqual([]);
    expect(falseEscalate.map(({ f, v }) => `${f.id} -> ${v.decision}/${v.category}`)).toEqual([]);
  });

  it.each(fixtures)('$id ($source) -> $expected', (f) => {
    expect(classifyStop(f.text, f.source).decision).toBe(f.expected);
  });
});

describe('classifyStop rules', () => {
  it('an exclusion beats a feasibility cue in the same message', () => {
    expect(classifyStop("I can't, it needs your card", 'block')).toMatchObject({ decision: 'escalate', category: 'money' });
  });

  it('feasibility alone retries; nothing recognisable escalates as unknown', () => {
    expect(classifyStop('The target cannot be reached with this method.', 'block')).toMatchObject({ decision: 'retry', category: 'feasibility' });
    expect(classifyStop('Stopped for now.', 'block')).toMatchObject({ decision: 'escalate', category: 'unknown' });
    expect(classifyStop('', 'fail')).toMatchObject({ decision: 'escalate', category: 'unknown' });
    expect(classifyStop(undefined, 'fail')).toMatchObject({ decision: 'escalate', category: 'unknown' });
  });

  it('a dependency wait is escalated, not retried', () => {
    expect(classifyStop("Can't start: waiting on #812 to merge.", 'block')).toMatchObject({ decision: 'escalate', category: 'dependency' });
  });

  describe('completions (narrowed: never turn delivered work into a failure)', () => {
    it.each([
      ["Done, PR opened; couldn't reproduce the flaky test, fixed it anyway.", 'words'],
      ["Couldn't reproduce the flake. https://github.com/o/r/pull/12", 'url'],
      ["Couldn't reach the API; used the cache instead, see a1b2c3d.", 'sha'],
      ["Couldn't verify the claim; notes in findings/2026-09-27-x.md", 'path'],
      ['无法复现，但已修复。', 'zh words'],
    ])('%s -> none (%s)', (text) => {
      expect(classifyStop(text, 'complete').decision).toBe('none');
    });

    it('a completion without any give-up cue is left alone', () => {
      expect(classifyStop('Implemented the endpoint and its tests.', 'complete')).toMatchObject({ decision: 'none' });
    });

    it('the give-up phrase itself is not read as delivery ("cannot be done")', () => {
      expect(classifyStop('This cannot be done.', 'complete')).toMatchObject({ decision: 'retry' });
      expect(classifyStop('无法完成。', 'complete')).toMatchObject({ decision: 'retry' });
      expect(classifyStop('Not done: it is impossible.', 'complete')).toMatchObject({ decision: 'retry' });
    });

    it('a give-up completion that needs a human escalates, never retries', () => {
      expect(classifyStop('Could not continue without your approval.', 'complete')).toMatchObject({ decision: 'escalate' });
    });
  });

  it('findExclusion reports each of the added categories (Sam, 2026-09-27)', () => {
    expect(findExclusion('usage limit reached')?.category).toBe('quota');
    expect(findExclusion('drop the table')?.category).toBe('destructive');
    expect(findExclusion('send an email to the customer')?.category).toBe('external_action');
    expect(findExclusion('it would expose personal data')?.category).toBe('privacy');
    expect(findExclusion('no space left on device')?.category).toBe('environment');
    expect(findExclusion('the weather is nice')).toBeNull();
  });
});
