/**
 * Canva controller — `/api/canva/*` on this instance.
 *
 * Grant management goes through Cloud (status / connect-url / disconnect);
 * designs, exports and assets go straight to api.canva.com with the token
 * Cloud mints. Backs the canva-* skills.
 *
 * @module controllers/canva/canva.controller
 */

import type { Request, Response } from 'express';
import { CANVA_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../../services/core/logger.service.js';
import { CanvaTokenService, CanvaError } from '../../services/canva/canva-token.service.js';
import { CanvaService } from '../../services/canva/canva.service.js';

const logger = LoggerService.getInstance().createComponentLogger('CanvaController');

/** The services the handlers use; swappable for tests. */
export interface CanvaControllerDeps {
  tokens: CanvaTokenService;
  canva: CanvaService;
}

let deps: CanvaControllerDeps | null = null;

function getDeps(): CanvaControllerDeps {
  if (!deps) {
    const tokens = CanvaTokenService.getInstance();
    deps = { tokens, canva: new CanvaService({ tokens }) };
  }
  return deps;
}

/**
 * Replace the dependency set (tests).
 *
 * @param next - Deps or null to rebuild lazily
 */
export function setCanvaControllerDeps(next: CanvaControllerDeps | null): void {
  deps = next;
}

function resolveReturnUrl(req: Request): string {
  const explicit = typeof req.query.returnUrl === 'string' ? req.query.returnUrl : '';
  if (/^https?:\/\//i.test(explicit)) return explicit;
  return `${req.protocol}://${req.get('host')}${CANVA_CONSTANTS.SETTINGS_RETURN_PATH}`;
}

function connectUrlOrNull(req: Request): string | null {
  try {
    return getDeps().tokens.buildConnectUrl(resolveReturnUrl(req));
  } catch {
    return null;
  }
}

/**
 * Answer a failure with `{ success:false, error, message, hint }`.
 *
 * @param req - Request (for the connect URL hint)
 * @param res - Response
 * @param err - The failure
 */
export function sendCanvaError(req: Request, res: Response, err: unknown): void {
  const CODES = CANVA_CONSTANTS.ERROR_CODES;
  if (err instanceof CanvaError) {
    let hint: string;
    switch (err.code) {
      case CODES.NOT_CONNECTED:
        hint = connectUrlOrNull(req) ?? 'Sign in to Crewly Cloud (Settings → Cloud), then connect Canva under Settings → Integrations.';
        break;
      case CODES.NOT_LOGGED_IN:
        hint = 'Sign in to Crewly Cloud first (Settings → Cloud).';
        break;
      case CODES.NOT_CONFIGURED:
        hint = 'Crewly Cloud is not configured for Canva; nothing to do on this instance.';
        break;
      case CODES.VALIDATION:
        hint = 'Fix the request and retry.';
        break;
      default:
        hint = err.status === 401 ? 'The Canva token was rejected; retry once — the cache has been cleared.' : 'Canva or Crewly Cloud failed; retry later.';
    }
    res.status(err.status).json({ success: false, error: err.code, message: err.message, hint });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  logger.error('Unexpected Canva failure', { error: message });
  res.status(500).json({ success: false, error: 'internal', message, hint: 'Check the backend log.' });
}

function q(req: Request, name: string): string {
  const v = req.query[name];
  return typeof v === 'string' ? v.trim() : '';
}

function qInt(req: Request, name: string): number | undefined {
  const v = q(req, name);
  return v ? Number.parseInt(v, 10) : undefined;
}

/** GET /api/canva/status */
export async function getStatus(req: Request, res: Response): Promise<void> {
  try {
    res.json({ success: true, data: await getDeps().tokens.status() });
  } catch (err) {
    sendCanvaError(req, res, err);
  }
}

/** GET /api/canva/connect-url — `{ url }` to open in the browser. */
export async function getConnectUrl(req: Request, res: Response): Promise<void> {
  try {
    res.json({ success: true, data: { url: getDeps().tokens.buildConnectUrl(resolveReturnUrl(req)) } });
  } catch (err) {
    sendCanvaError(req, res, err);
  }
}

/** DELETE /api/canva/disconnect */
export async function disconnect(req: Request, res: Response): Promise<void> {
  try {
    res.json({ success: true, data: await getDeps().tokens.disconnect() });
  } catch (err) {
    sendCanvaError(req, res, err);
  }
}

/** GET /api/canva/designs?q=&ownership=&sort=&limit=&continuation= */
export async function listDesigns(req: Request, res: Response): Promise<void> {
  try {
    const ownership = q(req, 'ownership');
    const sort = q(req, 'sort');
    const out = await getDeps().canva.listDesigns({
      query: q(req, 'q') || undefined,
      ownership: ownership === 'owned' || ownership === 'shared' || ownership === 'any' ? ownership : undefined,
      sortBy: (['relevance', 'modified_descending', 'modified_ascending', 'title_descending', 'title_ascending'] as const).find((s) => s === sort),
      limit: qInt(req, 'limit'),
      continuation: q(req, 'continuation') || undefined,
    });
    res.json({ success: true, data: { count: out.designs.length, designs: out.designs, ...(out.continuation ? { continuation: out.continuation } : {}) } });
  } catch (err) {
    sendCanvaError(req, res, err);
  }
}

/** GET /api/canva/designs/:id */
export async function getDesign(req: Request, res: Response): Promise<void> {
  try {
    res.json({ success: true, data: await getDeps().canva.getDesign(String(req.params.id ?? '')) });
  } catch (err) {
    sendCanvaError(req, res, err);
  }
}

/** POST /api/canva/designs — `{ title?, preset?, width?, height?, assetId? }` */
export async function createDesign(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body ?? {}) as { title?: string; preset?: string; width?: number; height?: number; assetId?: string };
    const design = await getDeps().canva.createDesign({ title: body.title, preset: body.preset, width: body.width, height: body.height, assetId: body.assetId });
    logger.info('Canva design created', { id: design.id, title: design.title });
    res.json({ success: true, data: design });
  } catch (err) {
    sendCanvaError(req, res, err);
  }
}

/** POST /api/canva/designs/:id/export — `{ format, quality?, videoQuality?, pages? }` */
export async function exportDesign(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body ?? {}) as { format?: string; quality?: number; videoQuality?: string; pages?: number[] };
    const out = await getDeps().canva.exportDesign({
      designId: String(req.params.id ?? ''),
      format: String(body.format ?? ''),
      quality: body.quality,
      videoQuality: body.videoQuality,
      pages: Array.isArray(body.pages) ? body.pages : undefined,
    });
    res.json({ success: out.status === 'success', data: out });
  } catch (err) {
    sendCanvaError(req, res, err);
  }
}

/** POST /api/canva/assets — `{ name, content (base64) }` */
export async function uploadAsset(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body ?? {}) as { name?: string; content?: string };
    const bytes = typeof body.content === 'string' ? Buffer.from(body.content, 'base64') : Buffer.alloc(0);
    const asset = await getDeps().canva.uploadAsset(String(body.name ?? ''), bytes);
    logger.info('Canva asset uploaded', { id: asset.id, name: asset.name, bytes: bytes.length });
    res.json({ success: true, data: asset });
  } catch (err) {
    sendCanvaError(req, res, err);
  }
}
