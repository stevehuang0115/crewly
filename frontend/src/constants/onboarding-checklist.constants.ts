/**
 * First-run Checklist Constants
 *
 * Endpoints, copy and link builders for the steps after the harness
 * (specs/onboarding-harness-login.md, Phase 3): first team → first task →
 * Crewly Cloud → Slack, on `/setup` and the dashboard "开始使用" card.
 *
 * @module constants/onboarding-checklist.constants
 */

import type { ChecklistStepId } from '../types/onboarding-checklist.types';
import { CLOUD_API_BASE } from './cloud.constants';

export const ONBOARDING_API = {
  /** Checklist steps read from live state */
  CHECKLIST: '/api/onboarding/checklist',
  /** Hide / show the dashboard card */
  DISMISS: '/api/onboarding/checklist/dismiss',
  /** Starter teams (Personal Assistant, Marketing, Blank) */
  STARTERS: '/api/onboarding/starters',
  /** Create the first team */
  STARTER_TEAM: '/api/onboarding/starter-team',
  /** Hand the first task to the orchestrator */
  FIRST_TASK: '/api/onboarding/first-task',
  /** Store a Crewly Cloud token (+ refresh token) on this machine */
  CLOUD_CONNECT: '/api/cloud/connect',
  /** One-click Slack install link through Crewly Cloud */
  SLACK_INSTALL_URL: '/api/slack/cloud/install-url',
  /** Cloud-owned Slack status; `?refresh=1` connects a just-installed workspace */
  SLACK_CLOUD_STATUS: '/api/slack/cloud/status',
} as const;

/** Query parameter that opens `/setup` at a checklist step (`/setup?step=cloud`). */
export const SETUP_STEP_QUERY = 'step';

/** The web app's Cloud callback page (hands the token to this backend). */
export const AUTH_CALLBACK_PATH = '/auth/callback';

/** Query parameter of the callback page naming where to go afterwards. */
export const AUTH_CALLBACK_NEXT_PARAM = 'next';

/** Crewly Cloud's Google sign-in start (redirects back to any http(s) callback with ?token=&refreshToken=). */
export const CLOUD_GOOGLE_START_URL = `${CLOUD_API_BASE}/cloud/google/start`;

/** Chinese-first title per checklist step. */
export const CHECKLIST_STEP_LABELS: Record<ChecklistStepId, string> = {
  harness: '登录编程助手',
  team: '建第一个团队',
  first_task: '派第一件事',
  cloud: '连接 Crewly Cloud',
  slack: '连接 Slack',
};

/** One-line hint per checklist step (shown until the step is done). */
export const CHECKLIST_STEP_HINTS: Record<ChecklistStepId, string> = {
  harness: 'AI 员工靠它干活，先装好并登录。',
  team: '推荐个人助理，也可以选营销团队或先空着。',
  first_task: '一句话告诉团队要做什么。',
  cloud: '手机随时管、自动备份，Slack 也靠它。',
  slack: '在 Slack 里直接和团队说话。',
};

/** Short labels of the whole `/setup` flow (harness steps + checklist steps). */
export const SETUP_FLOW_STEPS: readonly string[] = ['编程助手', 'Orc', '登录', '团队', '第一件事', 'Cloud', 'Slack', '完成'];

/**
 * Whether a path is a same-origin path that is safe to navigate to
 * (absolute path, not protocol-relative, no backslashes).
 *
 * @param path - Candidate
 * @returns True when safe
 */
export function isSafeNextPath(path: string | null | undefined): path is string {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\');
}

/**
 * Crewly Cloud sign-in that comes back to *this* web app — wherever it is
 * opened from (localhost, a LAN address on a phone, a tunnel). Cloud
 * redirects to `<origin>/auth/callback?next=…&token=…&refreshToken=…`, and
 * the callback page hands the tokens to this backend.
 *
 * @param origin - `window.location.origin`
 * @param nextPath - Where the callback page goes afterwards
 * @returns Absolute URL
 */
export function buildCloudSignInUrl(origin: string, nextPath: string): string {
  const callback = `${origin}${AUTH_CALLBACK_PATH}?${AUTH_CALLBACK_NEXT_PARAM}=${encodeURIComponent(nextPath)}`;
  return `${CLOUD_GOOGLE_START_URL}?redirect=${encodeURIComponent(callback)}`;
}

/**
 * `/setup` opened at a checklist step.
 *
 * @param step - Step id
 * @returns Path with query
 */
export function setupStepPath(step: ChecklistStepId): string {
  return `/setup?${SETUP_STEP_QUERY}=${step}`;
}
