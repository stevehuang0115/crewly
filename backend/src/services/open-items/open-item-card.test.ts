/**
 * Tests for turning a reply question into a decision card
 * (specs/2026-10-01-reply-open-items.md §4).
 */
import { choiceAlternatives, deriveQuestionCard, questionContextBlocks, questionSimilarity, refersBack, sensitiveKindOf } from './open-item-card.js';

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

describe('context for questions that point back (specs/2026-10-02-decision-card-thread-answers.md §5)', () => {
  // D-52, 2026-10-02: the exact question the owner could not place.
  const D52 = '关于在 CE 团队下加一个 codex agent 这件事——你看这样安排行不行？';

  it('knows a question that points back from one that stands alone', () => {
    expect(refersBack(D52)).toBe(true);
    expect(refersBack('按上面的方案做可以吗？')).toBe(true);
    expect(refersBack('Does this plan work for you?')).toBe(true);
    expect(refersBack('Should I go with the above?')).toBe(true);
    expect(refersBack('第 13 章「互评当体检用」这个读法，你同意吗？')).toBe(false);
    expect(refersBack('Send the draft to the 3 partners?')).toBe(false);
  });

  it('quotes the paragraph before the question in the same message', () => {
    const content =
      '先说结论：CE 团队下加一个 codex agent，名字叫 Nova，跑 codex CLI，负责代码类工单；Owen 继续做 TL，Vera 不动。\n\n' +
      `${D52}如果 OK 我就让人去建了。`;
    expect(questionContextBlocks({ content, question: D52, ownerAsk: '可以在ce的团队下添加一个codex agent吗？' })).toEqual([
      '> 先说结论：CE 团队下加一个 codex agent，名字叫 Nova，跑 codex CLI，负责代码类工单；Owen 继续做 TL，Vera 不动。',
    ]);
  });

  it('when the question is the whole message, shows the owner\'s original ask instead', () => {
    const content = `${D52}如果 OK 我就让人去建了。`;
    expect(questionContextBlocks({ content, question: D52, ownerAsk: '可以在ce的团队下添加一个codex agent吗？' })).toEqual([
      '_Earlier in this thread:_\n> 可以在ce的团队下添加一个codex agent吗？',
    ]);
    expect(questionContextBlocks({ content, question: D52 })).toBeUndefined();
  });

  it('keeps about 300 characters, the part nearest the question', () => {
    const long = `${'背景'.repeat(200)}关键：Nova 负责代码工单。`;
    const [block] = questionContextBlocks({ content: `${long}\n${D52}`, question: D52 })!;
    expect(block.startsWith('> …')).toBe(true);
    expect(block.endsWith('关键：Nova 负责代码工单。')).toBe(true);
    expect(block.length).toBeLessThanOrEqual(2 + 300);
  });

  it('a question that stands on its own gets no context block', () => {
    expect(questionContextBlocks({ content: '背景一段。\n\nSend the draft to the 3 partners?', question: 'Send the draft to the 3 partners?' })).toBeUndefined();
  });
});
