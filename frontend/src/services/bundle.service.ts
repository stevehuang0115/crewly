/**
 * Bundle Service
 *
 * API client for solution bundles (`/api/bundles`): read a bundle with its
 * questions, deploy it, follow the deploy. Uses the shared axios instance,
 * so the API-token interceptors apply (LAN / phone).
 *
 * @module services/bundle.service
 */

import axios, { isAxiosError } from 'axios';
import type { ApiResponse } from '../types';
import type { BundleAnswerProblem, BundleAnswers, BundleDeployment, BundleDetail } from '../types/bundle.types';
import { BUNDLE_API } from '../constants/bundle.constants';

/** A refused request, with the questions the owner still has to answer. */
export class BundleRequestError extends Error {
  /**
   * @param message - Server (or fallback) message
   * @param code - Server error code, if any
   * @param missing - Required questions without an answer
   * @param invalid - Answers that do not fit
   */
  constructor(
    message: string,
    readonly code: string | null = null,
    readonly missing: BundleAnswerProblem[] = [],
    readonly invalid: BundleAnswerProblem[] = [],
  ) {
    super(message);
    this.name = 'BundleRequestError';
  }
}

/** Error body of `/api/bundles`. */
type BundleErrorBody = { error?: string; code?: string; missing?: BundleAnswerProblem[]; invalid?: BundleAnswerProblem[] };

/**
 * Run a request and unwrap `{ success, data }`.
 *
 * @param request - Request thunk
 * @param fallback - Message when the server gave none
 * @returns The `data` payload
 * @throws BundleRequestError
 */
async function call<T>(request: () => Promise<{ data: ApiResponse<T> }>, fallback: string): Promise<T> {
  let body: ApiResponse<T> | undefined;
  try {
    body = (await request()).data;
  } catch (err) {
    if (isAxiosError(err)) {
      const e = (err.response?.data ?? {}) as BundleErrorBody;
      throw new BundleRequestError(e.error || err.message || fallback, e.code ?? null, e.missing ?? [], e.invalid ?? []);
    }
    throw err instanceof Error ? err : new BundleRequestError(fallback);
  }
  if (!body?.success || body.data === undefined || body.data === null) {
    throw new BundleRequestError(body?.error || fallback);
  }
  return body.data;
}

/**
 * Client for the bundle endpoints.
 */
class BundleService {
  /**
   * A bundle with its questions, and this machine's deployment of it.
   *
   * @param templateId - Bundle template id
   * @returns Detail and deployment (null when never deployed)
   */
  async getBundle(templateId: string): Promise<{ bundle: BundleDetail; deployment: BundleDeployment | null }> {
    return call(
      () => axios.get<ApiResponse<{ bundle: BundleDetail; deployment: BundleDeployment | null }>>(BUNDLE_API.detail(templateId)),
      '无法读取这个方案',
    );
  }

  /**
   * Deploy a bundle (or join the deploy already running).
   *
   * @param templateId - Bundle template id
   * @param answers - Answers by question id
   * @param runtime - Runtime override (optional)
   * @returns The deployment, with its job id
   */
  async apply(templateId: string, answers: BundleAnswers, runtime?: string): Promise<BundleDeployment> {
    const data = await call(
      () =>
        axios.post<ApiResponse<{ jobId: string; deployment: BundleDeployment }>>(BUNDLE_API.APPLY, {
          templateId,
          answers,
          ...(runtime ? { runtime } : {}),
        }),
      '部署失败',
    );
    return data.deployment;
  }

  /**
   * A deploy's progress.
   *
   * @param jobId - Job id
   * @returns The deployment
   */
  async getJob(jobId: string): Promise<BundleDeployment> {
    return call(() => axios.get<ApiResponse<BundleDeployment>>(BUNDLE_API.job(jobId)), '无法读取部署进度');
  }
}

export const bundleService = new BundleService();
