import { OWNER_COMPLETION_REPORT_CONSTANTS as C } from '../../constants.js';
import { detectOwnerLanguage, fallbackLine, joinDeliverables, leadFallbackLine, plainDeliverable, plainDeliverables, plainDeliverablesIn } from './owner-completion-report.text.js';

describe('detectOwnerLanguage', () => {
  it('Chinese when enough of the letters are CJK; English otherwise; empty is English', () => {
    expect(detectOwnerLanguage('什么是投资')).toBe('zh');
    expect(detectOwnerLanguage(['帮我录一个 two accounts 的屏幕视频', 'ok'])).toBe('zh');
    expect(detectOwnerLanguage('Record a short demo of the schedule app')).toBe('en');
    expect(detectOwnerLanguage('')).toBe('en');
    expect(detectOwnerLanguage(null)).toBe('en');
    expect(detectOwnerLanguage('12345 !!!')).toBe('en');
  });
});

describe('plainDeliverable', () => {
  it('keeps the first clause and drops links, ids, paths, file names and parentheses with digits (the 15:47Z fallback)', () => {
    expect(plainDeliverable('Screen recording of the tutorial page (1080p, 42 MB) — https://github.com/x/y/pull/12')).toBe('Screen recording of the tutorial page');
    expect(plainDeliverable('Card copy for the 5 schedule cards: see ops/marketing/cards.md')).toBe('Card copy for the 5 schedule cards');
    expect(plainDeliverable('Recorded two-accounts.mp4 (h264, 1920x1080) in /Users/me/Movies/two-accounts.mp4')).toBe('Recorded');
    expect(plainDeliverable('[DONE] Refresh today\'s X reply prep now that Crewly in Chrome is back. Script exit 0, 12 replies.')).toBe('Refresh today\'s X reply prep now that Crewly in Chrome is back');
  });

  it('removes work item ids, ticket ids, commit shas and code spans', () => {
    expect(plainDeliverable('WorkItem 3a9f0c2d-1111-2222-3333-444455556666 verified')).toBe('WorkItem verified');
    expect(plainDeliverable('Fix for CREW-305 and #1357 (`npm test` green, sha 9f8e7d6c5b)')).toBe('Fix');
    expect(plainDeliverable('Draft 1 of 3 posts, 320 words')).toBe('Draft 1 of 3 posts, 320 words');
  });

  it('handles Chinese text: full-width parentheses and sentence ends', () => {
    expect(plainDeliverable('排期里 5 张卡的文案（共 5 条，见 cards.md）。已交 Ella 审。')).toBe('排期里 5 张卡的文案');
    expect(plainDeliverable('教程页的录屏；文件 ~/Movies/demo.mov')).toBe('教程页的录屏');
  });

  it('caps the length and returns empty for nothing usable', () => {
    const long = 'A'.repeat(C.DELIVERABLE_MAX_CHARS + 40);
    expect(plainDeliverable(long).length).toBe(C.DELIVERABLE_MAX_CHARS);
    expect(plainDeliverable(long).endsWith('…')).toBe(true);
    expect(plainDeliverable('https://x.test/a (v2)')).toBe('');
    expect(plainDeliverable(undefined)).toBe('');
  });
});

describe('plainDeliverables / joinDeliverables', () => {
  it('de-duplicates (case-insensitively), drops empties, caps at MAX_TITLES', () => {
    const texts = ['Card copy', 'card copy', '', 'https://x.test', 'Recording', 'C', 'D', 'E', 'F', 'G'];
    const got = plainDeliverables(texts);
    expect(got.slice(0, 2)).toEqual(['Card copy', 'Recording']);
    expect(got).toHaveLength(C.MAX_TITLES);
  });

  it('joins the way the language does', () => {
    expect(joinDeliverables([], 'en')).toBe('');
    expect(joinDeliverables(['a'], 'zh')).toBe('a');
    expect(joinDeliverables(['a', 'b'], 'en')).toBe('a and b');
    expect(joinDeliverables(['a', 'b', 'c'], 'en')).toBe('a, b and c');
    expect(joinDeliverables(['文案', '录屏'], 'zh')).toBe('文案和录屏');
    expect(joinDeliverables(['文案', '录屏', '海报'], 'zh')).toBe('文案、录屏和海报');
  });
});

describe('fallbackLine', () => {
  it('one plain sentence in the owner\'s language plus the short marker; no ids, links, files or sizes', () => {
    const zh = fallbackLine({
      agentName: 'Ella',
      deliverables: ['排期里 5 张卡的文案（见 ops/marketing/cards.md）', '教程页的录屏 — https://github.com/x/y/pull/12 (h264, 42 MB)'],
      language: 'zh',
    });
    expect(zh).toBe('Ella 做完了排期里 5 张卡的文案和教程页的录屏。\n— 由 Crewly 代发');
    const en = fallbackLine({ agentName: 'Ella', deliverables: ['Card copy for the 5 schedule cards', 'Screen recording of the tutorial page (1080p)'], language: 'en' });
    expect(en).toBe('Ella finished Card copy for the 5 schedule cards and Screen recording of the tutorial page.\n— sent by Crewly');
    for (const line of [zh, en]) {
      expect(line).not.toMatch(/https?:|\.md|\.mp4|MB|h264|Results:|[0-9a-f]{8}-/);
      expect(line.split('\n')).toHaveLength(2);
    }
  });

  it('nothing nameable → a generic sentence', () => {
    expect(fallbackLine({ agentName: 'Lyra', deliverables: ['https://x.test/only-a-link'], language: 'en' })).toBe('Lyra finished what you asked for.\n— sent by Crewly');
    expect(fallbackLine({ agentName: 'Lyra', deliverables: [], language: 'zh' })).toBe('Lyra 把你要的事做完了。\n— 由 Crewly 代发');
  });
});

describe('owner-language deliverables (crewly#1376)', () => {
  it('a zh line never embeds an English WorkItem title, and promises nothing', () => {
    const line = fallbackLine({ agentName: 'Atlas', deliverables: ['Website-plan PDF built and posted in Steve thread with summary'], language: 'zh' });
    expect(line).toBe('Atlas 把你要的事做完了。\n— 由 Crewly 代发');
    expect(line).not.toMatch(/Website|细节稍后/);
  });

  it('keeps phrases in the owner\'s language (a zh phrase with a Latin word stays), drops the others', () => {
    expect(plainDeliverablesIn(['网站方案 PDF', 'Website plan'], 'zh')).toEqual(['网站方案 PDF']);
    expect(plainDeliverablesIn(['网站方案', 'Website plan'], 'en')).toEqual(['Website plan']);
    expect(leadFallbackLine({ workerName: 'Sage', deliverables: ['Website plan'], language: 'zh' })).toBe('Sage 把你批准的事做完了。\n— 由 Crewly 代发');
  });

  it('the English line promises nothing either', () => {
    expect(fallbackLine({ agentName: 'Atlas', deliverables: ['Website plan'], language: 'en' })).toBe('Atlas finished Website plan.\n— sent by Crewly');
  });
});

describe('leadFallbackLine (crewly#1371)', () => {
  const link = 'https://slack.com/archives/D0ORC/p1792000000000100';

  it('names the worker, the deliverable and the approval thread, in the owner\'s language', () => {
    expect(leadFallbackLine({ workerName: 'Luna', deliverables: ['教程改写'], language: 'zh', approvalLink: link })).toBe(
      `Luna 做完了你批准的教程改写。\n批准的对话：${link}\n— 由 Crewly 代发`,
    );
    expect(leadFallbackLine({ workerName: 'Luna', deliverables: ['the tutorial rewrite'], language: 'en', approvalLink: link })).toBe(
      `Luna finished the tutorial rewrite, which you approved.\nWhere you approved it: ${link}\n— sent by Crewly`,
    );
  });

  it('no deliverable, no link → a plain sentence and the marker only', () => {
    expect(leadFallbackLine({ workerName: 'Luna', deliverables: [], language: 'zh' })).toBe('Luna 把你批准的事做完了。\n— 由 Crewly 代发');
    expect(leadFallbackLine({ workerName: 'Luna', deliverables: [], language: 'en', approvalLink: '  ' })).toBe('Luna finished what you approved.\n— sent by Crewly');
  });
});
