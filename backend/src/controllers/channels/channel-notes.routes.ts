/**
 * Channel notes API (specs/2026-11-23-channel-pages.md).
 *
 * - `GET  /api/channel-notes/:ref` — the page of a room `{ channel, page }`
 * - `POST /api/channel-notes/:ref` — change it `{ lead?, purpose?, cover?: "<name>: <what>", uncover?, notes? }`
 *
 * `:ref` is the room's chat id or its name (`#necina`). Any agent in a room
 * may record what a person said there about who leads it or covers what;
 * the caller is written to the page.
 *
 * @module controllers/channels/channel-notes.routes
 */

import { Router, type Request, type Response } from 'express';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import { readChannelPage, writeChannelPage, type ChannelPagePatch } from '../../services/wiki/channel-page.js';

/** What the router needs from the server. */
export interface ChannelNotesRouterDeps {
  /** A room by chat id or name; null when unknown on this machine */
  findRoom: (ref: string) => { id: string; name: string } | null;
  /** Global vault root */
  vaultPath: () => string;
}

/**
 * Split `"<name>: <what>"` into its parts.
 *
 * @param value - The cover line as typed (a full-width colon is accepted)
 * @returns The parts, or null when either is missing
 *
 * @example
 * ```ts
 * parseCoverLine('Atlas: the Saturday talk'); // { who: 'Atlas', what: 'the Saturday talk' }
 * ```
 */
export function parseCoverLine(value: string): { who: string; what: string } | null {
  const at = value.search(/[:：]/);
  if (at <= 0) return null;
  const who = value.slice(0, at).trim();
  const what = value.slice(at + 1).trim();
  return who && what ? { who, what } : null;
}

/**
 * Read a change from a request body.
 *
 * @param body - Request body
 * @returns The patch, or an error message when a field is malformed or nothing is set
 */
export function patchFromBody(body: unknown): { patch: ChannelPagePatch } | { error: string } {
  const input = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const patch: ChannelPagePatch = {};
  for (const key of ['lead', 'purpose', 'notes', 'uncover'] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string') return { error: `${key} must be text` };
    patch[key] = input[key] as string;
  }
  if (input['cover'] !== undefined) {
    const cover = typeof input['cover'] === 'string' ? parseCoverLine(input['cover']) : null;
    if (!cover) return { error: 'cover must be "<name>: <what they cover>"' };
    patch.cover = cover;
  }
  if (Object.keys(patch).length === 0) return { error: 'Nothing to change: pass lead, purpose, cover, uncover or notes' };
  return { patch };
}

/**
 * Build the router.
 *
 * @param deps - Server hooks
 * @returns Router for `/api/channel-notes`
 */
export function createChannelNotesRouter(deps: ChannelNotesRouterDeps): Router {
  const router = Router();

  /** Resolve the room of a request, answering 404 when it is unknown. */
  const roomOf = (req: Request, res: Response): { id: string; name: string } | null => {
    const room = deps.findRoom(decodeURIComponent(req.params.ref ?? '').trim());
    if (!room) res.status(404).json({ success: false, error: 'not_found', message: `No room "${req.params.ref}" on this machine` });
    return room;
  };

  router.get('/:ref', async (req: Request, res: Response) => {
    const room = roomOf(req, res);
    if (!room) return;
    res.json({ success: true, data: { channel: room, page: await readChannelPage(deps.vaultPath(), room.name) } });
  });

  router.post('/:ref', async (req: Request, res: Response) => {
    const room = roomOf(req, res);
    if (!room) return;
    const parsed = patchFromBody(req.body);
    if ('error' in parsed) {
      res.status(400).json({ success: false, error: 'invalid', message: parsed.error });
      return;
    }
    try {
      const page = await writeChannelPage(deps.vaultPath(), room, parsed.patch, readAgentSessionHeader(req) ?? 'owner');
      res.json({ success: true, data: { channel: room, page } });
    } catch (err) {
      res.status(500).json({ success: false, error: 'write_failed', message: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
