/**
 * Owner receipt (#828) — boot wiring: the Slack sender, the team index, the
 * schedule. Kept out of `index.ts` so each piece is testable.
 *
 * @module services/v3/owner-receipt/owner-receipt.boot
 */

import { OWNER_RECEIPT_CONSTANTS } from '../../../constants.js';
import type { SlackNotification, SlackOutgoingMessage } from '../../../types/slack.types.js';
import type { Team } from '../../../types/index.js';
import { LoggerService } from '../../core/logger.service.js';
import type { OwnerReceiptService, ReceiptSender } from './owner-receipt.service.js';
import { getTeamLeads } from '../../../utils/team.utils.js';

/** The slice of SlackService the sender uses. */
export interface ReceiptSlackApi {
  isConnected(): boolean;
  getOwnerUserId: (() => string | null) | null;
  openDirectMessage(userId: string): Promise<string>;
  sendMessage(message: SlackOutgoingMessage): Promise<string>;
  sendNotification(notification: SlackNotification): Promise<void>;
}

/**
 * A sender that DMs the owner. The text is already Slack mrkdwn (the renderer
 * escaped the owner's words and built the links), so it is NOT escaped again.
 * When the owner's Slack id is unknown it uses the owner-notification path
 * (`daily_summary`), as the re-login DM does. Link previews are off so the
 * message stays phone-short.
 *
 * @param getSlack - Slack accessor (resolved per call; the connection can come up late)
 * @returns The sender
 */
export function createSlackOwnerSender(getSlack: () => ReceiptSlackApi | null): ReceiptSender {
  const logger = LoggerService.getInstance().createComponentLogger('OwnerReceipt');
  return async (text: string): Promise<boolean> => {
    const slack = getSlack();
    if (!slack || !slack.isConnected()) return false;
    const ownerId = slack.getOwnerUserId?.() ?? null;
    if (ownerId) {
      try {
        const channelId = await slack.openDirectMessage(ownerId);
        await slack.sendMessage({ channelId, text, unfurlLinks: false, unfurlMedia: false, skipChatV2Mirror: true });
        return true;
      } catch (err) {
        logger.warn('Could not DM the owner the receipt; using the owner-notification path', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await slack.sendNotification({ type: 'daily_summary', title: 'Crewly receipt', message: text, urgency: 'low', timestamp: new Date().toISOString() });
    return true;
  };
}

/**
 * session → team name, from the team list.
 *
 * @param teams - Every team
 * @returns Index
 */
export function teamIndexOf(teams: readonly Team[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const team of teams) {
    for (const m of team.members ?? []) if (m.sessionName) index.set(m.sessionName, team.name);
  }
  return index;
}

/**
 * session → agent display name (「Atlas」), from the team list: a decision on
 * the receipt names who is asking.
 *
 * @param teams - Every team
 * @returns Index
 */
export function agentNameIndexOf(teams: readonly Team[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const team of teams) {
    for (const m of team.members ?? []) if (m.sessionName && m.name) index.set(m.sessionName, m.name);
  }
  return index;
}

/**
 * team name → team lead's display name, from the team list (Ava's reference:
 * `CE（Owen）`). The first lead by the team-lead rule (`utils/team.utils`:
 * explicit `leaderIds`, else a `team-leader` / `tech-lead` member); a team
 * with no lead is absent from the index, so the receipt falls back to
 * `*<team>*` with no parenthetical.
 *
 * @param teams - Every team
 * @returns Index
 */
export function teamLeadIndexOf(teams: readonly Team[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const team of teams) {
    const lead = getTeamLeads(team)[0];
    if (lead) index.set(team.name, lead.name);
  }
  return index;
}

/**
 * Check every {@link OWNER_RECEIPT_CONSTANTS.TICK_INTERVAL_MS} whether the
 * receipt is due. Failures are logged, never thrown.
 *
 * @param svc - The service
 * @param opts.intervalMs - Override (tests)
 * @param opts.setIntervalFn - Override (tests)
 * @param opts.clearIntervalFn - Override (tests)
 * @returns Stop function
 */
export function startOwnerReceiptSchedule(
  svc: Pick<OwnerReceiptService, 'tick'>,
  opts: {
    intervalMs?: number;
    setIntervalFn?: (fn: () => void, ms: number) => unknown;
    clearIntervalFn?: (handle: unknown) => void;
  } = {},
): () => void {
  const logger = LoggerService.getInstance().createComponentLogger('OwnerReceipt');
  const set = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clear = opts.clearIntervalFn ?? ((h) => clearInterval(h as NodeJS.Timeout));
  const handle = set(() => {
    svc.tick().catch((err: unknown) => {
      logger.warn('Owner receipt tick failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    });
  }, opts.intervalMs ?? OWNER_RECEIPT_CONSTANTS.TICK_INTERVAL_MS);
  (handle as { unref?: () => void } | null)?.unref?.();
  return () => clear(handle);
}
