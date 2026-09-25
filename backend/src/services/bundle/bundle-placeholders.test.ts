/**
 * Tests for bundle placeholders and answers: listing, filling (a missing
 * value is a clear error), and resolving the owner's answers against the
 * questions (required, defaults, selects, multiselects, length).
 */

import type { BundleQuestion } from '../../types/solution-bundle.types.js';
import {
  BundleAnswersError,
  BundlePlaceholderError,
  answerText,
  fillPlaceholders,
  listPlaceholders,
  resolveAnswers,
} from './bundle-placeholders.js';

const QUESTIONS: BundleQuestion[] = [
  { id: 'business_name', label: '公司叫什么？', type: 'text', required: true },
  { id: 'what_you_sell', label: '你卖什么？', type: 'textarea', required: true },
  {
    id: 'platforms',
    label: '平台',
    type: 'multiselect',
    required: true,
    options: [{ value: '小红书' }, { value: '抖音' }, { value: 'X' }],
  },
  {
    id: 'tone',
    label: '语气',
    type: 'select',
    required: false,
    default: '亲切自然',
    options: [{ value: '亲切自然' }, { value: '专业可信' }],
  },
  { id: 'owner_title', label: '称呼', type: 'text', required: false, default: '老板' },
];

describe('listPlaceholders', () => {
  it('lists each placeholder once, in order, tolerating spaces inside the braces', () => {
    expect(listPlaceholders('给 {{business_name}} 写 {{ platforms }}，{{business_name}} 加油')).toEqual(['business_name', 'platforms']);
  });

  it('ignores text without placeholders and malformed ones', () => {
    expect(listPlaceholders(undefined)).toEqual([]);
    expect(listPlaceholders('{{Bad-Name}} {single} {{1x}}')).toEqual([]);
  });
});

describe('fillPlaceholders', () => {
  it('replaces every placeholder, joining multiselect values with 、', () => {
    const out = fillPlaceholders('{{business_name}} 在 {{platforms}} 发', { business_name: '小周咖啡', platforms: ['小红书', '抖音'] }, 'test');
    expect(out).toBe('小周咖啡 在 小红书、抖音 发');
  });

  it('throws a clear error naming the missing placeholder and where it is', () => {
    expect(() => fillPlaceholders('你好 {{business_name}} {{owner_title}}', { business_name: 'x' }, 'norm brand-voice')).toThrow(
      BundlePlaceholderError,
    );
    try {
      fillPlaceholders('你好 {{owner_title}}', {}, 'norm brand-voice');
    } catch (error) {
      expect((error as BundlePlaceholderError).names).toEqual(['owner_title']);
      expect((error as Error).message).toContain('{{owner_title}}');
      expect((error as Error).message).toContain('norm brand-voice');
    }
  });

  it('accepts an empty string as a value', () => {
    expect(fillPlaceholders('[{{x}}]', { x: '' }, 't')).toBe('[]');
  });
});

describe('answerText', () => {
  it('returns strings as they are and joins lists', () => {
    expect(answerText('a')).toBe('a');
    expect(answerText(['a', 'b'])).toBe('a、b');
  });
});

describe('resolveAnswers', () => {
  const complete = { business_name: ' 小周咖啡 ', what_you_sell: '咖啡', platforms: ['小红书'] };

  it('trims answers and applies defaults to optional questions', () => {
    expect(resolveAnswers(QUESTIONS, complete)).toEqual({
      business_name: '小周咖啡',
      what_you_sell: '咖啡',
      platforms: ['小红书'],
      tone: '亲切自然',
      owner_title: '老板',
    });
  });

  it('reports every missing required answer at once, with labels', () => {
    let caught: BundleAnswersError | null = null;
    try {
      resolveAnswers(QUESTIONS, { business_name: '   ' });
    } catch (error) {
      caught = error as BundleAnswersError;
    }
    expect(caught).toBeInstanceOf(BundleAnswersError);
    expect(caught!.code).toBe('invalid_answers');
    expect(caught!.missing.map((m) => m.id)).toEqual(['business_name', 'what_you_sell', 'platforms']);
    expect(caught!.message).toContain('公司叫什么？（business_name）');
  });

  it('rejects a select value that is not an option', () => {
    expect(() => resolveAnswers(QUESTIONS, { ...complete, tone: '暴躁' })).toThrow(/只能选/);
  });

  it('accepts a single value for a multiselect and rejects unknown options', () => {
    expect(resolveAnswers(QUESTIONS, { ...complete, platforms: '抖音' }).platforms).toEqual(['抖音']);
    expect(() => resolveAnswers(QUESTIONS, { ...complete, platforms: ['抖音', 'MySpace'] })).toThrow(/MySpace/);
  });

  it('caps the length of text answers', () => {
    expect(() => resolveAnswers(QUESTIONS, { ...complete, what_you_sell: 'x'.repeat(5000) })).toThrow(/太长/);
  });

  it('treats non-object input as no answers, and ignores unknown keys', () => {
    expect(() => resolveAnswers(QUESTIONS, null)).toThrow(BundleAnswersError);
    expect(resolveAnswers(QUESTIONS, { ...complete, extra: 'x' })).not.toHaveProperty('extra');
  });

  it('turns numbers and booleans into text', () => {
    expect(resolveAnswers([{ id: 'n', label: 'n', type: 'text', required: true }], { n: 3 })).toEqual({ n: '3' });
  });
});
