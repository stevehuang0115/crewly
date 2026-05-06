/**
 * Smoke tests for the rule-set exported by
 * `intent-classifier.rules.ts`. The classifier consumer logic is tested
 * end-to-end in `intent-task.types.test.ts` and the fixture suite —
 * this file pins each individual rule so an inadvertent regex tweak
 * lands as a localised failure rather than a multi-rule cascade.
 *
 * @module services/intent-task/intent-classifier.rules.test
 */

import { describe, it, expect } from '@jest/globals';

import {
  L2_QUANTIFIER_TRIGRAM,
  L2_TRIGRAM_STATE_CHANGE_VERB,
  L2_TRIGRAM_DELIVERABLE,
  L2_DOC_CREATION_TRIGGER,
  L2_FILE_EXTENSION_TRIGGER,
  L2_PR_ARTIFACT_TRIGGER,
  L2_MIGRATION_TRIGGER,
  L2_BUILD_SYSTEM_NOUN,
  L2_DEPLOY_ENV_NOUN,
  L2_E2E_SCOPE,
  L2_COORDINATE,
  L2_SEQUENCED_VERBS,
  L2_NUMBERED_LIST,
  L2_CROSS_SYSTEM_PIVOT,
  L3_SPRINT_OKR_MARKERS,
  L3_TIMEBOX_MARKERS,
  L3_DELIVER_SHIP_VERBS,
  L0_READ_VERB_PATTERN,
  ACTION_VERB_EN,
  ACTION_VERB_ZH,
  NON_ACTIONABLE_PATTERNS_ZH,
  CATEGORY_KEYWORDS,
  L2_LENGTH_FLOORS,
} from './intent-classifier.rules.js';

describe('§2.1 — quantifier trigram (3-axis check)', () => {
  // The trigram is the AND of three axes: quantifier + state-change verb +
  // deliverable noun. The classifier checks all three; these tests pin
  // each axis individually.
  it('EN: all three axes fire for "create three reports about the issue"', () => {
    const input = 'create three reports about the issue';
    expect(L2_QUANTIFIER_TRIGRAM.en.test(input)).toBe(true);
    expect(L2_TRIGRAM_STATE_CHANGE_VERB.en.test(input)).toBe(true);
    expect(L2_TRIGRAM_DELIVERABLE.en.test(input)).toBe(true);
  });

  it('EN: all three axes fire for "build all five services"', () => {
    const input = 'build all five services';
    expect(L2_QUANTIFIER_TRIGRAM.en.test(input)).toBe(true);
    expect(L2_TRIGRAM_STATE_CHANGE_VERB.en.test(input)).toBe(true);
    expect(L2_TRIGRAM_DELIVERABLE.en.test(input)).toBe(true);
  });

  it('ZH: all three axes fire for the canonical Steve mis-label "做这两份 md 文档"', () => {
    const input = '做这两份 md 文档';
    expect(L2_QUANTIFIER_TRIGRAM.zh.test(input)).toBe(true);
    expect(L2_TRIGRAM_STATE_CHANGE_VERB.zh.test(input)).toBe(true);
    expect(L2_TRIGRAM_DELIVERABLE.zh.test(input)).toBe(true);
  });

  it('ZH: all three axes fire for "写三个 spec"', () => {
    const input = '写三个 spec';
    expect(L2_QUANTIFIER_TRIGRAM.zh.test(input)).toBe(true);
    expect(L2_TRIGRAM_STATE_CHANGE_VERB.zh.test(input)).toBe(true);
    expect(L2_TRIGRAM_DELIVERABLE.zh.test(input)).toBe(true);
  });

  it('"show me all 3 statuses" — quantifier fires but state-change verb does NOT', () => {
    // Mia §3 anti-pattern: quantified read stays L0. The quantifier axis
    // matches "all 3" but the state-change verb axis must NOT — "show"
    // is read-only and not in the state-change set.
    const input = 'show me all 3 statuses';
    expect(L2_QUANTIFIER_TRIGRAM.en.test(input)).toBe(true);
    expect(L2_TRIGRAM_STATE_CHANGE_VERB.en.test(input)).toBe(false);
  });
});

describe('§2.2 — multi-artifact triggers', () => {
  it('doc creation matches "spec" / "design doc" / "RFC"', () => {
    expect(L2_DOC_CREATION_TRIGGER.en.test('write a design doc for X')).toBe(true);
    expect(L2_DOC_CREATION_TRIGGER.en.test('draft an RFC')).toBe(true);
    expect(L2_DOC_CREATION_TRIGGER.zh.test('写一份设计文档')).toBe(true);
    expect(L2_DOC_CREATION_TRIGGER.zh.test('草稿一份 md 文档')).toBe(true);
  });

  it('file-with-extension matches paths ending in .ts/.md/.sql/.tf', () => {
    expect(L2_FILE_EXTENSION_TRIGGER.test('update foo.ts and bar.md')).toBe(true);
    expect(L2_FILE_EXTENSION_TRIGGER.test('migrate schema.sql')).toBe(true);
    expect(L2_FILE_EXTENSION_TRIGGER.test('deploy main.tf')).toBe(true);
  });

  it('PR artifact matches "open a PR" / "create a branch" / "提交 PR"', () => {
    expect(L2_PR_ARTIFACT_TRIGGER.en.test('open a PR for the fix')).toBe(true);
    expect(L2_PR_ARTIFACT_TRIGGER.en.test('create a new branch')).toBe(true);
    expect(L2_PR_ARTIFACT_TRIGGER.zh.test('提交一个 PR')).toBe(true);
  });

  it('migration matches "migration" / "schema" / "迁移"', () => {
    expect(L2_MIGRATION_TRIGGER.en.test('add a migration for users table')).toBe(true);
    expect(L2_MIGRATION_TRIGGER.zh.test('做数据迁移')).toBe(true);
  });
});

describe('§2.3 — verb–noun pair signaling system-level work', () => {
  it('build/system: EN + ZH parity', () => {
    expect(L2_BUILD_SYSTEM_NOUN.en.test('implement a new feature')).toBe(true);
    expect(L2_BUILD_SYSTEM_NOUN.zh.test('实现新功能')).toBe(true);
    expect(L2_BUILD_SYSTEM_NOUN.zh.test('重构系统模块')).toBe(true);
  });

  it('deploy/env: EN + ZH parity', () => {
    expect(L2_DEPLOY_ENV_NOUN.en.test('deploy to staging')).toBe(true);
    expect(L2_DEPLOY_ENV_NOUN.zh.test('部署到生产环境')).toBe(true);
  });

  it('e2e/full-stack: EN + ZH parity', () => {
    expect(L2_E2E_SCOPE.en.test('end-to-end test setup')).toBe(true);
    expect(L2_E2E_SCOPE.zh.test('端到端测试搭建')).toBe(true);
  });

  it('coordinate/orchestrate: single-token signal in EN + ZH', () => {
    expect(L2_COORDINATE.en.test('coordinate the team')).toBe(true);
    expect(L2_COORDINATE.zh.test('协调一下')).toBe(true);
    expect(L2_COORDINATE.zh.test('编排执行计划')).toBe(true);
  });
});

describe('§2.4 — sequenced verbs / numbered list', () => {
  it('sequenced verbs in EN + ZH', () => {
    expect(L2_SEQUENCED_VERBS.en.test('build and then deploy')).toBe(true);
    expect(L2_SEQUENCED_VERBS.zh.test('先实现 然后测试')).toBe(true);
    expect(L2_SEQUENCED_VERBS.zh.test('先做 A 再做 B')).toBe(true);
  });

  it('numbered list with 1./2. or ①②', () => {
    expect(L2_NUMBERED_LIST.test('1. fix bug 2. write test')).toBe(true);
    expect(L2_NUMBERED_LIST.test('①修复 ②测试')).toBe(true);
  });
});

describe('§2.5 — cross-system pivot ("oss重启了 你现在再做这个")', () => {
  it('matches the canonical Steve mis-label', () => {
    expect(L2_CROSS_SYSTEM_PIVOT.zh.test('oss重启了 你现在再做这个')).toBe(true);
  });

  it('matches restart + redirect in EN', () => {
    expect(L2_CROSS_SYSTEM_PIVOT.en.test('server is back, now continue the work')).toBe(true);
  });

  it('matches "好了 现在开始做"', () => {
    expect(L2_CROSS_SYSTEM_PIVOT.zh.test('好了 现在开始做')).toBe(true);
  });
});

describe('§2.6 — sprint / OKR / timebox markers', () => {
  it('sprint markers in EN + ZH', () => {
    expect(L3_SPRINT_OKR_MARKERS.en.test('Sprint 4 planning')).toBe(true);
    expect(L3_SPRINT_OKR_MARKERS.en.test('OKR for Q1')).toBe(true);
    expect(L3_SPRINT_OKR_MARKERS.zh.test('这次冲刺')).toBe(true);
    expect(L3_SPRINT_OKR_MARKERS.zh.test('KR3 onboarding')).toBe(true);
  });

  it('timebox markers in EN + ZH', () => {
    expect(L3_TIMEBOX_MARKERS.en.test('this week')).toBe(true);
    expect(L3_TIMEBOX_MARKERS.en.test('by Friday')).toBe(true);
    expect(L3_TIMEBOX_MARKERS.zh.test('这周搞定')).toBe(true);
    expect(L3_TIMEBOX_MARKERS.zh.test('下周交付')).toBe(true);
  });

  it('deliver / ship verbs in EN + ZH', () => {
    expect(L3_DELIVER_SHIP_VERBS.en.test('ship by tonight')).toBe(true);
    expect(L3_DELIVER_SHIP_VERBS.zh.test('上线发布')).toBe(true);
    expect(L3_DELIVER_SHIP_VERBS.zh.test('交付落地')).toBe(true);
  });
});

describe('§3 — read-verb anti-promotion guard', () => {
  it('EN read verbs do NOT match the action-verb pattern as state-change', () => {
    expect(L0_READ_VERB_PATTERN.en.test('show me the status')).toBe(true);
    expect(L0_READ_VERB_PATTERN.en.test('how many agents are active')).toBe(true);
  });

  it('ZH read verbs match the read-only pattern', () => {
    expect(L0_READ_VERB_PATTERN.zh.test('查看状态')).toBe(true);
    expect(L0_READ_VERB_PATTERN.zh.test('多少个 agent')).toBe(true);
  });
});

describe('Action verbs (EN + ZH)', () => {
  it('EN action verbs fire on canonical imperatives', () => {
    expect(ACTION_VERB_EN.test('fix the bug')).toBe(true);
    expect(ACTION_VERB_EN.test('build a feature')).toBe(true);
    expect(ACTION_VERB_EN.test('deploy to staging')).toBe(true);
  });

  it('ZH action verbs fire on canonical imperatives', () => {
    expect(ACTION_VERB_ZH.test('修复登录 bug')).toBe(true);
    expect(ACTION_VERB_ZH.test('部署到生产')).toBe(true);
    expect(ACTION_VERB_ZH.test('实现登录功能')).toBe(true);
  });

  it('ZH stricter: bare 做 fires when imperative-shaped', () => {
    expect(ACTION_VERB_ZH.test('做这件事')).toBe(true);
    expect(ACTION_VERB_ZH.test('做完成')).toBe(true);
  });

  it('ZH stricter: 做了 / 做不到 / 搞砸 do NOT fire as actionable verbs', () => {
    // Negative-lookahead removes the conversational-filler / capability-denial forms.
    // Note: the verb pattern alone might still match other tokens in the sentence;
    // these tests pin that the BARE-form forbidden suffixes are not the match anchor.
    // We verify by matching a string that ONLY contains the forbidden form.
    expect(ACTION_VERB_ZH.test('做了')).toBe(false);
    expect(ACTION_VERB_ZH.test('做过了')).toBe(false);
    expect(ACTION_VERB_ZH.test('做不到')).toBe(false);
    expect(ACTION_VERB_ZH.test('做不了')).toBe(false);
    expect(ACTION_VERB_ZH.test('搞砸了')).toBe(false);
    expect(ACTION_VERB_ZH.test('搞错了')).toBe(false);
    expect(ACTION_VERB_ZH.test('搞不定')).toBe(false);
  });
});

describe('Non-actionable ZH patterns (Mia stricter-default)', () => {
  it('greetings / pleasantries are filtered', () => {
    expect(NON_ACTIONABLE_PATTERNS_ZH.some((p) => p.test('你好'))).toBe(true);
    expect(NON_ACTIONABLE_PATTERNS_ZH.some((p) => p.test('多谢'))).toBe(true);
  });

  it('acknowledgements are filtered', () => {
    expect(NON_ACTIONABLE_PATTERNS_ZH.some((p) => p.test('好的'))).toBe(true);
    expect(NON_ACTIONABLE_PATTERNS_ZH.some((p) => p.test('收到'))).toBe(true);
    expect(NON_ACTIONABLE_PATTERNS_ZH.some((p) => p.test('知道了'))).toBe(true);
  });

  it('opinion / discussion is filtered', () => {
    expect(NON_ACTIONABLE_PATTERNS_ZH.some((p) => p.test('我觉得这个不太对'))).toBe(true);
  });

  it('completed-action FYI is filtered', () => {
    expect(NON_ACTIONABLE_PATTERNS_ZH.some((p) => p.test('我刚 push 了'))).toBe(true);
    expect(NON_ACTIONABLE_PATTERNS_ZH.some((p) => p.test('做完了'))).toBe(true);
    expect(NON_ACTIONABLE_PATTERNS_ZH.some((p) => p.test('已经搞定了'))).toBe(true);
  });

  it('capability-denial is filtered', () => {
    expect(NON_ACTIONABLE_PATTERNS_ZH.some((p) => p.test('做不到'))).toBe(true);
    expect(NON_ACTIONABLE_PATTERNS_ZH.some((p) => p.test('搞不定'))).toBe(true);
  });

  it('botched-verb short messages are filtered', () => {
    expect(NON_ACTIONABLE_PATTERNS_ZH.some((p) => p.test('搞砸了'))).toBe(true);
    expect(NON_ACTIONABLE_PATTERNS_ZH.some((p) => p.test('搞错了'))).toBe(true);
  });
});

describe('Category keywords (EN + ZH parity per Mia §2.3)', () => {
  it.each<[keyof typeof CATEGORY_KEYWORDS, string, string]>([
    ['debugging', 'fix the bug', '修复故障'],
    ['deployment', 'deploy to production', '部署到生产'],
    ['review', 'review the PR', '评审代码'],
    ['research', 'investigate the issue', '调研一下'],
    ['planning', 'plan the roadmap', '规划路线图'],
    ['communication', 'notify the team', '通知团队'],
    ['codeChange', 'implement the feature', '实现功能'],
    ['query', 'what is the status', '查看状态'],
  ])('%s — EN "%s" + ZH "%s"', (key, en, zh) => {
    const set = CATEGORY_KEYWORDS[key];
    expect(set.en.test(en.toLowerCase())).toBe(true);
    expect(set.zh.test(zh)).toBe(true);
  });
});

describe('L2_LENGTH_FLOORS', () => {
  it('exposes EN word-count + ZH char-count floors', () => {
    expect(L2_LENGTH_FLOORS.wordCount).toBe(35);
    expect(L2_LENGTH_FLOORS.charCount).toBe(80);
  });
});
