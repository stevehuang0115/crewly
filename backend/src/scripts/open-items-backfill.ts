/**
 * Open-items backfill — DRY RUN against a running Crewly
 * (specs/2026-10-01-reply-open-items.md §6).
 *
 * Reads tickets and WorkItems over the local API, and the chat database
 * read-only, then prints the open items the backfill would create. It never
 * changes anything; to apply, call `POST /api/requests/open-items/backfill`
 * with `{"apply": true}` on an instance that runs this version.
 *
 * Usage:
 *   node dist/backend/backend/src/scripts/open-items-backfill.js [--url http://localhost:8787] [--home ~/.crewly] [--json]
 *
 * @module scripts/open-items-backfill
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { readSecretText } from '../services/core/credential-vault.js';
import type { Request } from '../types/v2/request.types.js';
import type { WorkItem } from '../types/v2/work-item.types.js';
import type { Team } from '../types/index.js';
import type { OwnerDecision } from '../types/decision.types.js';
import { OpenItemsService, type OpenItemsChatMessage } from '../services/open-items/open-items.service.js';
import { backfillOpenItems, formatBackfillReport } from '../services/open-items/open-items-backfill.js';

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
  const body = (await res.json()) as { data: T };
  return body.data;
}

/** Run the dry-run and print the report. */
async function main(): Promise<void> {
  if (process.argv.includes('--apply')) {
    console.error('This script only does a dry run. Apply with POST /api/requests/open-items/backfill {"apply": true}.');
    process.exit(2);
  }
  const home = (arg('--home') ?? path.join(os.homedir(), '.crewly')).replace(/^~/, os.homedir());
  const base = arg('--url') ?? 'http://localhost:8787';
  // The token file may be sealed by the credential vault (it opens with this
  // machine's vault key, like `crewly token`).
  const tokenRead = readSecretText(path.join(home, 'api-token'));
  if (tokenRead.status !== 'ok') throw new Error(`Cannot read the API token (${tokenRead.status}); run \`crewly token\` to check.`);
  const token = tokenRead.value.trim();
  const db = new Database(path.join(home, 'chat.db'), { readonly: true, fileMustExist: true });

  const requests = await get<Request[]>(base, token, '/api/requests');
  const workItems = await get<WorkItem[]>(base, token, '/api/task-pool/items');
  const teams = await get<Team[]>(base, token, '/api/teams').catch(() => [] as Team[]);
  let decisions: OwnerDecision[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'owner-decisions.json'), 'utf8')) as { decisions?: OwnerDecision[] };
    decisions = raw.decisions ?? [];
  } catch {
    decisions = [];
  }
  const names = new Map<string, string>();
  for (const t of teams) for (const m of t.members ?? []) if (m.sessionName && m.name) names.set(m.sessionName, m.name);

  // Read-only service: no follow-ups, cards, wakes or notes.
  const service = new OpenItemsService({
    requests: {
      getById: async (id) => requests.find((r) => r.id === id) ?? null,
      listAll: async () => requests,
      update: async () => {
        throw new Error('dry run: no writes');
      },
    },
    listWorkItems: async () => workItems,
    recentDecisionsBy: async (agent, sinceMs) => decisions.filter((d) => d.asker === agent && Date.parse(d.createdAt) >= sinceMs),
    deliverToAgent: async () => false,
    postOwnerNote: async () => false,
    displayName: async (s) => names.get(s) ?? s,
    colleagueNames: async (s) => [...names.entries()].filter(([k]) => k !== s).map(([, v]) => v),
  });

  const stmt = db.prepare(
    `SELECT id, channel_id, sender_type, sender_id, content, created_at, metadata, thread_id
       FROM chat_messages WHERE channel_id = ? AND (id = ? OR thread_id = ?) ORDER BY seq ASC`,
  );
  const report = await backfillOpenItems({
    service,
    listRequests: async () => requests,
    listWorkItems: async () => workItems,
    listThread: async (channelId, rootId) =>
      (stmt.all(channelId, rootId, rootId) as Array<Record<string, unknown>>).map(
        (r): OpenItemsChatMessage => ({
          id: String(r.id),
          channelId: String(r.channel_id),
          senderType: String(r.sender_type),
          senderId: String(r.sender_id),
          content: String(r.content ?? ''),
          createdAt: Number(r.created_at),
          ...(r.thread_id ? { threadId: String(r.thread_id) } : {}),
          ...(r.metadata ? { metadata: JSON.parse(String(r.metadata)) as Record<string, unknown> } : {}),
        }),
      ),
  });
  db.close();
  console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : formatBackfillReport(report));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
