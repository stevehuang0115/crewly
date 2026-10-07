/**
 * Tests for turning a reply question into a decision card
 * (specs/2026-10-01-reply-open-items.md §4).
 */
import { alternativeLabel, deriveEitherOrCard, groupEitherOr, choiceAlternatives, deriveQuestionCard, questionContextBlocks, questionSimilarity, refersBack, sensitiveKindOf } from './open-item-card.js';

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

describe('question cards always say what they are about (specs/2026-10-02-decision-card-thread-answers.md §5)', () => {
  // D-52, 2026-10-02: the exact question the owner could not place.
  const D52 = '关于在 CE 团队下加一个 codex agent 这件事——你看这样安排行不行？';
  // TKT-072, 2026-10-07: a card that was only this sentence, in an old thread.
  const T72 = '要不要按这个草稿回，还是你想换个说法？';
  const LINKEDIN_ASK = 'LinkedIn 上那条自动发出去的帖子，查一下怎么回事';

  it('knows a question that points back from one that stands alone', () => {
    expect(refersBack(D52)).toBe(true);
    expect(refersBack('按上面的方案做可以吗？')).toBe(true);
    expect(refersBack('Does this plan work for you?')).toBe(true);
    expect(refersBack('Should I go with the above?')).toBe(true);
    expect(refersBack(T72)).toBe(true);
    expect(refersBack('这份清单你看一下有没有漏的？')).toBe(true);
    expect(refersBack('这条回复可以发吗？')).toBe(true);
    expect(refersBack('Can I send this reply?')).toBe(true);
    expect(refersBack('Is this email OK to send?')).toBe(true);
    expect(refersBack('第 13 章「互评当体检用」这个读法，你同意吗？')).toBe(false);
    expect(refersBack('Send the draft to the 3 partners?')).toBe(false);
  });

  it('quotes the paragraph before the question, under an About line and a chat-only note', () => {
    const content =
      '先说结论：CE 团队下加一个 codex agent，名字叫 Nova，跑 codex CLI，负责代码类工单；Owen 继续做 TL，Vera 不动。\n\n' +
      `${D52}如果 OK 我就让人去建了。`;
    expect(questionContextBlocks({ content, question: D52, ownerAsk: '可以在ce的团队下添加一个codex agent吗？', agentName: 'Orc' })).toEqual([
      '*About:* 可以在ce的团队下添加一个codex agent吗？',
      '_Orc wrote:_\n> 先说结论：CE 团队下加一个 codex agent，名字叫 Nova，跑 codex CLI，负责代码类工单；Owen 继续做 TL，Vera 不动。',
      '_Full message in Crewly chat._',
    ]);
  });

  it('TKT-072: the draft in the paragraph before the question is on the card', () => {
    const content = '给 Mia 的回复草稿：\n\n谢谢提醒，那条帖子是我们的自动化误发的，已经删掉了，以后发帖前都会先人工确认。\n\n' + T72;
    const blocks = questionContextBlocks({ content, question: T72, ownerAsk: LINKEDIN_ASK, agentName: 'Ella' });
    expect(blocks[0]).toBe(`*About:* ${LINKEDIN_ASK}`);
    expect(blocks[1]).toBe('_Ella wrote:_\n> 给 Mia 的回复草稿：\n> 谢谢提醒，那条帖子是我们的自动化误发的，已经删掉了，以后发帖前都会先人工确认。');
    expect(blocks).toHaveLength(3);
  });

  it('TKT-072: a fenced draft the question points at is quoted whole, after the words that introduce it', () => {
    const draft = 'Hi Mia — thanks for flagging. That post went out by mistake from our scheduler; it is deleted and we now review every post before it goes live.';
    const content = `Mia 在 LinkedIn 私信问那条帖子，我起草了回复：\n\n\`\`\`\n${draft}\n\`\`\`\n\n${T72}`;
    const blocks = questionContextBlocks({ content, question: T72, ownerAsk: LINKEDIN_ASK, agentName: 'Ella', messageLink: 'https://slack.com/archives/C0CONTENT/p1791000000000100' });
    expect(blocks).toEqual([
      `*About:* ${LINKEDIN_ASK}`,
      '_Ella wrote:_\n> Mia 在 LinkedIn 私信问那条帖子，我起草了回复：',
      `\`\`\`\n${draft}\n\`\`\``,
      "<https://slack.com/archives/C0CONTENT/p1791000000000100|Open Ella's full message>",
    ]);
  });

  it('a draft after the question (or in > quotes) is found too, and clipped to ~1200 characters', () => {
    const quoted = `${T72}\n\n> 谢谢提醒，那条帖子是误发的，已经删掉了。\n> 以后发帖前都会先人工确认。`;
    expect(questionContextBlocks({ content: quoted, question: T72, agentName: 'Ella' })).toEqual([
      '> 谢谢提醒，那条帖子是误发的，已经删掉了。\n> 以后发帖前都会先人工确认。',
      '_Full message in Crewly chat._',
    ]);
    const long = `${T72}\n\n\`\`\`\n${'稿'.repeat(3000)}\n\`\`\``;
    const [block] = questionContextBlocks({ content: long, question: T72, agentName: 'Ella' });
    expect(block.startsWith('```\n稿')).toBe(true);
    expect(block.length).toBeLessThanOrEqual(1200 + 8);
  });

  it('a question-only message falls back to the request title, never just the question', () => {
    expect(questionContextBlocks({ content: T72, question: T72, ownerAsk: LINKEDIN_ASK, agentName: 'Ella' })).toEqual([
      `*Context:* ${LINKEDIN_ASK} — reply in thread to ask Ella for details`,
      '_Full message in Crewly chat._',
    ]);
    expect(questionContextBlocks({ content: T72, question: T72, agentName: 'Ella' })[0]).toBe('*Context:* none in the message — reply in thread to ask Ella for details');
  });

  it('keeps about 500 characters, the part nearest the question', () => {
    const long = `${'背景'.repeat(400)}关键：Nova 负责代码工单。`;
    const [, block] = questionContextBlocks({ content: `${long}\n${D52}`, question: D52, ownerAsk: 'ask', agentName: 'Orc' });
    expect(block.startsWith('_Orc wrote:_\n> …')).toBe(true);
    expect(block.endsWith('关键：Nova 负责代码工单。')).toBe(true);
    expect(block.length).toBeLessThanOrEqual('_Orc wrote:_\n> '.length + 500);
  });

  it('a question that does not point back still carries the words before it', () => {
    const content = '三位合伙人都回了邮件，两位同意下周二开会。\n\nSend the draft to the 3 partners?';
    expect(questionContextBlocks({ content, question: 'Send the draft to the 3 partners?', agentName: 'Kai' })).toEqual([
      '_Kai wrote:_\n> 三位合伙人都回了邮件，两位同意下周二开会。',
      '_Full message in Crewly chat._',
    ]);
  });

  it('links the thread when only the thread is known, and the old ticket thread when the card moved', () => {
    const blocks = questionContextBlocks({
      content: T72,
      question: T72,
      agentName: 'Ella',
      messageLink: 'https://slack.com/archives/C1/p1',
      linkIsThread: true,
      oldThreadLink: 'https://slack.com/archives/C2/p2',
    });
    expect(blocks[blocks.length - 1]).toBe("<https://slack.com/archives/C1/p1|Open the thread with Ella's message> · <https://slack.com/archives/C2/p2|Earlier ticket thread>");
  });
});

describe('either/or questions in one reply', () => {
  const q = (text: string) => ({ type: 'question' as const, text });

  it('groups the D-249 / D-250 pair into one card with one option per alternative plus Reply in thread', () => {
    const qs = [q('要我按这个把晚餐卡改掉吗？'), q('还是先按现在的版本试一周再看？')];
    const groups = groupEitherOr(qs);
    expect(groups).toHaveLength(1);
    const card = deriveEitherOrCard(groups[0]);
    expect(card.options.map((o) => o.label)).toEqual(['按这个把晚餐卡改掉', '先按现在的版本试一周再看', 'Reply in thread']);
    expect(card.options[0].question).toBe('要我按这个把晚餐卡改掉吗？');
    expect(card.options[1].question).toBe('还是先按现在的版本试一周再看？');
    expect(card.defaultKey).toBe('wait');
  });

  it('groups an English pair', () => {
    const groups = groupEitherOr([q('Should I ship it today?'), q('Or wait for the review?')]);
    expect(groups).toHaveLength(1);
    expect(deriveEitherOrCard(groups[0]).options.map((o) => o.label)).toEqual(['ship it today', 'wait for the review', 'Reply in thread']);
  });

  it('keeps unrelated questions apart (today\'s behaviour)', () => {
    expect(groupEitherOr([q('Send the draft on Monday?'), q('Use the short version?')])).toHaveLength(2);
  });

  it('strips lead words and clips labels to 40 characters', () => {
    expect(alternativeLabel('还是先等一等？')).toBe('先等一等');
    expect(alternativeLabel(`Or ${'x'.repeat(60)}?`).length).toBeLessThanOrEqual(40);
  });
});
