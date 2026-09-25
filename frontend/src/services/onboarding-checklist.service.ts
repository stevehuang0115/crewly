/**
 * Onboarding Checklist Service
 *
 * API client for the first-run checklist (`/api/onboarding/*`), plus the two
 * existing endpoints its steps reuse: `POST /api/cloud/connect` (paste a
 * Crewly Cloud token) and `GET /api/slack/cloud/install-url` (one-click
 * Slack install). Uses the shared axios instance, so the API-token
 * interceptors installed by `bootstrapApiToken()` apply.
 *
 * @module services/onboarding-checklist.service
 */

import axios, { isAxiosError } from 'axios';
import type { ApiResponse } from '../types';
import type {
  FirstTaskResult,
  OnboardingChecklist,
  OnboardingStarter,
  StarterTeamResult,
} from '../types/onboarding-checklist.types';
import { ONBOARDING_API } from '../constants/onboarding-checklist.constants';

/**
 * Run a request, unwrap `{ success, data }` and normalise failures to an
 * `Error` carrying the server's message.
 *
 * @param request - Request thunk
 * @param fallback - Message used when the server gave none
 * @returns The `data` payload
 */
async function call<T>(request: () => Promise<{ data: ApiResponse<T> }>, fallback: string): Promise<T> {
  let body: ApiResponse<T> | undefined;
  try {
    body = (await request()).data;
  } catch (err) {
    if (isAxiosError(err)) {
      const errBody = err.response?.data as ApiResponse<unknown> | undefined;
      throw new Error(errBody?.error || errBody?.message || err.message || fallback);
    }
    throw err instanceof Error ? err : new Error(fallback);
  }
  if (!body?.success || body.data === undefined || body.data === null) {
    throw new Error(body?.error || body?.message || fallback);
  }
  return body.data;
}

/**
 * Client for the checklist endpoints.
 */
class OnboardingChecklistService {
  /**
   * Read every checklist step.
   *
   * @returns The checklist
   */
  async getChecklist(): Promise<OnboardingChecklist> {
    return call(() => axios.get<ApiResponse<OnboardingChecklist>>(ONBOARDING_API.CHECKLIST), '无法读取设置清单');
  }

  /**
   * Hide or show the dashboard card.
   *
   * @param dismissed - True to hide
   * @returns The checklist after the change
   */
  async setDismissed(dismissed: boolean): Promise<OnboardingChecklist> {
    return call(() => axios.post<ApiResponse<OnboardingChecklist>>(ONBOARDING_API.DISMISS, { dismissed }), '操作失败');
  }

  /**
   * List the starter teams.
   *
   * @returns Starters, recommended first, Blank last
   */
  async getStarters(): Promise<OnboardingStarter[]> {
    const data = await call(
      () => axios.get<ApiResponse<{ starters: OnboardingStarter[] }>>(ONBOARDING_API.STARTERS),
      '无法读取团队模板',
    );
    return data.starters;
  }

  /**
   * Create the first team from a starter (or record Blank).
   *
   * @param starterId - Template id or `blank`
   * @returns The team (null for Blank)
   */
  async createStarterTeam(starterId: string): Promise<StarterTeamResult> {
    return call(
      () => axios.post<ApiResponse<StarterTeamResult>>(ONBOARDING_API.STARTER_TEAM, { starterId }),
      '创建团队失败',
    );
  }

  /**
   * Hand the first task to the orchestrator.
   *
   * @param text - The task
   * @param teamId - Team it is for (omit for the orchestrator itself)
   * @returns Delivery result
   */
  async sendFirstTask(text: string, teamId?: string | null): Promise<FirstTaskResult> {
    return call(
      () => axios.post<ApiResponse<FirstTaskResult>>(ONBOARDING_API.FIRST_TASK, { text, ...(teamId ? { teamId } : {}) }),
      '发送失败',
    );
  }

  /**
   * Store a Crewly Cloud token (and refresh token) on this machine.
   *
   * @param token - Access token from the portal
   * @param refreshToken - Refresh token (keeps the login alive)
   * @returns The Cloud tier
   */
  async connectCloud(token: string, refreshToken?: string): Promise<{ tier: string }> {
    return call(
      () =>
        axios.post<ApiResponse<{ tier: string }>>(ONBOARDING_API.CLOUD_CONNECT, {
          token,
          ...(refreshToken ? { refreshToken } : {}),
        }),
      '连接 Crewly Cloud 失败',
    );
  }

  /**
   * One-click Slack install link (needs Crewly Cloud).
   *
   * @param returnUrl - Where Slack sends the owner back to
   * @returns Install URL
   */
  async getSlackInstallUrl(returnUrl: string): Promise<string> {
    const data = await call(
      () =>
        axios.get<ApiResponse<{ url: string }>>(ONBOARDING_API.SLACK_INSTALL_URL, {
          params: { returnUrl },
        }),
      '无法获取 Slack 安装链接',
    );
    return data.url;
  }

  /**
   * Ask the backend to re-read the Slack config from Crewly Cloud and connect
   * a workspace that was just installed (the Slack install's landing step).
   *
   * @returns Whether Slack is connected now
   */
  async refreshSlack(): Promise<{ connected: boolean; cloudConnected: boolean }> {
    return call(
      () =>
        axios.get<ApiResponse<{ connected: boolean; cloudConnected: boolean }>>(ONBOARDING_API.SLACK_CLOUD_STATUS, {
          params: { refresh: '1' },
        }),
      '无法读取 Slack 状态',
    );
  }
}

export const onboardingChecklistService = new OnboardingChecklistService();
