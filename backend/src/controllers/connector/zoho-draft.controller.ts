/**
 * POST /api/connectors/zoho/draft — agents save a Zoho draft, nothing else.
 *
 * Agents only, and only roles allowed on the Zoho connector. The body is
 * passed through a whitelist; `mode` (and anything else not listed in
 * {@link ../../services/connector/zoho-draft.service}) is ignored, so the
 * only thing this endpoint can do is create a draft (CREW-400).
 *
 * @module controllers/connector/zoho-draft.controller
 */

import type { Request, Response } from 'express';
import { LoggerService } from '../../services/core/logger.service.js';
import { getCallerIdentity } from '../../middleware/caller-identity.middleware.js';
import { resolveAgentCaller } from '../../utils/agent-caller.utils.js';
import { ConnectorAccessService } from '../../services/connector/connector-access.service.js';
import { RemoteMcpService, remoteMcpConnectorId } from '../../services/connector/remote-mcp.service.js';
import { saveZohoDraft, ZohoDraftError, type ZohoDraftInput } from '../../services/connector/zoho-draft.service.js';

const logger = LoggerService.getInstance().createComponentLogger('ZohoDraftController');

/** Collaborators (tests inject). */
export const zohoDraftDeps = {
  save: saveZohoDraft as (input: ZohoDraftInput) => Promise<{ accountId: string; result: unknown }>,
  zohoId: async (): Promise<string | undefined> => {
    const servers = await RemoteMcpService.getInstance().list();
    return (servers.find((s) => s.provider === 'zoho') ?? servers.find((s) => s.id === 'zoho'))?.id;
  },
  isAllowed: (id: string, role: string): Promise<boolean> => ConnectorAccessService.getInstance().isAllowed(remoteMcpConnectorId(id), role),
};

/**
 * @param req - Agent request with the draft fields
 * @param res - `{ success, drafted: true }` or an error
 */
export async function saveZohoDraftHandler(req: Request, res: Response): Promise<void> {
  if (getCallerIdentity(req).kind !== 'agent') {
    res.status(403).json({ success: false, error: 'agents_only', message: 'This endpoint is for Crewly agents.' });
    return;
  }
  const caller = await resolveAgentCaller(req);
  try {
    const id = await zohoDraftDeps.zohoId();
    if (!id) {
      res.status(404).json({ success: false, error: 'No Zoho connector is set up on this machine.' });
      return;
    }
    if (!(await zohoDraftDeps.isAllowed(id, caller.role || 'unknown'))) {
      res.status(403).json({ success: false, error: `Your role (${caller.role}) may not use Zoho.` });
      return;
    }
    const out = await zohoDraftDeps.save((req.body ?? {}) as ZohoDraftInput);
    logger.info('Zoho draft saved for agent', { session: caller.session });
    res.status(202).json({ success: true, drafted: true, sent: false, accountId: out.accountId, detail: out.result });
  } catch (err) {
    const status = err instanceof ZohoDraftError ? err.status : 500;
    res.status(status).json({ success: false, error: err instanceof Error ? err.message : 'draft failed' });
  }
}
