/**
 * Solution bundle constants (frontend): endpoints and polling of the
 * one-step deploy in `/setup` (specs/solution-bundles.md).
 *
 * @module constants/bundle.constants
 */

import type { BundleStepStatus } from '../types/bundle.types';

/** `/api/bundles` endpoints. */
export const BUNDLE_API = {
  /** Ready bundles */
  LIST: '/api/bundles',
  /** One bundle with its questions */
  detail: (templateId: string): string => `/api/bundles/${encodeURIComponent(templateId)}`,
  /** Start (or join) a deploy */
  APPLY: '/api/bundles/apply',
  /** A deploy's progress */
  job: (jobId: string): string => `/api/bundles/apply/${encodeURIComponent(jobId)}`,
} as const;

/** How often the deploy's progress is read. */
export const BUNDLE_POLL_INTERVAL_MS = 1500;

/** Owner-facing state of a step. */
export const BUNDLE_STEP_STATUS_LABELS: Record<BundleStepStatus, string> = {
  queued: '等待',
  running: '进行中',
  done: '完成',
  failed: '出错',
  pending: '稍后自动完成',
  skipped: '跳过',
};

/** Runtime ids → owner-facing names. */
export const BUNDLE_RUNTIME_LABELS: Record<string, string> = {
  'crewly-agent': 'Crewly Agent（DeepSeek）',
  'claude-code': 'Claude Code',
  'codex-cli': 'Codex',
  'gemini-cli': 'Gemini CLI',
  'opencode-cli': 'OpenCode',
};

/** Hosted server tiers → owner-facing names. */
export const BUNDLE_SERVER_TIER_LABELS: Record<string, string> = {
  entry: '入门（2 核 4 GB）',
  standard: '标准（4 核 8 GB）',
  advanced: '进阶（8 核 16 GB）',
};
