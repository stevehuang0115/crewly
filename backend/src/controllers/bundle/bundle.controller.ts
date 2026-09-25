/**
 * Solution bundle controller — REST handlers for `/api/bundles`
 * (specs/solution-bundles.md).
 *
 * Every response is `{ success: true, data }` or
 * `{ success: false, error, code?, missing?, invalid? }`.
 *
 * Owner-only: applying a bundle and reading an apply job refuse a request
 * that carries `X-Agent-Session` (403), like `/api/harness` and the setup
 * checklist — an agent must not deploy teams, schedules and channels in the
 * owner's name. The catalog reads stay open.
 *
 * @module controllers/bundle/bundle.controller
 */

import type { Request, Response } from 'express';
import { refuseAgent } from '../harness/harness.controller.js';
import { BundleError, type BundleApplyService, type BundleErrorCode } from '../../services/bundle/bundle-apply.service.js';
import { toBundleDetail, toBundleSummary, type BundleCatalog } from '../../services/bundle/bundle-catalog.js';

/** HTTP status per engine error code. */
const ERROR_STATUS: Record<BundleErrorCode, number> = {
  unknown_bundle: 404,
  job_not_found: 404,
  bundle_not_ready: 409,
  invalid_runtime: 400,
  invalid_answers: 400,
};

/** What the handlers need. */
export interface BundleControllerDeps {
  service(): BundleApplyService;
  catalog(): Pick<BundleCatalog, 'list' | 'get'>;
}

/** The handlers. */
export interface BundleController {
  list(req: Request, res: Response): Promise<void>;
  detail(req: Request, res: Response): Promise<void>;
  apply(req: Request, res: Response): Promise<void>;
  getJob(req: Request, res: Response): Promise<void>;
}

/**
 * Send an error response.
 *
 * @param res - Response
 * @param error - Thrown value
 */
export function sendBundleError(res: Response, error: unknown): void {
  if (error instanceof BundleError) {
    res.status(ERROR_STATUS[error.code] ?? 400).json({
      success: false,
      error: error.message,
      code: error.code,
      ...(error.details ? { missing: error.details.missing, invalid: error.details.invalid } : {}),
    });
    return;
  }
  res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
}

/**
 * A route parameter as a string.
 *
 * @param req - Request
 * @param name - Parameter
 * @returns Value ('' when absent)
 */
function param(req: Request, name: string): string {
  const value = req.params[name];
  return typeof value === 'string' ? value : '';
}

/**
 * Build the handlers.
 *
 * @param deps - Engine and catalog accessors (tests inject fakes)
 * @returns Handlers
 */
export function createBundleController(deps: BundleControllerDeps): BundleController {
  return {
    /** GET / — ready bundles (`?drafts=1` includes drafts) */
    async list(req, res) {
      try {
        const includeDrafts = req.query.drafts === '1' || req.query.drafts === 'true';
        const bundles = deps.catalog().list({ includeDrafts }).map((b) => toBundleSummary(b.template));
        res.json({ success: true, data: { bundles } });
      } catch (error) {
        sendBundleError(res, error);
      }
    },

    /** GET /:templateId — questions, members, what gets set up, and this machine's deployment */
    async detail(req, res) {
      try {
        const id = param(req, 'templateId');
        const entry = deps.catalog().get(id);
        if (!entry) throw new BundleError('unknown_bundle', `没有找到方案「${id}」`);
        const deployment = await deps.service().getDeployment(id);
        res.json({ success: true, data: { bundle: toBundleDetail(entry.template), deployment } });
      } catch (error) {
        sendBundleError(res, error);
      }
    },

    /** POST /apply { templateId, answers, runtime?, allowDraft? } — start (or join) an apply job; 202 */
    async apply(req, res) {
      if (refuseAgent(req, res, 'deploy a solution bundle')) return;
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const templateId = typeof body.templateId === 'string' ? body.templateId.trim() : '';
        if (!templateId) throw new BundleError('unknown_bundle', 'templateId is required');
        const deployment = await deps.service().start({
          templateId,
          answers: body.answers,
          runtime: typeof body.runtime === 'string' && body.runtime ? body.runtime : undefined,
          allowDraft: body.allowDraft === true,
        });
        res.status(202).json({ success: true, data: { jobId: deployment.jobId, deployment } });
      } catch (error) {
        sendBundleError(res, error);
      }
    },

    /** GET /apply/:jobId — progress of an apply job */
    async getJob(req, res) {
      if (refuseAgent(req, res, 'read a bundle deployment')) return;
      try {
        res.json({ success: true, data: await deps.service().getJob(param(req, 'jobId')) });
      } catch (error) {
        sendBundleError(res, error);
      }
    },
  };
}
