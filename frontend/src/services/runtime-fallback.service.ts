/**
 * Runtime Fallback Service
 *
 * API client for the runtime fallback (`/api/system/runtime-fallback`) and
 * the runtime smoke test (`/api/system/runtime-smoke-test`). Uses the shared
 * axios instance, so the API-token interceptors apply.
 *
 * specs/2026-10-01-runtime-fallback.md
 *
 * @module services/runtime-fallback.service
 */

import axios, { isAxiosError } from 'axios';
import type { ApiResponse } from '../types';

/** Endpoints. */
export const RUNTIME_FALLBACK_API = {
  STATE: '/api/system/runtime-fallback',
  SETTINGS: '/api/system/runtime-fallback/settings',
  SMOKE: '/api/system/runtime-smoke-test',
  smokeJob: (jobId: string) => `/api/system/runtime-smoke-test/${encodeURIComponent(jobId)}`,
} as const;

/** Owner-editable settings. */
export interface RuntimeFallbackSettings {
  enabled: boolean;
  chain: string[];
  memberChains: Record<string, string[]>;
  orcFollows: boolean;
  crewlyAgentModel: string;
  probeIntervalMinutes: number;
}

/** One runtime as a fallback target. */
export interface RuntimeAvailability {
  runtime: string;
  label: string;
  selectable: boolean;
  reason?: string;
  /** Out of usage on this machine right now */
  exhausted: boolean;
}

/** A runtime out of usage. */
export interface ExhaustedRuntime {
  runtime: string;
  since: string;
  until?: string;
  ruleId: string;
  switched: string[];
  switchedTo: string[];
  notified: boolean;
  noFallback?: boolean;
}

/** An agent running on a fallback. */
export interface RuntimeOverrideView {
  sessionName: string;
  runtime: string;
  primary: string;
  reason: 'usage_limit';
  since: string;
  until?: string;
  revertPending?: boolean;
  badge: string;
  runtimeLabel: string;
  primaryLabel: string;
}

/** `GET /api/system/runtime-fallback`. */
export interface RuntimeFallbackState {
  settings: RuntimeFallbackSettings;
  runtimes: RuntimeAvailability[];
  exhausted: ExhaustedRuntime[];
  overrides: RuntimeOverrideView[];
}

/** Smoke test step. */
export type SmokeStep = 'create_team' | 'start_member' | 'agent_ready' | 'send_task' | 'bash' | 'reply' | 'cleanup';

/** Smoke test result. */
export interface SmokeTestResult {
  runtime: string;
  passed: boolean;
  failedStep?: SmokeStep;
  error?: string;
  steps: Array<{ step: SmokeStep; ok: boolean; ms: number; detail?: string }>;
  screen?: string;
  durationMs: number;
}

/** Smoke test job. */
export interface SmokeTestJob {
  jobId: string;
  runtime: string;
  state: 'running' | 'done';
  startedAt: string;
  result?: SmokeTestResult;
}

/**
 * Run a request and unwrap `{ success, data }`, surfacing the server's error.
 *
 * @param request - Request thunk
 * @param fallback - Message when the server gave none
 * @returns The payload
 */
async function call<T>(request: () => Promise<{ data: ApiResponse<T> }>, fallback: string): Promise<T> {
  try {
    const { data: body } = await request();
    if (!body?.success || body.data === undefined || body.data === null) throw new Error(body?.error || fallback);
    return body.data;
  } catch (err) {
    if (isAxiosError(err)) {
      const body = err.response?.data as ApiResponse<unknown> | undefined;
      throw new Error(body?.error || err.message || fallback);
    }
    throw err instanceof Error ? err : new Error(fallback);
  }
}

/** Client. */
export const runtimeFallbackService = {
  /**
   * Settings, availability, exhausted runtimes and overrides.
   *
   * @returns State
   */
  getState(): Promise<RuntimeFallbackState> {
    return call(() => axios.get<ApiResponse<RuntimeFallbackState>>(RUNTIME_FALLBACK_API.STATE), 'Failed to load runtime fallback');
  },

  /**
   * Save a partial settings update.
   *
   * @param patch - Fields to change
   * @returns The new state
   */
  updateSettings(patch: Partial<RuntimeFallbackSettings>): Promise<RuntimeFallbackState> {
    return call(() => axios.put<ApiResponse<RuntimeFallbackState>>(RUNTIME_FALLBACK_API.SETTINGS, patch), 'Failed to save fallback settings');
  },

  /**
   * Start a smoke test for a runtime.
   *
   * @param runtime - Runtime id
   * @returns The job
   */
  startSmokeTest(runtime: string): Promise<SmokeTestJob> {
    return call(() => axios.post<ApiResponse<SmokeTestJob>>(RUNTIME_FALLBACK_API.SMOKE, { runtime }), 'Failed to start the test');
  },

  /**
   * Read a smoke test job.
   *
   * @param jobId - Job id
   * @returns The job
   */
  getSmokeTest(jobId: string): Promise<SmokeTestJob> {
    return call(() => axios.get<ApiResponse<SmokeTestJob>>(RUNTIME_FALLBACK_API.smokeJob(jobId)), 'Failed to read the test');
  },
};
