/**
 * Tests for turning a reply question into a decision card
 * (specs/2026-10-01-reply-open-items.md §4).
 */
import { choiceAlternatives, deriveQuestionCard, questionSimilarity, sensitiveKindOf } from './open-item-card.js';

describe('deriveQuestionCard', () => {
  it('TKT-185: the stated fallback becomes the default ("不同意的话我就删掉")', () => {
    const card = deriveQuestionCard({
      type: 'question',
      text: '第 13 章「互评当体检用」这个读法，你同意吗？',
      fallback: '不同意的话我就删掉，只留事实。',
    });
    expect(card.derivedFrom).toBe('fallback_no');
    expect(card.options).toEqual([
      { key: 'a', label: 'Yes' },
      { key: 'b', label: 'No', detail: '删掉，只留事实' },
    ]);
    expect(card.defaultKey).toBe('b');
    // "同意" / ✅ means Yes, not the default.
    expect(card.yesKey).toBe('a');
    expect(card.sensitive).toBeUndefined();
  });

  it('a no-objection fallback defaults to yes', () => {
    const card = deriveQuestionCard({ type: 'question', text: '这个标题可以吗？', fallback: '没意见的话我就按这个发。' });
    expect(card.derivedFrom).toBe('fallback_yes');
    expect(card.options[0]).toEqual({ key: 'a', label: 'Yes', detail: '按这个发' });
    expect(card.defaultKey).toBe('a');
  });

  it('English fallback', () => {
    const card = deriveQuestionCard({ type: 'question', text: 'Do you agree with this reading?', fallback: "If not, I'll cut it and keep the facts." });
    expect(card.options[1]).toEqual({ key: 'b', label: 'No', detail: 'cut it and keep the facts' });
    expect(card.defaultKey).toBe('b');
  });

  it('either/or → the two alternatives, default wait', () => {
    const card = deriveQuestionCard({ type: 'question', text: '要现在先发文字版，还是等图好了再发？' });
    expect(card.derivedFrom).toBe('choice');
    expect(card.options.map((o) => o.label)).toEqual(['现在先发文字版', '等图好了再发']);
    expect(card.defaultKey).toBe('wait');
  });

  it('no options in the words → Yes / No / Reply in thread, default wait', () => {
    const card = deriveQuestionCard({ type: 'question', text: '要不要记进 wiki 当这章的素材？' });
    expect(card.derivedFrom).toBe('generic');
    expect(card.options.map((o) => o.label)).toEqual(['Yes', 'No', 'Reply in thread']);
    expect(card.defaultKey).toBe('wait');
  });

  it('marks the approval boundaries as sensitive', () => {
    expect(deriveQuestionCard({ type: 'question', text: 'Should I send the partner email now?' }).sensitive).toBe('email');
    expect(sensitiveKindOf('要不要部署到生产？')).toBe('deploy');
    expect(sensitiveKindOf('续费订阅可以吗？')).toBe('spend');
    expect(sensitiveKindOf('这个读法你同意吗？')).toBeUndefined();
  });
});

describe('choiceAlternatives', () => {
  it('English should-I-A-or-B', () => {
    expect(choiceAlternatives('Should I keep the appendix or drop it?')).toEqual(['keep the appendix', 'drop it']);
  });
  it('gives up when an alternative does not fit on a button', () => {
    expect(choiceAlternatives(`要${'很长'.repeat(30)}还是短的？`)).toBeNull();
  });
});

describe('questionSimilarity', () => {
  it('the same question in other words scores high', () => {
    expect(questionSimilarity('第 13 章「互评当体检用」这个读法，你同意吗？', '第13章 互评当体检用 这个读法你同意吗')).toBeGreaterThan(0.9);
  });
  it('different questions score low', () => {
    expect(questionSimilarity('第 13 章这个读法你同意吗？', '要不要部署到生产？')).toBeLessThan(0.3);
  });
});
