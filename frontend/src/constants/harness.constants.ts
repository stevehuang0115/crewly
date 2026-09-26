/**
 * Harness Constants
 *
 * Endpoints, polling cadence, storage keys and display labels for the
 * harness setup flow (`/setup`) and the Settings → Harness tab.
 *
 * @module constants/harness.constants
 */

import type { HarnessId, HarnessLoginMethodId, HarnessLoginState, HarnessStatus, LoginSessionState } from '../types/harness.types';

export const HARNESS_API = {
  /** Status overview: harnesses, orc choice, system tools */
  STATUS: '/api/harness',
  /** Set the orchestrator's harness */
  ORC: '/api/harness/orc',
  /** Start an install job for a harness */
  install: (harnessId: string): string => `/api/harness/${encodeURIComponent(harnessId)}/install`,
  /** Poll an install job */
  installJob: (jobId: string): string => `/api/harness/install/${encodeURIComponent(jobId)}`,
  /** Start a broker login session */
  login: (harnessId: string): string => `/api/harness/${encodeURIComponent(harnessId)}/login`,
  /** Poll a login session */
  loginSession: (sessionId: string): string => `/api/harness/login/${encodeURIComponent(sessionId)}`,
  /** Send text to a login session */
  loginInput: (sessionId: string): string => `/api/harness/login/${encodeURIComponent(sessionId)}/input`,
  /** Cancel a login session */
  loginCancel: (sessionId: string): string => `/api/harness/login/${encodeURIComponent(sessionId)}/cancel`,
  /** Save an API key for a harness */
  apiKey: (harnessId: string): string => `/api/harness/${encodeURIComponent(harnessId)}/api-key`,
} as const;

export const HARNESS_TIMING = {
  /** Install job poll interval */
  INSTALL_POLL_MS: 1_000,
  /** Login session poll interval */
  LOGIN_POLL_MS: 1_500,
  /** How long a "copied" confirmation stays visible */
  COPIED_FEEDBACK_MS: 2_000,
} as const;

/** Harness pre-selected in setup and used as the default orc harness. */
export const DEFAULT_ORC_HARNESS: HarnessId = 'claude-code';

/** Display order of harnesses. */
export const HARNESS_ORDER: readonly HarnessId[] = ['claude-code', 'codex-cli', 'antigravity-cli', 'gemini-cli'];

/** Appended to a retired harness's name (Gemini CLI) wherever it is still listed. */
export const RETIRED_HARNESS_LABEL_SUFFIX = ' (enterprise only)';

/**
 * Display name of a harness; a retired one is marked "(enterprise only)".
 *
 * @param harness - Harness status
 * @returns Label
 */
export function harnessDisplayName(harness: Pick<HarnessStatus, 'displayName' | 'retired'>): string {
  return harness.retired ? `${harness.displayName}${RETIRED_HARNESS_LABEL_SUFFIX}` : harness.displayName;
}

/**
 * Harnesses to show: every current one, plus a retired one (Gemini CLI) only
 * when it is already in use here — installed, or the orchestrator's harness.
 * New users get Antigravity CLI instead.
 *
 * @param harnesses - All harnesses from `GET /api/harness`
 * @param orcHarness - The orchestrator's harness
 * @returns Harnesses to list, in the backend's order
 */
export function visibleHarnesses<T extends HarnessStatus>(harnesses: T[], orcHarness: string | null | undefined): T[] {
  return harnesses.filter((h) => !h.retired || h.installed || h.id === orcHarness);
}

/** Route of the first-run setup flow. */
export const SETUP_ROUTE = '/setup';

/** Route the setup flow finishes on. */
export const SETUP_DONE_ROUTE = '/';

/** Paths the first-run redirect never fires from. */
export const SETUP_REDIRECT_EXEMPT_PREFIXES: readonly string[] = [SETUP_ROUTE, '/auth'];

/** localStorage key set by "稍后再说 / Skip for now" so the setup redirect doesn't loop. */
export const SETUP_SKIP_STORAGE_KEY = 'crewly_setup_skipped';

/** Where each harness's API keys are created. */
export const API_KEY_CONSOLE_URLS: Partial<Record<HarnessId, { url: string; label: string }>> = {
  'claude-code': { url: 'https://console.anthropic.com/settings/keys', label: 'console.anthropic.com' },
  'codex-cli': { url: 'https://platform.openai.com/api-keys', label: 'platform.openai.com' },
  'antigravity-cli': { url: 'https://aistudio.google.com/apikey', label: 'Google AI Studio' },
};

/** Placeholder shown in the key field per harness (falls back to `sk-…`). */
export const API_KEY_PLACEHOLDERS: Partial<Record<HarnessId, string>> = {
  'antigravity-cli': 'AIza…',
};

/**
 * Extra note under a harness's API-key field. Antigravity: Crewly uses only
 * a Gemini API key, never the Google account login (Google does not allow
 * third-party tools to use it), and agy's own settings are switched to it.
 */
export const API_KEY_NOTES: Partial<Record<HarnessId, string>> = {
  'antigravity-cli':
    'Crewly 只用 Gemini API Key 运行 Antigravity，不会用你的 Google 账号登录（Google 不允许第三方工具这样做）。保存后，本机 ~/.gemini/antigravity-cli/settings.json 会切换为 API Key 模式。Crewly runs Antigravity with a Gemini API key only — never your Google account login.',
};

/** Chinese-first labels per `${harnessId}:${methodId}`; falls back to the backend label. */
export const LOGIN_METHOD_LABELS: Record<string, string> = {
  'claude-code:subscription': '用 Claude 订阅登录',
  'claude-code:api_key': '使用 API Key',
  'codex-cli:device': '用 ChatGPT 账号登录',
  'codex-cli:api_key': '使用 OpenAI API Key',
  'antigravity-cli:api_key': '使用 Gemini API Key',
};

/**
 * Label for a login method, preferring the Chinese copy.
 *
 * @param harnessId - Harness id
 * @param methodId - Method id
 * @param fallback - Backend-provided label
 * @returns Display label
 */
export function loginMethodLabel(harnessId: string, methodId: HarnessLoginMethodId, fallback: string): string {
  return LOGIN_METHOD_LABELS[`${harnessId}:${methodId}`] ?? fallback;
}

/** Badge copy + variant for each harness login state. */
export const LOGIN_STATE_BADGES: Record<HarnessLoginState, { label: string; variant: 'success' | 'warning' | 'default' }> = {
  logged_in: { label: '已登录', variant: 'success' },
  logged_out: { label: '未登录', variant: 'warning' },
  unknown: { label: '登录状态未知', variant: 'default' },
};

/** Status line per login session state. */
export const LOGIN_SESSION_STATE_LABELS: Record<LoginSessionState, string> = {
  starting: '正在启动登录…',
  awaiting_user: '等待你完成授权',
  verifying: '正在验证…',
  succeeded: '登录成功',
  failed: '登录失败',
  timed_out: '登录超时',
  cancelled: '已取消',
};

