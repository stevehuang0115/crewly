/**
 * Approval activity for Settings › Security.
 *
 * - `GET /api/security/approvals?days=7|30` — read-only: what agents asked
 *   the owner to allow, what was held for the owner (browser actions,
 *   WhatsApp replies, Gmail sends) and how each ended, with counts. See
 *   {@link ApprovalActivityService} for the sources and what is not tracked.
 *
 * @module controllers/security/approvals.controller
 */

import { existsSync } from 'fs';
import type { Request, Response, Router } from 'express';
import { ApprovalActivityService, parseActivityDays, type ApprovalActivityDeps } from '../../services/security/approval-activity.service.js';
import { DecisionService } from '../../services/decisions/decision.service.js';
import { BrowserApprovalService } from '../../services/browser/browser-approval.service.js';
import { getDefaultInboxDbPath, getWhatsAppInboxStore } from '../../services/whatsapp/whatsapp-inbox.store.js';
import { listHeldSends } from '../../services/google/gmail-send-gate.js';
import { StorageService } from '../../services/core/storage.service.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';

/** Most WhatsApp drafts read per request. */
const MAX_DRAFTS = 1000;

/**
 * Collaborators from the process singletons, with the session → name map.
 *
 * @returns Deps
 */
export async function defaultApprovalActivityDeps(): Promise<ApprovalActivityDeps> {
  const names = new Map<string, string>([[ORCHESTRATOR_SESSION_NAME, 'Orc']]);
  try {
    for (const t of await StorageService.getInstance().getTeams()) {
      for (const m of t.members ?? []) if (m.sessionName) names.set(m.sessionName, m.name || m.sessionName);
    }
  } catch {
    // Names are a nicety; sessions are shown otherwise.
  }
  return {
    decisions: async (sinceMs) => (await DecisionService.getInstance()?.listSince(sinceMs)) ?? [],
    browserHolds: async (sinceMs) => {
      const svc = BrowserApprovalService.getInstance();
      return svc ? svc.listHeld(sinceMs) : null;
    },
    whatsappDrafts: async (sinceMs) => {
      // Don't create the inbox database just to read it.
      if (!existsSync(getDefaultInboxDbPath())) return null;
      return getWhatsAppInboxStore()
        .listDrafts({ limit: MAX_DRAFTS })
        .filter((d) => d.status === 'pending' || d.createdAt >= sinceMs);
    },
    gmailHeld: () => listHeldSends(),
    nameOf: (session) => names.get(session),
  };
}

/**
 * Register the route.
 *
 * @param router - API router (mounted at `/api`)
 * @param makeDeps - Collaborators (tests inject fakes)
 */
export function registerSecurityRoutes(router: Router, makeDeps: () => Promise<ApprovalActivityDeps> = defaultApprovalActivityDeps): void {
  router.get('/security/approvals', async (req: Request, res: Response) => {
    try {
      const svc = new ApprovalActivityService(await makeDeps());
      res.json({ success: true, data: await svc.query(parseActivityDays(req.query.days)) });
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
