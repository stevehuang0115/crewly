/**
 * Owner receipt API (#828) — `/api/owner-receipt`.
 *
 * The dashboard reads the same data the nightly Slack DM is made from. The
 * owner (not an agent) may change the settings and send one now: a call
 * carrying `X-Agent-Session` is refused for those, so an agent cannot turn the
 * owner's receipt off or DM him on demand.
 *
 * @module controllers/owner-receipt/owner-receipt.controller
 */

import type { Request as ExpressRequest, Response } from 'express';
import { getOwnerReceiptService, type OwnerReceiptService } from '../../services/v3/owner-receipt/owner-receipt.service.js';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';

/**
 * The wired service, or a 503.
 *
 * @param res - Response for the 503
 * @returns Service or null after responding
 */
function serviceOr503(res: Response): OwnerReceiptService | null {
  const svc = getOwnerReceiptService();
  if (!svc) {
    res.status(503).json({ success: false, error: 'Owner receipt is not ready' });
    return null;
  }
  return svc;
}

/**
 * Refuse agents for owner-only actions.
 *
 * @param req - Request
 * @param res - Response for the 403
 * @returns True when refused (response written)
 */
function refuseAgent(req: ExpressRequest, res: Response): boolean {
  if (!readAgentSessionHeader(req)) return false;
  res.status(403).json({ success: false, error: 'Only the owner can change or send the receipt' });
  return true;
}

/**
 * One query value as a string.
 *
 * @param v - Raw query value
 * @returns String or undefined
 */
function q(v: unknown): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.trim() ? s.trim() : undefined;
}

/**
 * GET /api/owner-receipt?from=&to=&mode= — the receipt data and its text.
 * Default window: since the last receipt (the local day for the first one).
 *
 * @param req - Express request
 * @param res - Express response
 */
export async function getReceipt(req: ExpressRequest, res: Response): Promise<void> {
  const svc = serviceOr503(res);
  if (!svc) return;
  const from = q(req.query.from);
  const to = q(req.query.to);
  const mode = q(req.query.mode);
  for (const [name, v] of [['from', from], ['to', to]] as const) {
    if (v && Number.isNaN(Date.parse(v))) {
      res.status(400).json({ success: false, error: `\`${name}\` must be an ISO date-time` });
      return;
    }
  }
  if (mode && mode !== 'since_last_receipt' && mode !== 'local_day') {
    res.status(400).json({ success: false, error: '`mode` must be since_last_receipt or local_day' });
    return;
  }
  try {
    const { data, text } = await svc.generate({
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(mode ? { mode: mode as 'since_last_receipt' | 'local_day' } : {}),
    });
    res.json({ success: true, data: { receipt: data, text } });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

/**
 * GET /api/owner-receipt/settings — settings and when the last one went out.
 *
 * @param _req - Express request
 * @param res - Express response
 */
export async function getReceiptSettings(_req: ExpressRequest, res: Response): Promise<void> {
  const svc = serviceOr503(res);
  if (!svc) return;
  const state = await svc.getState();
  res.json({ success: true, data: { settings: state.settings, lastSentAt: state.lastSentAt ?? null } });
}

/**
 * PUT /api/owner-receipt/settings — `{ enabled?, time?: "HH:MM", timezone? }`.
 *
 * @param req - Express request
 * @param res - Express response
 */
export async function updateReceiptSettings(req: ExpressRequest, res: Response): Promise<void> {
  if (refuseAgent(req, res)) return;
  const svc = serviceOr503(res);
  if (!svc) return;
  const result = await svc.updateSettings(req.body ?? {});
  if (!result.ok) {
    res.status(400).json({ success: false, error: result.error });
    return;
  }
  res.json({ success: true, data: { settings: result.settings } });
}

/**
 * POST /api/owner-receipt/send — send the receipt now (and move the window).
 *
 * @param req - Express request
 * @param res - Express response
 */
export async function sendReceiptNow(req: ExpressRequest, res: Response): Promise<void> {
  if (refuseAgent(req, res)) return;
  const svc = serviceOr503(res);
  if (!svc) return;
  try {
    const result = await svc.send();
    if (result.sent) {
      res.json({ success: true, data: { sent: true, askCount: result.data.askCount, window: result.data.window } });
      return;
    }
    if (result.reason === 'nothing_to_say') {
      // Nothing done worth telling and nothing waiting on the owner: skipped, not failed.
      res.json({ success: true, data: { sent: false, skipped: true, reason: result.reason, window: result.data.window } });
      return;
    }
    res.status(result.reason === 'no_sender' ? 503 : 502).json({
      success: false,
      error: result.reason === 'no_sender' ? 'Slack is not connected; nothing was sent' : 'Slack did not accept the message',
      code: result.reason,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}
