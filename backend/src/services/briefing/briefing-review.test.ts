/**
 * Tests for the review triage: which finished tickets Drive asks the owner to
 * accept, and how the line reads (the owner asked, the team reports back).
 */

import { deliveredLine, isDiscussion, isInquiry, ownerWords, reviewSummary, triageReview } from './briefing-review.js';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const ticket = (description: string, over = {}) => ({
  kind: 'feature',
  title: `[Request] ${description}`,
  description,
  submittedAt: '2026-10-10T03:00:00.000Z',
  updatedAt: '2026-10-10T03:00:00.000Z',
  ...over,
});

describe('isInquiry', () => {
  it.each([
    '你draft到哪里了？我在zoho没看到',
    '刚才drive mode说要做的 milo你收到了吗',
    '为什么crewly 日报里要我回复X但又没有crewly相关信息？ [Slack Image: /tmp/x.png (1x1), image/png]',
    '这三个都是flopost的harness自己剪的对吧？',
    'did you get the file I sent?',
  ])('is an inquiry: %s', (text) => {
    expect(isInquiry(text)).toBe(true);
  });

  it.each(['你先试试看1:1 复刻 那个屏幕的素材可以换成生成的', 'Redo the intro with the new logo', '可以去研究一下opus做视频那个吗', '帮我把首页改成蓝色，好吗？'])('is work: %s', (text) => {
    expect(isInquiry(text)).toBe(false);
  });
});

const VOICE_NOTE = '像他们周六一早,然后就是起来以后,然后就不愿意下床,然后呢就是在那边看书啊什么的,然后一直闹,然后也不换衣服,也不刷牙,也不洗脸,也不下来吃早餐,然后怎么说都没有用。然后搞完了以后呢,说看完这本书,OK,然后现在又去那个了,又要很久,然后又搞很久都不愿意下来,然后一直把时间都浪费掉了。所以就不知道这个东西可以用什么样的方法。';

describe('isDiscussion', () => {
  it('a long voice note with no request is discussion', () => {
    expect(isDiscussion(VOICE_NOTE)).toBe(true);
  });
  it('a short ask or a long one with a request verb is not', () => {
    expect(isDiscussion('Redo the intro')).toBe(false);
    expect(isDiscussion(`${'很长的背景说明，'.repeat(30)}帮我把这个做出来`)).toBe(false);
  });
});

describe('triageReview', () => {
  it('surfaces a deliverable', () => {
    expect(triageReview(ticket('Redo the intro with the new logo'), NOW)).toEqual({ surface: true });
  });
  it('drops question tickets, inquiries, discussion and stale reviews', () => {
    expect(triageReview(ticket('anything', { kind: 'question' }), NOW)).toEqual({ surface: false, reason: 'question_ticket' });
    expect(triageReview(ticket('你收到了吗'), NOW)).toEqual({ surface: false, reason: 'inquiry' });
    expect(triageReview(ticket('Redo the intro', { submittedAt: '2026-10-05T03:00:00.000Z' }), NOW)).toEqual({ surface: false, reason: 'stale' });
  });
});

describe('phrasing', () => {
  it('strips the category tag and attachments from the owner words', () => {
    expect(ownerWords('[Deploy] why the report? [Slack Image: /a/b.png (1x1), image/png]')).toBe('why the report?');
  });

  it('delivered line takes the start of the answer without markup', () => {
    expect(deliveredLine('*v5* is ready, see <https://x.y|the link>. It is 43 seconds. Third sentence.', 60)).toBe('v5 is ready, see the link. It is 43 seconds');
    expect(deliveredLine(undefined, 60)).toBe('');
  });

  it('says the owner asked and the agent reports back, never that the team asks', () => {
    const line = reviewSummary('Pia', { title: '[Implement] redo the intro', description: 'redo the intro' }, 'v5 is ready.');
    expect(line).toBe('You asked Pia: redo the intro. Pia reports: v5 is ready. Accept it or send it back?');
    expect(reviewSummary('Pia', { title: 'x', description: '' }, undefined)).toBe('You asked Pia: x. Pia says it is done. Accept it or send it back?');
  });
});
