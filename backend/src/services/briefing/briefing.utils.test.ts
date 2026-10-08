/**
 * Tests for the briefing helpers: speakable text, summaries, sensitivity,
 * ordering and "later" times.
 */

import type { BriefingItem } from './briefing.types.js';
import { clip, orderBriefing, parseLaterTime, sensitiveReason, speakable, spokenSummary, tomorrowMorning } from './briefing.utils.js';

describe('speakable', () => {
  it('drops URLs, markup, code and mentions; keeps the words', () => {
    expect(speakable('See *PR #12* <https://x.y/1|here> `npm i` and https://a.b/c :tada:')).toBe('See PR #12 here and');
    expect(speakable('## Plan\n- **ship** it\n- [docs](https://d.e)')).toBe('Plan ship it docs');
    expect(speakable('<@U123> 确认一下 ```const a = 1```')).toBe('确认一下');
  });

  it('keeps snake_case words intact', () => {
    expect(speakable('use send_back now')).toBe('use send_back now');
    expect(speakable('this is _important_.')).toBe('this is important.');
  });
});

describe('clip', () => {
  it('cuts at a boundary and marks it', () => {
    expect(clip('short', 10)).toBe('short');
    expect(clip('one two three four five six', 15)).toBe('one two three…');
  });
});

describe('spokenSummary', () => {
  it('reads a question with its options', () => {
    expect(spokenSummary('decision', 'Ella', 'Post today?', ['Yes', 'No', 'Later'])).toBe('Ella asks: Post today? Options: Yes, No or Later.');
    expect(spokenSummary('question', 'Leo', 'Include *pricing*?')).toBe('Leo asks: Include pricing?');
  });

  it('reads finished work as accept or send back', () => {
    expect(spokenSummary('review', 'Max', 'Fix the form', ['Accept'])).toBe('Max finished: Fix the form. Accept it or send it back?');
  });
});

describe('sensitiveReason', () => {
  it('a sensitive card kind wins', () => {
    expect(sensitiveReason(['anything'], 'spend')).toBe('spend');
  });

  it('finds deploy / money / delete / email words in English and Chinese', () => {
    expect(sensitiveReason(['Deploy to production now?'])).toBe('deploy');
    expect(sensitiveReason(['要不要删除旧数据？'])).toBe('删除');
    expect(sensitiveReason(['Send an email to all customers'])).toBe('send an email');
    expect(sensitiveReason(['Rename the doc'], 'runtime_terms')).toBeNull();
  });
});

describe('orderBriefing', () => {
  const item = (id: string, urgency: BriefingItem['urgency'], since: string, extra: Partial<BriefingItem> = {}): BriefingItem =>
    ({ id, urgency, since, ...extra }) as BriefingItem;

  it('urgency, then answered lookups and reminders, then oldest first', () => {
    const out = orderBriefing([
      item('low', 'low', '2026-01-01T00:00:00Z'),
      item('n-new', 'normal', '2026-01-03T00:00:00Z'),
      item('n-old', 'normal', '2026-01-02T00:00:00Z'),
      item('h', 'high', '2026-01-05T00:00:00Z'),
      item('h-rem', 'high', '2026-01-06T00:00:00Z', { reminder: true }),
      item('h-look', 'high', '2026-01-07T00:00:00Z', { lookupAnswer: { question: 'q', answer: 'a', at: 'x' } }),
    ]);
    expect(out.map((i) => i.id)).toEqual(['h-look', 'h-rem', 'h', 'n-old', 'n-new', 'low']);
  });
});

describe('later times', () => {
  const now = new Date(2026, 9, 8, 22, 30);

  it('defaults to tomorrow at 9:00 local', () => {
    const at = tomorrowMorning(now);
    expect([at.getDate(), at.getHours(), at.getMinutes()]).toEqual([9, 9, 0]);
    expect(parseLaterTime(undefined, now)?.getTime()).toBe(at.getTime());
  });

  it('accepts a future time within 30 days only', () => {
    expect(parseLaterTime(new Date(2026, 9, 9, 8).toISOString(), now)).not.toBeNull();
    expect(parseLaterTime(new Date(2026, 9, 8, 8).toISOString(), now)).toBeNull();
    expect(parseLaterTime(new Date(2026, 11, 30).toISOString(), now)).toBeNull();
    expect(parseLaterTime('soon', now)).toBeNull();
    expect(parseLaterTime({}, now)).toBeNull();
  });
});
