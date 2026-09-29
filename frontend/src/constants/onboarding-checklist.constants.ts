/**
 * First-run Checklist Constants
 *
 * Endpoints, copy and link builders for the steps after the harness
 * (specs/onboarding-harness-login.md, Phase 3): first team → first task →
 * Crewly Cloud → Slack, on `/setup` and the dashboard "Get started" card.
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

/** Title per checklist step. */
export const CHECKLIST_STEP_LABELS: Record<ChecklistStepId, string> = {
  harness: 'Sign in to a coding harness',
  team: 'Create your first team',
  first_task: 'Give it a first task',
  cloud: 'Connect Crewly Cloud',
  slack: 'Connect Slack',
};

/** One-line hint per checklist step (shown until the step is done). */
export const CHECKLIST_STEP_HINTS: Record<ChecklistStepId, string> = {
  harness: 'Your AI teammates work through it. Install it and sign in first.',
  team: 'Personal Assistant is recommended; you can also pick Marketing or start empty.',
  first_task: 'Tell the team what to do in one sentence.',
  cloud: 'Manage from your phone, automatic backups, and needed for Slack.',
  slack: 'Talk to your team right from Slack.',
};

/** Short labels of the whole `/setup` flow (harness steps + checklist steps). */
export const SETUP_FLOW_STEPS: readonly string[] = ['Harness', 'Orc', 'Sign in', 'Team', 'First task', 'Cloud', 'Slack', 'Done'];

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
