/**
 * Stale open-item follow-ups — DRY RUN by default.
 *
 * Lists the blocked "Follow-up for the owner" WorkItems created in a time
 * window (default: the 2026-10-02 00:04-00:06Z backfill burst) whose promise
 * was already delivered in the same thread, by the live delivery rule. With
 * `--cancel` it cancels exactly those, with a reason. It never touches a
 * follow-up whose thread has no delivery (a genuine miss), and refuses to
 * report success when it examined nothing.
 *
 * Usage:
 *   node dist/backend/backend/src/scripts/open-items-stale-followups.js [--url http://localhost:8787] [--home ~/.crewly]
 *        [--from 2026-10-02T00:04:00Z] [--to 2026-10-02T00:06:59Z] [--cancel]
 *
 * @module scripts/open-items-stale-followups
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { readSecretText } from '../services/core/credential-vault.js';
import { OPEN_ITEMS_CONSTANTS } from '../constants.js';
import type { Request } from '../types/v2/request.types.js';
import type { WorkItem } from '../types/v2/work-item.types.js';
import { OpenItemsService, type OpenItemsChatMessage } from '../services/open-items/open-items.service.js';

/** One examined follow-up. */
export interface StaleRow {
  workItemId: string;
  ticket: string;
  agent: string;
  promise: string;
  /** Delivery message, when found */
  deliveredBy?: string;
  deliveredAt?: string;
  verdict: 'stale-delivered' | 'keep-genuine-miss' | 'keep-unverifiable';
}

/** Result of one run. */
export interface StaleReport {
  examinedItems: number;
  examinedThreads: number;
  rows: StaleRow[];
}

/**
 * Classify the blocked follow-ups in a window.
 *
 * @param input - Requests, pool, thread reader and the window
 * @returns The report
 */
export function classifyStaleFollowUps(input: {
  requests: Request[];
  pool: WorkItem[];
  listThread: (channelId: string, rootId: string) => OpenItemsChatMessage[];
  fromMs: number;
  toMs: number;
  service: Pick<OpenItemsService, 'deliveredBy'>;
}): StaleReport {
  const key = OPEN_ITEMS_CONSTANTS.FOLLOW_UP_METADATA_KEY;
  const rows: StaleRow[] = [];
  const threads = new Set<string>();
  let examined = 0;
  for (const wi of input.pool) {
    const meta = (wi.metadata ?? {}) as Record<string, { requestId?: string; itemId?: string } | undefined>;
    const ref = meta[key];
    const created = Date.parse(wi.createdAt);
    if (!ref || wi.status !== 'blocked' || !(created >= input.fromMs && created <= input.toMs)) continue;
    examined++;
    const request = input.requests.find((r) => r.id === ref.requestId);
    const item = request?.openItems?.find((i) => i.id === ref.itemId);
    const base = { workItemId: wi.id, ticket: request?.ticketNumber ? `TKT-${String(request.ticketNumber).padStart(3, '0')}` : '?', agent: wi.target ?? '?', promise: (item?.text ?? wi.title).slice(0, 100) };
    if (!request?.chatRef || !item) {
      rows.push({ ...base, verdict: 'keep-unverifiable' });
      continue;
    }
    threads.add(`${request.chatRef.channelId}:${request.chatRef.threadRootId}`);
    const thread = input.listThread(request.chatRef.channelId, request.chatRef.threadRootId).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    const delivery = thread.find((m) => m.senderType === 'agent' && input.service.deliveredBy(item, m, input.pool));
    rows.push(
      delivery
        ? { ...base, deliveredBy: delivery.senderId, deliveredAt: new Date(delivery.createdAt ?? 0).toISOString(), verdict: 'stale-delivered' }
        : { ...base, verdict: 'keep-genuine-miss' },
    );
  }
  return { examinedItems: examined, examinedThreads: threads.size, rows };
}

/**
 * Read a flag value.
 *
 * @param name - Flag
 * @returns Value, or undefined
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * GET a Crewly API path.
 *
 * @param base - Base URL
 * @param token - API token
 * @param p - Path
 * @returns `data` of the response
 */
async function get<T>(base: string, token: string, p: string): Promise<T> {
  const res = await fetch(`${base}${p}`, { headers: { 'x-crewly-token': token } });
  if (!res.ok) throw new Error(`GET ${p}: HTTP ${res.status}`);
  return ((await res.json()) as { data: T }).data;
}

/** Run: report, and cancel only with --cancel. */
async function main(): Promise<void> {
  const home = (arg('--home') ?? path.join(os.homedir(), '.crewly')).replace(/^~/, os.homedir());
  const base = arg('--url') ?? 'http://localhost:8787';
  // The token file may be sealed by the credential vault (it opens with this
  // machine's vault key, like `crewly token`).
  const tokenRead = readSecretText(path.join(home, 'api-token'));
  if (tokenRead.status !== 'ok') throw new Error(`Cannot read the API token (${tokenRead.status}); run \`crewly token\` to check.`);
  const token = tokenRead.value.trim();
  const db = new Database(path.join(home, 'chat.db'), { readonly: true, fileMustExist: true });
  const requests = await get<Request[]>(base, token, '/api/requests');
  const pool = await get<WorkItem[]>(base, token, '/api/task-pool/items');
  const stmt = db.prepare(
    `SELECT id, channel_id, sender_type, sender_id, content, created_at, thread_id
       FROM chat_messages WHERE channel_id = ? AND (id = ? OR thread_id = ?) ORDER BY seq ASC`,
  );
  const service = new OpenItemsService({
    requests: { getById: async () => null, listAll: async () => requests, update: async () => { throw new Error('read only'); } },
    listWorkItems: async () => pool,
    recentDecisionsBy: async () => [],
    deliverToAgent: async () => false,
    postOwnerNote: async () => false,
    displayName: async (s) => s,
  });
  const report = classifyStaleFollowUps({
    requests,
    pool,
    fromMs: Date.parse(arg('--from') ?? '2026-10-02T00:04:00Z'),
    toMs: Date.parse(arg('--to') ?? '2026-10-02T00:06:59Z'),
    service,
    listThread: (channelId, rootId) =>
      (stmt.all(channelId, rootId, rootId) as Array<Record<string, unknown>>).map((r): OpenItemsChatMessage => ({
        id: String(r.id),
        channelId: String(r.channel_id),
        senderType: String(r.sender_type),
        senderId: String(r.sender_id),
        content: String(r.content ?? ''),
        createdAt: Number(r.created_at),
        ...(r.thread_id ? { threadId: String(r.thread_id) } : {}),
      })),
  });
  db.close();
  if (report.examinedItems === 0) {
    console.error('NO FOLLOW-UPS EXAMINED — refusing to report success (check --from/--to and --url).');
    process.exit(1);
  }
  const stale = report.rows.filter((r) => r.verdict === 'stale-delivered');
  console.log(`${process.argv.includes('--cancel') ? 'CANCELLING' : 'DRY RUN'}: ${report.examinedItems} follow-up(s) examined across ${report.examinedThreads} thread(s). Stale (already delivered): ${stale.length}. Kept: ${report.rows.length - stale.length}.`);
  for (const r of report.rows) {
    console.log(`${r.verdict.padEnd(18)} ${r.ticket} ${r.workItemId.slice(0, 8)} ${r.agent} "${r.promise}"${r.deliveredAt ? ` — delivered by ${r.deliveredBy} at ${r.deliveredAt}` : ''}`);
  }
  if (!process.argv.includes('--cancel')) return;
  for (const r of stale) {
    const res = await fetch(`${base}/api/task-pool/items/${r.workItemId}/cancel`, {
      method: 'POST',
      headers: { 'x-crewly-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: `Stale follow-up: the promise was already delivered by ${r.deliveredBy} at ${r.deliveredAt} (open-items fix)` }),
    });
    console.log(`cancel ${r.workItemId.slice(0, 8)}: HTTP ${res.status}`);
  }
}

if (process.argv[1] && /open-items-stale-followups\.(js|ts)$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
