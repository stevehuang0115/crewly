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
  queued: 'Waiting',
  running: 'In progress',
  done: 'Done',
  failed: 'Failed',
  pending: 'Finishes automatically later',
  skipped: 'Skipped',
};

/** Runtime ids → owner-facing names. */
export const BUNDLE_RUNTIME_LABELS: Record<string, string> = {
  'crewly-agent': 'Crewly Agent (DeepSeek)',
  'claude-code': 'Claude Code',
  'codex-cli': 'Codex',
  'gemini-cli': 'Gemini CLI',
  'opencode-cli': 'OpenCode',
  'antigravity-cli': 'Antigravity CLI',
};

/** Hosted server tiers → owner-facing names. */
export const BUNDLE_SERVER_TIER_LABELS: Record<string, string> = {
  entry: 'Entry (2 vCPU, 4 GB)',
  standard: 'Standard (4 vCPU, 8 GB)',
  advanced: 'Advanced (8 vCPU, 16 GB)',
};
