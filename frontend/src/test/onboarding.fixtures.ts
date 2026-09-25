/**
 * Test fixtures for the first-run checklist (`/setup` checklist steps and
 * the dashboard "开始使用" card).
 *
 * @module test/onboarding.fixtures
 */

import type { ChecklistStepId, OnboardingChecklist, OnboardingStarter } from '../types/onboarding-checklist.types';

/** Cloud sign-in URL used by fixtures. */
export const TOKEN_PAGE_URL = 'https://api.crewlyai.com/api/cloud/google/start?redirect=https%3A%2F%2Fcrewlyai.com%2Fcloud%2Fcli-token';

/**
 * Build a checklist with the given steps done.
 *
 * @param done - Step ids that are done
 * @param overrides - Top-level overrides
 * @returns Checklist
 */
export function makeChecklist(done: ChecklistStepId[] = [], overrides: Partial<OnboardingChecklist> = {}): OnboardingChecklist {
  const is = (id: ChecklistStepId): boolean => done.includes(id);
  const steps: OnboardingChecklist['steps'] = [
    { id: 'harness', done: is('harness'), detail: { orcHarness: 'claude-code', installed: true, loginState: is('harness') ? 'logged_in' : 'logged_out' } },
    { id: 'team', done: is('team'), detail: { teams: is('team') ? [{ id: 't1', name: 'Personal Assistant', templateId: 'personal-assistant-team' }] : [], blank: false } },
    { id: 'first_task', done: is('first_task'), detail: { sentAt: null, ownerMessageSeen: is('first_task'), pending: false } },
    { id: 'cloud', done: is('cloud'), detail: { connected: is('cloud'), tier: is('cloud') ? 'free' : null, tokenPageSignInUrl: TOKEN_PAGE_URL } },
    { id: 'slack', done: is('slack'), detail: { connected: is('slack'), cloudConnected: is('cloud') } },
  ];
  return {
    steps,
    doneCount: done.length,
    total: steps.length,
    allDone: done.length === steps.length,
    dismissed: false,
    dismissedAt: null,
    ...overrides,
  };
}

/** Starters as the backend returns them. */
export const STARTERS: OnboardingStarter[] = [
  {
    id: 'personal-assistant-team',
    name: 'Personal Assistant',
    label: '个人助理',
    tagline: '帮你盯邮件、日程和消息',
    description: 'A personal assistant',
    recommended: true,
    members: [
      { name: 'Assistant', role: 'generalist' },
      { name: 'Researcher', role: 'researcher' },
    ],
    suggestions: ['每天早上给我一份简报', '帮我整理收件箱', '提醒我这周要办的事'],
  },
  {
    id: 'growth-marketing-team',
    name: 'Growth Marketing Team',
    label: '营销团队',
    tagline: '持续产出内容',
    description: 'Marketing',
    recommended: false,
    members: [{ name: 'Content Strategist', role: 'content-strategist' }],
    suggestions: ['定一个两周的内容计划', '写 3 条小红书笔记草稿', '看看同行什么内容数据好'],
  },
  {
    id: 'blank',
    name: 'Blank',
    label: '空白',
    tagline: '只有 Orc',
    description: '只有 Orc',
    recommended: false,
    members: [],
    suggestions: ['我有哪些事可以交给 AI？', '先问我几个问题', '介绍一下你能做什么'],
  },
];
