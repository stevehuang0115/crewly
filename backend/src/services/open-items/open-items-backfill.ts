/**
 * One-off backfill: scan tickets for promises of the last 24h for commitments and
 * questions their agents left open before open-item tracking existed
 * (specs/2026-10-01-reply-open-items.md §6). Dry-run by default: it reports
 * what it WOULD create and changes nothing.
 *
 * An item already settled by the conversation is skipped:
 * - a commitment the agent (or the child's agent) delivered later in the
 *   thread, by the live delivery rule;
 * - a question the owner replied to later in the thread.
 *
 * @module services/open-items/open-items-backfill
 */

import { OPEN_ITEMS_CONSTANTS } from '../../constants.js';
import type { Request } from '../../types/v2/request.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { formatTicketNumber } from '../../types/v2/ticket.types.js';
import { childrenState, childWorkFor, isSameItem, type OpenItemsChatMessage, type OpenItemsService, type PlannedOpenItem } from './open-items.service.js';

/** Readers the backfill needs. */
export interface BackfillDeps {
  service: Pick<OpenItemsService, 'plan' | 'adopt' | 'deliveredBy' | 'findRequestFor'>;
  listRequests: () => Promise<Request[]>;
  listWorkItems: () => Promise<WorkItem[]>;
  /** Every message of a conversation thread (root + replies), oldest first */
  listThread: (channelId: string, rootId: string) => Promise<OpenItemsChatMessage[]>;
  now?: () => Date;
}

/** One row of the report. */
export interface BackfillRow {
  requestId: string;
  ticket: string;
  requestStatus: string;
  agent: string;
  type: 'commitment' | 'question';
  text: string;
  /** When the agent said it */
  at: string;
  /** What the backfill does with it */
  action: string;
  /** Commitment: due time */
  due?: string;
  /** Commitment: child work it waits on (id: status) */
  children?: string[];
  /** Why it is skipped (already settled) */
  skipped?: string;
}

/** The report. */
export interface BackfillReport {
  dryRun: boolean;
  scanned: number;
  rows: BackfillRow[];
  /** Tickets that would move from done to awaiting_followup */
  reopened: string[];
}

/**
 * Run the backfill.
 *
 * @param deps - Readers and the service
 * @param opts - `apply: true` to make the changes (default: dry-run)
 * @returns What it found (and, when applied, did)
 */
export async function backfillOpenItems(deps: BackfillDeps, opts: { apply?: boolean } = {}): Promise<BackfillReport> {
  const apply = opts.apply === true;
  const now = (deps.now ?? (() => new Date()))();
  // Only promises from the last day: an older one was either delivered or is
  // too stale to chase the owner about.
  const since = now.getTime() - OPEN_ITEMS_CONSTANTS.BACKFILL_MAX_AGE_MS;
  const allRequests = await deps.listRequests();
  const requests = allRequests.filter(
    (r) => typeof r.ticketNumber === 'number' && !!r.chatRef && r.status !== 'cancelled' && Date.parse(r.updatedAt) >= now.getTime() - OPEN_ITEMS_CONSTANTS.LOOKBACK_MS,
  );
  const pool = await deps.listWorkItems();
  const report: BackfillReport = { dryRun: !apply, scanned: requests.length, rows: [], reopened: [] };

  for (const request of requests) {
    const ref = request.chatRef!;
    const thread = (await deps.listThread(ref.channelId, ref.threadRootId)).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    const ticket = formatTicketNumber(request.ticketNumber!);
    const keep: PlannedOpenItem[] = [];
    for (const message of thread) {
      if (message.senderType !== 'agent' || Date.parse(new Date(message.createdAt ?? 0).toISOString()) < since) continue;
      if ((request.openItems ?? []).some((i) => i.sourceMessageId === message.id)) continue;
      // One ticket per message, as the live path decides it.
      if (deps.service.findRequestFor(message, allRequests)?.id !== request.id) continue;
      const at = new Date(message.createdAt ?? now.getTime());
      const planned = await deps.service.plan(request, message, at);
      const later = thread.filter((m) => (m.createdAt ?? 0) > (message.createdAt ?? 0));
      for (const p of planned) {
        if (keep.some((k) => isSameItem(k.item, p.item))) continue;
        const row: BackfillRow = {
          requestId: request.id,
          ticket,
          requestStatus: request.status,
          agent: p.item.agent,
          type: p.item.type,
          text: p.item.text,
          at: p.item.createdAt,
          action: '',
        };
        if (p.item.type === 'commitment') {
          const children = childWorkFor(request, p.item, pool);
          const byId = new Map(pool.map((w) => [w.id, w]));
          row.due = p.item.due;
          row.children = children.map((id) => `${id.slice(0, 8)}: ${byId.get(id)?.status ?? '?'}`);
          const item = { ...p.item, ...(children.length ? { childWorkItemIds: children } : {}) };
          const delivery = later.find((m) => m.senderType === 'agent' && deps.service.deliveredBy(item, m, pool));
          if (delivery) {
            row.skipped = `delivered by ${delivery.senderId} at ${new Date(delivery.createdAt ?? 0).toISOString()}`;
            row.action = 'none';
            report.rows.push(row);
            continue;
          }
          const state = childrenState(children, pool);
          const overdue = p.item.due ? Date.parse(p.item.due) <= now.getTime() : false;
          const parts = ['create follow-up WorkItem for ' + p.item.agent];
          if (state.ready) parts.push(`wake ${p.item.agent} now — the work is ready (finished ${state.finishedAt ?? '?'})`);
          else if (state.pending.length) parts.push(`wait for ${state.pending.map((w) => `${w.id.slice(0, 8)} (${w.status})`).join(', ')}`);
          if (overdue) parts.push('already past due → nudge on the next sweep');
          row.action = parts.join('; ');
        } else {
          const ownerReply = later.find((m) => m.senderType === 'user');
          if (ownerReply) {
            row.skipped = `owner replied at ${new Date(ownerReply.createdAt ?? 0).toISOString()}`;
            row.action = 'none';
            report.rows.push(row);
            continue;
          }
          if (p.linkedDecisionId) {
            row.action = `link to existing ask-owner card ${p.linkedDecisionId} (no new card)`;
          } else if (p.card) {
            const opts = p.card.options.map((o) => `${o.label}${o.detail ? ` (${o.detail})` : ''}`).join(' / ');
            const def = p.card.options.find((o) => o.key === p.card!.defaultKey)?.label ?? p.card.defaultKey;
            row.action = `post decision card as ${p.item.agent} in the ticket thread: ${opts}; default ${def}; deadline tomorrow 12:00${p.card.sensitive ? `; sensitive ${p.card.sensitive}` : ''}`;
          }
        }
        keep.push(p);
        report.rows.push(row);
      }
    }
    if (keep.length === 0) continue;
    if (request.status === 'done') report.reopened.push(`${ticket} (${request.id.slice(0, 8)})`);
    if (apply) await deps.service.adopt(request.id, keep);
  }
  return report;
}

/**
 * Plain-text rendering of a report (the script's output).
 *
 * @param report - Report
 * @returns Text
 */
export function formatBackfillReport(report: BackfillReport): string {
  const lines: string[] = [];
  lines.push(`${report.dryRun ? 'DRY RUN — nothing changed' : 'APPLIED'}. Tickets scanned (promises of the last 24h): ${report.scanned}.`);
  const live = report.rows.filter((r) => !r.skipped);
  const skipped = report.rows.filter((r) => r.skipped);
  lines.push(`Open items to track: ${live.length} (${live.filter((r) => r.type === 'commitment').length} commitments, ${live.filter((r) => r.type === 'question').length} questions). Already settled, skipped: ${skipped.length}.`);
  if (report.reopened.length) lines.push(`Closed tickets that would move to awaiting_followup: ${report.reopened.join(', ')}`);
  for (const r of live) {
    lines.push('');
    lines.push(`${r.ticket} [${r.requestStatus}] ${r.type.toUpperCase()} by ${r.agent} at ${r.at}`);
    lines.push(`  "${r.text}"`);
    if (r.due) lines.push(`  due: ${r.due}`);
    if (r.children?.length) lines.push(`  child work: ${r.children.join(', ')}`);
    lines.push(`  → ${r.action}`);
  }
  if (skipped.length) {
    lines.push('');
    lines.push('Skipped (already settled in the thread):');
    for (const r of skipped) lines.push(`  ${r.ticket} ${r.type} by ${r.agent}: "${r.text.slice(0, 80)}" — ${r.skipped}`);
  }
  return lines.join('\n');
}
