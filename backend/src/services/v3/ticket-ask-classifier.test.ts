/**
 * Tests for the ticket ask classifier (#827).
 *
 * The examples are the owner's own words from Slack threads of 2026-09-20..26
 * (fixtures in ticket-ask-classifier.fixtures.json, see its `_about`). Two
 * kinds of test:
 * - named real positives and negatives, readable one by one;
 * - the whole labelled set, scored as counts per set with ceilings, so a rule
 *   change that trades one mistake for three shows up as a number.
 */

import * as fs from 'fs';
import * as path from 'path';
import { askText, classifyOwnerMessage, weightedTextLength, type AskVerdict } from './ticket-ask-classifier.js';

/** One labelled example. */
interface Example {
  id: string;
  inThread: boolean;
  label: AskVerdict;
  text: string;
}

const FIXTURES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'ticket-ask-classifier.fixtures.json'), 'utf8'),
) as { sets: Record<'tuned' | 'holdout' | 'final', Example[]> };

/** In a thread a `question` verdict also opens its own ticket, so it counts as an ask. */
const opensTicket = (v: AskVerdict): boolean => v === 'new_ask' || v === 'question';

describe('classifyOwnerMessage — real new asks in a ticket thread (2026-09-25/26)', () => {
  it.each([
    ['这个可以发到crewly博客上'],
    ['那个other turing tests是什么\n可以给我看看文章并告诉我吗'],
    ['可以看看有什么值得进wiki值得深挖的吗？\n我们的wiki目前应该有industry相关的vault吧\n都有什么focus吗？\n\n那个plan mode已死什么意思'],
    ['那个X的动向能不能按theme帮我group'],
    ['可以去研究一下opus做视频那个吗\n可以怎么加到flopost里'],
    ['Chit 那个概念挺好的 我们crewly也可以进行总结看看今天做的requesta进行汇总'],
    ['<@U0C2ZK849ND> 可以开issues发给Sam'],
    ['有什么值得crewly学习的吗'],
    ['挺好的\n这个配图的设计可以做成skill吗 以后都能记住这样的风格'],
    ['可以在ce的团队下添加一个codex agent吗？'],
    ['帮我搜搜看这个 找到访谈并下载下来summarize'],
    ['Create the detail to GitHub issues. Do nothing now'],
    ['763是什么'],
  ])('%s → its own ticket', (text) => {
    const c = classifyOwnerMessage(text, { inThread: true });
    expect({ text, opens: opensTicket(c.verdict) }).toEqual({ text, opens: true });
  });
});

describe('classifyOwnerMessage — real follow-ups and acks stay on the ticket', () => {
  it.each([
    ['好的 开issue可以的'], // approves the agent's proposal
    ['<@U0C30GRCPT4> hingsight那个要写到一起吗？\n我只是想着和orca对比而已\n除非你觉得有必要'], // clarification
    ['[Slack File: /path/file (Audio Clip.m4a, audio/mp4, 119KB)]'], // a voice clip
    ['1. 也可以 合并吧\n2. 好的 先试试看'], // numbered answers
    ['没关系'],
    ['存'],
    ['wiki就按你说的来'],
    ['把这些潜在的改善内容存到md文档'], // delivery format of the current work
    ['把方案通过PDF发给我'],
    ['现在nova在线了吗'], // status ping
    ['好的 部署吧'],
    ['<@U0C45AW5G80> 看看上面这个'], // bare "look"
    ['我应该登陆了的 你再看看？'], // retry
    ['不对 我要你研究的是截图里的内容 不是weknora'], // correction
    ['方案A\n可以把steveswiki的project path添加到你这个团队里'], // picks an option
    ['Ella说的人设基本对的\n对的 就是可以顺势接住“能不能帮我做”'], // the ask is only quoted
    ['OK 这个可以先留作backlog\n你10月24号以后提醒我'], // deferral
    // 2026-09-28: what to do with the thing just discussed (DISPOSITION)
    ['A 论文那个 开个Issue吧 放到backlog B 也是放到backlog C 改一下标题'],
    ['加到flopost的backlog'],
    ['提醒我明天做这件事'],
    ['好的 存下来 但是关键要知道怎么才能实现'],
  ])('%s → appended', (text) => {
    const c = classifyOwnerMessage(text, { inThread: true });
    expect({ text, verdict: c.verdict }).toEqual({ text, verdict: 'follow_up' });
  });
});

describe('classifyOwnerMessage — top level', () => {
  it('rescues request-phrased questions the intent classifier calls L0', () => {
    expect(classifyOwnerMessage('那个orca和crewly是不是有点像\n可以研究一下他们是怎么做的吗', { inThread: false }).verdict).toBe('new_ask');
    expect(classifyOwnerMessage('<@U0C2ZK849ND> 看看这个 <https://x.com/a/status/1|link>', { inThread: false }).verdict).toBe('new_ask');
  });

  it('turns a pure information question into a question ticket', () => {
    expect(classifyOwnerMessage('这个团队都有几个人', { inThread: false }).verdict).toBe('question');
    expect(classifyOwnerMessage('我们这里有没有codex的agent', { inThread: false }).verdict).toBe('question');
  });

  it('ignores acks, status pings and empty text', () => {
    for (const text of ['登陆了', '好的', '现在呢', '[Slack File: /path/file]', '']) {
      expect({ text, verdict: classifyOwnerMessage(text, { inThread: false }).verdict }).toEqual({ text, verdict: 'not_ask' });
    }
  });

  it('does not apply thread-only follow-up signals at the top level', () => {
    // A `.md` path and "please look" is a brief at the top level, not a delivery instruction.
    expect(classifyOwnerMessage('这是我们准备要做的\nops/marketing/2026-09-template-deploy/00-plan.md\n\n你可以看一下', { inThread: false }).verdict).toBe('new_ask');
  });
});

describe('classifyOwnerMessage — scoring rules', () => {
  it('a tie goes to follow-up (over-splitting is the worse failure)', () => {
    const c = classifyOwnerMessage('<@U0C30GRCPT4> 你打算怎么定我的人设？ 做成什么样', { inThread: true });
    expect(c.ask).toBeGreaterThanOrEqual(2);
    expect(c.ask).toBeLessThanOrEqual(c.follow);
    expect(c.verdict).toBe('follow_up');
  });

  it('a long spoken reply is a follow-up unless it asks outright', () => {
    const talk = '我觉得这个方向是对的，'.repeat(20) + '看看有没有别的观点';
    expect(classifyOwnerMessage(talk, { inThread: true }).signals).toContain('long_discussion');
    expect(classifyOwnerMessage(talk, { inThread: true }).verdict).toBe('follow_up');
    expect(classifyOwnerMessage(talk + '。你能不能帮我总结成一个MD文档', { inThread: true }).verdict).toBe('new_ask');
  });

  it('reports the signals that decided it', () => {
    const c = classifyOwnerMessage('可以去研究一下opus做视频那个吗', { inThread: true });
    expect(c.signals).toContain('request_verb');
    expect(c).toMatchObject({ verdict: 'new_ask', ask: 2, follow: 0 });
  });

  it('askText drops Slack wrappers and mentions but keeps links', () => {
    expect(askText('<@U0C2ZK849ND> 看看 <https://a.b/c|a.b> [Slack Image: /path/x.jpg]')).toBe('看看 https://a.b/c');
  });

  it('weightedTextLength counts CJK double', () => {
    expect(weightedTextLength('ab中文')).toBe(6);
  });
});

describe('classifyOwnerMessage — the labelled sets, as counts', () => {
  /**
   * Score one set: asks caught / missed, follow-ups kept / over-split, and
   * top-level right / wrong.
   *
   * @param rows - The examples
   * @returns The counts
   */
  function score(rows: Example[]) {
    const c = { examined: rows.length, asks: 0, askMissed: 0, followUps: 0, overSplit: 0, top: 0, topWrong: 0 };
    for (const r of rows) {
      const v = classifyOwnerMessage(r.text, { inThread: r.inThread }).verdict;
      if (!r.inThread) {
        c.top += 1;
        if (v !== r.label) c.topWrong += 1;
      } else if (r.label === 'new_ask') {
        c.asks += 1;
        if (!opensTicket(v)) c.askMissed += 1;
      } else {
        c.followUps += 1;
        if (opensTicket(v)) c.overSplit += 1;
      }
    }
    return c;
  }

  // Ceilings are today's counts: a change may lower them, never raise them.
  // `tuned` was used to write the rules; `holdout` was labelled blind and then
  // tuned on too; `final` was labelled blind, one rule added after scoring it.
  it.each([
    ['tuned', { asks: 11, followUps: 78, top: 22 }, { askMissed: 0, overSplit: 0, topWrong: 1 }],
    ['holdout', { asks: 38, followUps: 89, top: 0 }, { askMissed: 4, overSplit: 3, topWrong: 0 }],
    ['final', { asks: 7, followUps: 11, top: 0 }, { askMissed: 3, overSplit: 1, topWrong: 0 }],
  ] as const)('%s set', (name, sizes, ceilings) => {
    const rows = FIXTURES.sets[name];
    const c = score(rows);
    // What was examined — an empty set is not a pass.
    expect(c.examined).toBeGreaterThan(0);
    expect({ asks: c.asks, followUps: c.followUps, top: c.top }).toEqual(sizes);
    expect(c.askMissed).toBeLessThanOrEqual(ceilings.askMissed);
    expect(c.overSplit).toBeLessThanOrEqual(ceilings.overSplit);
    expect(c.topWrong).toBeLessThanOrEqual(ceilings.topWrong);
  });
});
