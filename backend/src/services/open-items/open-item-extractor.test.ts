/**
 * Tests for the open-item extractor (specs/2026-10-01-reply-open-items.md §1):
 * commitments and owner questions in Chinese and English, the TKT-185 reply,
 * and the negatives that must NOT become items.
 */
import { extractOpenItems, isCommitment, isOwnerQuestion, parseDue, splitSentences } from './open-item-extractor.js';

/** Thu 2026-10-01 18:00:29 local — when Atlas replied in TKT-185. */
const NOW = new Date(2026, 9, 1, 18, 0, 29);
const opts = { now: NOW, colleagueNames: ['Kai', 'Rex', 'Ella', 'Sage'], ownerSlackUserId: 'UOWNER' };

/** Atlas's reply in #book-publish (TKT-185), verbatim. */
const ATLAS_REPLY = [
  '小红书那几篇已经放进书里了，改了三处，你的原话都存进了 wiki。',
  '*序：「变天了」换了出处*',
  '你语音里说的「十分钟做好 Chrome 插件」其实是两篇记到了一起：插件是 2025 年 6 月那篇（20% 时间做的插件）。序里改成引 2024 年 9 月底那篇的原话：「以后你有个什么想法，10 分钟就给你做出可以用的工具，1 天可以造一个网站或手机 App。」照样不点产品名。',
  '*第 13 章 绩效：放的是「办公室政治」那篇*',
  'Rex 核过了，那篇讲的不是不同家的模型，而是你团队里 20 个 agent 互评。后面我加了一段读法，这段是我写的，不是你的原话，书里标了待确认。',
  '*播客「第二工位」*',
  'Kai 在把四集逐条过一遍，找出能进书的原话，每条标好放哪一章、能补哪个空，也会挑出和现有书稿说法冲突的地方。明天中午给我，我核过以后挑最有用的几条发你。',
  '第 13 章「互评当体检用」这个读法，你同意吗？不同意的话我就删掉，只留事实。',
].join('\n');

describe('extractOpenItems — TKT-185 (Atlas, #book-publish)', () => {
  const found = extractOpenItems(ATLAS_REPLY, opts);

  it('finds exactly the promise and the question', () => {
    expect(found.commitments.map((c) => c.text)).toEqual(['明天中午给我，我核过以后挑最有用的几条发你。']);
    expect(found.questions.map((q) => q.text)).toEqual(['第 13 章「互评当体检用」这个读法，你同意吗？']);
  });

  it('dates the promise tomorrow 12:00 local', () => {
    const due = found.commitments[0].due;
    expect(found.commitments[0].dueSource).toBe('text');
    expect([due.getFullYear(), due.getMonth(), due.getDate(), due.getHours(), due.getMinutes()]).toEqual([2026, 9, 2, 12, 0]);
  });

  it('keeps the stated fallback with the question', () => {
    expect(found.questions[0].fallback).toBe('不同意的话我就删掉，只留事实。');
  });

  it('does not read the quoted 原话 as a promise (quote spans a 。)', () => {
    expect(found.commitments.some((c) => c.text.includes('10 分钟'))).toBe(false);
  });
});

describe('commitments', () => {
  it.each([
    '大约 1 小时后发在这里。',
    '运营计划出来后发在这里。',
    '写好我先核一遍，再把预览发到这里，大约 2–3 小时。',
    '今晚先发改好的两处，播客素材明天整理好一起给你。',
    "I'll send you the draft tonight.",
    'I will share the numbers by Friday.',
    "I'm going to follow up with the revised deck tomorrow morning.",
  ])('detects %s', (s) => {
    expect(isCommitment(s)).toBe(true);
  });

  it.each([
    ['past tense', '第 11、12 章按你刚才的语音改好了，PDF 已经发你了。'],
    ['attached now', 'PDF 附在下面（9 页）。'],
    ['here it is', '现在先给你一个预览：关闭 542 张。'],
    ['conditional offer', '需要的话我明天再发你一版。'],
    ['standing habit', '以后每章都给你发 PDF。'],
    ['third party delivers', '你的回复多在晚上发，别人第二天白天回你。'],
    ['an aside in brackets', '互动最高的几条都是 AI 实测（Gemini 带你玩夏威夷），和方向对得上。'],
    ['adjectival 给你的', '做好以后，给你的名单里只会有真正没收录的页。'],
    ['a question', '要不要明天发你？'],
    ['English conditional', "If you want, I'll send it tomorrow."],
    ['English past', 'I already sent you the file.'],
    ['let me know', 'Let me know what you think.'],
  ])('ignores %s', (_label, s) => {
    expect(isCommitment(s)).toBe(false);
  });

  it('does not take a promise addressed to a colleague', () => {
    const r = extractOpenItems('Kai，你明天中午前发我四集的摘录。', opts);
    expect(r.commitments).toEqual([]);
  });
});

describe('owner questions', () => {
  const q = (s: string, next?: string): boolean => isOwnerQuestion(s, next, opts);

  it.each([
    '第 13 章「互评当体检用」这个读法，你同意吗？',
    '要不要记进 wiki 当这章的素材？',
    '另外这篇的配图还没做完，要现在先发文字版，还是等图好了再发？',
    'Should I keep the appendix or drop it?',
    'Do you want me to send the email on Monday?',
    'Is that OK?',
  ])('detects %s', (s) => {
    expect(q(s)).toBe(true);
  });

  it.each([
    ['rhetorical, answered next', '为什么这件事难？', '因为没有人负责验收。'],
    ['rhetorical opener', '难道每次都要等你点头？', undefined],
    ['quoted question', '早报里问你一句「你怎么看，大多数人哪里想错了？」', undefined],
    ['to a colleague by name', 'Kai，你那边四集过完了吗？', undefined],
    ['to a colleague by mention', '<@U0C2ZK849ND> 你那边好了吗？', undefined],
    ['to a colleague by @name', '@Rex 你核过了吗？', undefined],
    ['open information question', '咨询、报名、排班，你们每周大概花多少小时？', undefined],
    ['English rhetorical', 'Why does this matter?', 'Because the owner never sees it.'],
    ['a heading', '*为什么是你？*', undefined],
    ['not a question', '你的原话都存进了 wiki。', undefined],
  ])('ignores %s', (_label, s, next) => {
    expect(q(s, next)).toBe(false);
  });

  it('skips heading lines entirely', () => {
    expect(extractOpenItems('*要不要现在发？*', opts).questions).toEqual([]);
  });

  it('accepts a mention of the owner', () => {
    expect(q('<@UOWNER> 这个读法你同意吗？')).toBe(true);
  });
});

describe('parseDue', () => {
  const at = (d: Date): number[] => [d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()];

  it('tomorrow alone → tomorrow 12:00', () => {
    expect(at(parseDue('明天给你', NOW).due)).toEqual([9, 2, 12, 0]);
    expect(at(parseDue('I will send it tomorrow', NOW).due)).toEqual([9, 2, 12, 0]);
  });

  it('parts of the day', () => {
    expect(at(parseDue('明天傍晚给你', NOW).due)).toEqual([9, 2, 18, 0]);
    expect(at(parseDue('明早发你', NOW).due)).toEqual([9, 2, 10, 0]);
    expect(at(parseDue('tomorrow afternoon', NOW).due)).toEqual([9, 2, 15, 0]);
    expect(at(parseDue('今晚发你', NOW).due)).toEqual([9, 1, 21, 0]);
  });

  it('relative times', () => {
    expect(parseDue('大约 40 分钟后发你', NOW).due.getTime() - NOW.getTime()).toBe(40 * 60_000);
    expect(parseDue('in 2 hours', NOW).due.getTime() - NOW.getTime()).toBe(2 * 3600_000);
    expect(parseDue('晚点发你', NOW).due.getTime() - NOW.getTime()).toBe(2 * 3600_000);
  });

  it('weekdays (NOW is a Thursday)', () => {
    expect(at(parseDue('周五前给你', NOW).due)).toEqual([9, 2, 12, 0]);
    expect(at(parseDue('by Monday', NOW).due)).toEqual([9, 5, 12, 0]);
    expect(at(parseDue('下周三给你', NOW).due)).toEqual([9, 7, 12, 0]);
  });

  it('no time → +24 h, marked default', () => {
    const r = parseDue('整理好一起给你', NOW);
    expect(r.source).toBe('default');
    expect(r.due.getTime() - NOW.getTime()).toBe(24 * 3600_000);
  });
});

describe('splitSentences', () => {
  it('never splits inside quotes and keeps the terminator', () => {
    const s = splitSentences('原话：「一天做网站。两天做 App。」照样不点名。你同意吗？');
    expect(s.map((x) => x.text)).toEqual(['原话：「一天做网站。两天做 App。」照样不点名。', '你同意吗？']);
  });
});

describe('TKT-187 / TKT-140 real messages (false positives and the positive control)', () => {
  const now = new Date(2026, 9, 1, 0, 19, 0);
  const CAVEAT_3D8B9F43 =
    '*要说清楚的地方*：USCIS 是按诊所汇总的，写了「普通话」只代表诊所里有人会，不一定是给你体检的那位医生；而且有漏报，有的诊所官网说会中文，USCIS 上没写。';
  const ASK_CFD95E7B = '改完要部署到线上，所以先问你：可以就让 Vera 做，做完给你看预览再上线。';
  const REAL_2EA43C4F = 'Nova 在补体检指南里的三条（验毒和喝酒、中文疫苗本、预约排期），先逐条拿 CDC 指引核对，写完给你预览，你说可以再上线。';
  const WAITS_77948B54 = '换成「别考核 AI 用量」：* 你点头后，Sage 先查有多少公司真在这样考、有没有反例，Kai 站反方挑刺，结果发在这里，你看过再决定写不写。';

  it('a caveat about the work is not a promise (3d8b9f43)', () => {
    expect(isCommitment('要说清楚的地方*：USCIS 是按诊所汇总的，写了「普通话」只代表诊所里有人会，不一定是给你体检的那位医生；')).toBe(false);
    expect(extractOpenItems(CAVEAT_3D8B9F43, { now }).commitments).toHaveLength(0);
  });

  it('a note about the work is not a promise even without a modifier clause', () => {
    expect(isCommitment('*注意*：这条可能需要 Vera 再核一遍，今天发你的版本不一定是最终的。')).toBe(false);
    expect(isCommitment('Note: this may need a second look, I will send you the draft tomorrow.')).toBe(false);
  });

  it('a real promise that carries a hedge stays a commitment (#925)', () => {
    expect(isCommitment('明天发你清单，不一定全。')).toBe(true);
    expect(isCommitment("I'll send the draft tomorrow, though it may need another pass.")).toBe(true);
    expect(isCommitment("I'll send you the draft tomorrow but it might need another pass.")).toBe(true);
    expect(extractOpenItems('明天发你清单，不一定全。', { now }).commitments).toHaveLength(1);
  });

  it('a hedge inside the promise itself still drops it (#925)', () => {
    expect(isCommitment('可能需要明天再发你。')).toBe(false);
    expect(isCommitment("I'll may need to send you the draft tomorrow.")).toBe(false);
  });

  it('asking for a go-ahead is not a promise, and not a conditional one either (cfd95e7b)', () => {
    expect(isCommitment(ASK_CFD95E7B)).toBe(false);
    expect(extractOpenItems(ASK_CFD95E7B, { now }).commitments).toHaveLength(0);
  });

  it('the real promise stays a commitment (2ea43c4f positive control)', () => {
    const c = extractOpenItems(REAL_2EA43C4F, { now }).commitments;
    expect(c).toHaveLength(1);
    expect(c[0].waitsOnOwner).toBeUndefined();
  });

  it('a promise that waits on the owner is flagged (77948b54)', () => {
    const c = extractOpenItems(WAITS_77948B54, { now }).commitments;
    expect(c).toHaveLength(1);
    expect(c[0].waitsOnOwner).toBe(true);
    expect(extractOpenItems('After you approve, I will send the draft tomorrow.', { now }).commitments[0]?.waitsOnOwner).toBe(true);
  });
});

describe('explicit dates win over now + default', () => {
  const now = new Date(2026, 10 - 1, 1, 0, 19, 0);
  it.each([
    ['10/7 前把成稿发你。', new Date(2026, 9, 7, 18, 0)],
    ['10月7日中午前给你结论。', new Date(2026, 9, 7, 12, 0)],
    ['I will send the draft by Oct 7.', new Date(2026, 9, 7, 18, 0)],
    ['2026-10-07 之前发你报告。', new Date(2026, 9, 7, 18, 0)],
  ])('%s', (text, expected) => {
    const r = parseDue(text, now);
    expect(r.source).toBe('text');
    expect(r.due.getTime()).toBe(expected.getTime());
  });
  it('is not 10/2 00:19 (the old now + 24h default)', () => {
    expect(parseDue('10/7 前把成稿发你。', now).due.getTime()).not.toBe(now.getTime() + 24 * 3600_000);
  });
  it('does not read a ratio or a version as a date', () => {
    expect(parseDue('完成 1/3 以后发你。', now).source).toBe('default');
  });
});

describe('only the final question of a message is carded (2026-10-08 card audit)', () => {
  const qs = (text: string): string[] => extractOpenItems(text, opts).questions.map((q) => q.text);

  /** Atlas, 2026-10-08: client interview questions in the reply (D-442 / D-444 were carded by mistake). */
  const ATLAS_INTERVIEW = [
    '*3. 要不要先跟客户聊？* 要，但别问「你想用什么入口」，问了他也只会随口答。问这几件事：',
    '• 现在增长这块是谁在做，一个月花多少钱？',
    '• 现在的代运营或外包怎么给你汇报：邮件、微信，还是开会？',
    '• 上一次你因为对方做得不好想换人，是因为什么？',
    '他怎么回答第二个问题，我们的入口就照那个来。',
    '',
    '这些我会写进周五给你的那页「增长团队」初稿，单独成一节，访谈问题也放进去。这样写可以吗？',
  ].join('\n');

  it('the listed interview questions and the self-answered heading are skipped; the closing question is kept', () => {
    expect(qs(ATLAS_INTERVIEW)).toEqual(['这样写可以吗？']);
  });

  it('a message that ends in a list of questions for a third party has no question for the owner', () => {
    const text = '*每个人都问这四个*\n1. 外包或员工现在怎么跟你汇报：邮件、微信，还是开会？\n2. 上个月进来多少个咨询，最后成了几个？你自己知道吗？';
    expect(qs(text)).toEqual([]);
  });

  it('a question in the middle of a message is not carded', () => {
    expect(qs('这版要不要先发给 Rex 看？\n\n另外周五的稿子我已经写完一半，明天中午前给你。')).toEqual([]);
  });

  it('numbered owner decisions get no cards (one ask-owner per decision instead)', () => {
    expect(qs('两件事：\n1. 价格按上面这样可以吗？\n2. 第一版要不要包括采购入库？')).toEqual([]);
  });

  it('the final question may be followed by how to answer it, in its paragraph', () => {
    expect(qs('两篇都改好了。\n\n要发布吗？回「发」我就把这两篇正式上线。')).toEqual(['要发布吗？']);
    expect(qs('这样行吗？不同意的话我就删掉。')).toEqual(['这样行吗？']);
  });

  it('only references, links or a sign-off may follow in later paragraphs', () => {
    expect(qs('要收进库吗？\n\n参考：https://example.com/a')).toEqual(['要收进库吗？']);
    expect(qs('要收进库吗？\n\n谢谢')).toEqual(['要收进库吗？']);
    expect(qs('要收进库吗？\n\n我先去改第 3 章。')).toEqual([]);
  });

  it('a question inside a draft between rule lines is the draft, not the agent asking', () => {
    const text = '草稿如下：\n———\n如果您觉得他准备好了，能不能给他一些新的工作试试？\n———';
    expect(qs(text)).toEqual([]);
    expect(qs(`${text}\n\n这个长度行吗？`)).toEqual(['这个长度行吗？']);
  });

  it('either/or alternatives that end the message stay one group', () => {
    expect(qs('页面已经改好。要现在发，还是等图好了再发？')).toEqual(['要现在发，还是等图好了再发？']);
    expect(qs('要先改现在的版本吗？还是先试新的版本？')).toEqual(['要先改现在的版本吗？', '还是先试新的版本？']);
  });

  it('a question to a colleague or a script line is not for the owner', () => {
    expect(qs('Kai，你明天能把四集的摘录整理好吗？')).toEqual([]);
    expect(qs('> 于是我就想，能不能靠我的 AI 团队，帮我一起管一管？')).toEqual([]);
  });
});

