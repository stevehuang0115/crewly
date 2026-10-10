/**
 * Google reconnect cards — the harness asks the owner, not the agent.
 *
 * 2026-10-08: the Personal Assistant tried to save a reply as a Gmail draft,
 * Google answered 403 "insufficient authentication scopes" (no grant carried
 * `gmail.compose`), and the agent told the owner to "re-authorize Gmail in
 * Crewly Connections" — a page the owner cannot reach from a phone. The
 * same dead end follows an expired or revoked grant.
 *
 * So when a Google call fails because the grant is too narrow or no longer
 * honoured, this posts the existing one-tap connect card (single-use ticket,
 * `google-connect-card.ts`) to the owner in Slack — in the thread the agent
 * is answering the owner in if that is known, else the owner's DM with that
 * agent. The button opens the Cloud portal's Google page, which mints the
 * consent ticket at click time: the link carries no credential and never
 * expires (a 15-minute ticket link was dead before an owner on a phone got to
 * it, 2026-10-10). Concurrent failures share one card; a failure
 * {@link GOOGLE_WORKSPACE_CONSTANTS.REAUTH.CARD_RESEND_AFTER_MS} after the last
 * card posts a fresh one (the owner is evidently still stuck), and an agent
 * can force one with `resend` when the owner says the card failed. It then
 * watches Cloud (with backoff, for a day) until the reconnect lands and tells
 * the waiting agents to retry.
 *
 * Everything that touches Slack, Cloud or an agent is injected, so the
 * machine the failure happened on is the one that posts — any machine with
 * Slack and a Cloud session works the same.
 *
 * @module services/google/google-reauth-notifier.service
 */

import { GOOGLE_WORKSPACE_CONSTANTS, type GoogleProduct } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import { buildConnectCard, buildPortalConnectUrl, PRODUCT_LABELS } from '../../controllers/google/google-connect-card.js';
import type { GoogleWorkspaceStatus } from './google-workspace-token.service.js';

const logger = LoggerService.getInstance().createComponentLogger('GoogleReauthNotifier');

/** Why the owner has to reconnect. */
export type ReauthKind = 'missing_scope' | 'expired' | 'not_connected';

/** A Google failure that only the owner can fix. */
export interface ReauthTrigger {
  product: GoogleProduct;
  kind: ReauthKind;
  /** Google account the call acted as; undefined = the default connection */
  account?: string;
  /** The agent whose call failed; it is told when to retry */
  agentSession?: string;
  /** Post a new card even inside the resend window (the owner said the last one failed) */
  resend?: boolean;
}

/** Where a card goes. */
export interface ReauthPlace {
  slackChannelId: string;
  threadTs?: string;
  /** Post as this bot (the agent's own); the shared bot when absent */
  botToken?: string;
}

/** What {@link GoogleReauthNotifier.notify} did. */
export type ReauthNotifyResult =
  | { status: 'posted' }
  | { status: 'already_sent'; sentAt: string; nextCardAfter: string }
  | { status: 'unavailable'; why: string };

/** Collaborators. */
export interface ReauthNotifierDeps {
  /** The owner's Slack user id */
  ownerUserId: () => string | null;
  /** The thread the agent is working in, else the owner's DM with it */
  placeFor: (agentSession: string | undefined, ownerUserId: string) => Promise<ReauthPlace | null>;
  /** Post so only the owner sees it; true when Slack accepted */
  postCard: (place: ReauthPlace, ownerUserId: string, text: string, blocks: unknown[]) => Promise<boolean>;
  /** Cloud's view of the connections now (fresh, not cached) */
  status: () => Promise<GoogleWorkspaceStatus>;
  /** Drop cached Google tokens so the retry carries the new grant */
  clearTokenCache: (account?: string) => void;
  /** Tell an agent something (wakes or queues it) */
  tellAgent: (session: string, text: string) => Promise<boolean>;
  now?: () => number;
  /** Timer seam for tests */
  setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
}

/** One card in flight: when it went out, and who is waiting on it. */
interface Pending {
  trigger: ReauthTrigger;
  sentAtMs: number;
  /** Stop watching for the reconnect after this */
  watchUntilMs: number;
  /** Wait before the next look at Cloud; grows with every look */
  intervalMs: number;
  waiters: Set<string>;
  timer?: { cancel: () => void };
}

/**
 * The scope a `missing_scope` failure is about, per product — what a
 * reconnect must have added for the retry to work.
 */
const EXTRA_SCOPE: Partial<Record<GoogleProduct, string>> = {
  gmail: GOOGLE_WORKSPACE_CONSTANTS.GMAIL_COMPOSE_SCOPE,
  drive: GOOGLE_WORKSPACE_CONSTANTS.DRIVE_FULL_SCOPE,
};

/** What the missing scope lets the agent do, for the card. */
const EXTRA_PURPOSE: Partial<Record<GoogleProduct, string>> = {
  gmail: 'save drafts',
  drive: 'comment on documents',
};

/** What the agent retries once the scope is there. */
const EXTRA_RETRY: Partial<Record<GoogleProduct, string>> = {
  gmail: 'your draft',
  drive: 'your comment',
};

/**
 * The card's first line. Owner-facing, so it says what broke and that it is
 * quick — not which scope is missing.
 *
 * @param trigger - The failure
 * @returns Card message
 */
export function reauthCardMessage(trigger: Pick<ReauthTrigger, 'product' | 'kind'>): string {
  const label = PRODUCT_LABELS[trigger.product] ?? trigger.product;
  if (trigger.kind === 'expired') return `${label} access expired — tap to reconnect.`;
  if (trigger.kind === 'not_connected') return `${label} needs access — tap to connect. Takes 30 seconds on your phone.`;
  const purpose = EXTRA_PURPOSE[trigger.product];
  return `${label} needs re-authorization${purpose ? ` to ${purpose}` : ''} (missing permission). Tap to reconnect — takes 30 seconds on your phone.`;
}

/**
 * What the agent is told once the owner has reconnected.
 *
 * @param trigger - The failure
 * @returns Notice text
 */
export function reauthRetryNotice(trigger: Pick<ReauthTrigger, 'product' | 'kind'>): string {
  const label = PRODUCT_LABELS[trigger.product] ?? trigger.product;
  const what = trigger.kind === 'missing_scope' ? EXTRA_RETRY[trigger.product] : undefined;
  return `[GOOGLE] ${label} reconnected — retry ${what ?? 'what failed'}.`;
}

/**
 * Whether a status from Cloud shows the failure fixed.
 *
 * - `missing_scope`: the account is connected for the product and now
 *   carries the scope the call lacked (or, for a product with no known
 *   extra, reports nothing missing).
 * - `expired` / `not_connected`: the account is connected for the product
 *   (for `expired`, Cloud deleted the dead grant, so being there at all is new).
 *
 * @param status - Cloud's connections
 * @param trigger - The failure
 * @returns True when the agent can retry
 */
export function isReconnected(status: GoogleWorkspaceStatus, trigger: ReauthTrigger): boolean {
  if (!status.connected) return false;
  const account = trigger.account?.toLowerCase();
  const connection = account
    ? status.connections.find((c) => c.email.toLowerCase() === account)
    : status.connections.find((c) => c.isDefault) ?? status.connections[0];
  if (!connection || !connection.products.includes(trigger.product)) return false;
  if (trigger.kind !== 'missing_scope') return true;
  const needed = EXTRA_SCOPE[trigger.product];
  if (needed) return connection.scopes.includes(needed);
  return (connection.missingScopes ?? []).length === 0;
}

/**
 * Throttle key: one card per product and Google account.
 *
 * @param trigger - The failure
 * @returns Key
 */
function keyOf(trigger: Pick<ReauthTrigger, 'product' | 'account'>): string {
  return `${trigger.product}\u0000${(trigger.account ?? '').toLowerCase()}`;
}

/**
 * Posts reconnect cards and tells agents when to retry.
 */
export class GoogleReauthNotifier {
  private static instance: GoogleReauthNotifier | null = null;

  private readonly pending = new Map<string, Pending>();
  /** Posts on the wire, so two failures at once post one card */
  private readonly posting = new Map<string, Promise<ReauthNotifyResult>>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => { cancel: () => void };

  /**
   * @param deps - Collaborators
   */
  constructor(private readonly deps: ReauthNotifierDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return { cancel: () => clearTimeout(t) };
      });
  }

  /** The wired instance, or null when Slack is not set up on this machine. */
  static getInstance(): GoogleReauthNotifier | null {
    return GoogleReauthNotifier.instance;
  }

  /**
   * Install (or, with null, remove) the process-wide instance.
   *
   * @param next - Notifier
   */
  static setInstance(next: GoogleReauthNotifier | null): void {
    GoogleReauthNotifier.instance?.stop();
    GoogleReauthNotifier.instance = next;
  }

  /**
   * Ask the owner to reconnect, unless a card for this product and account
   * went out within the throttle window — then only remember that this
   * agent is waiting too.
   *
   * @param trigger - The failure
   * @returns What happened, for the agent's hint
   */
  async notify(trigger: ReauthTrigger): Promise<ReauthNotifyResult> {
    const key = keyOf(trigger);
    const nowMs = this.now();
    const existing = this.pending.get(key);
    const resendAfter = GOOGLE_WORKSPACE_CONSTANTS.REAUTH.CARD_RESEND_AFTER_MS;
    if (existing && !trigger.resend && nowMs - existing.sentAtMs < resendAfter) {
      if (trigger.agentSession) existing.waiters.add(trigger.agentSession);
      return {
        status: 'already_sent',
        sentAt: new Date(existing.sentAtMs).toISOString(),
        nextCardAfter: new Date(existing.sentAtMs + resendAfter).toISOString(),
      };
    }
    const inFlight = this.posting.get(key);
    if (inFlight) {
      const result = await inFlight;
      if (trigger.agentSession) this.pending.get(key)?.waiters.add(trigger.agentSession);
      return result;
    }
    const task = this.post(key, trigger).finally(() => this.posting.delete(key));
    this.posting.set(key, task);
    return task;
  }

  /** Stop every watch (shutdown, tests). */
  stop(): void {
    for (const p of this.pending.values()) p.timer?.cancel();
    this.pending.clear();
  }

  private async post(key: string, trigger: ReauthTrigger): Promise<ReauthNotifyResult> {
    const owner = this.deps.ownerUserId();
    if (!owner) return { status: 'unavailable', why: 'the owner is not known on Slack' };
    const place = await this.deps.placeFor(trigger.agentSession, owner).catch(() => null);
    if (!place) return { status: 'unavailable', why: 'no Slack conversation with the owner from this machine' };

    const url = buildPortalConnectUrl([trigger.product], trigger.account);
    const card = buildConnectCard(trigger.product, url, {
      message: reauthCardMessage(trigger),
      ...(trigger.account ? { account: trigger.account } : {}),
    });
    const posted = await this.deps.postCard(place, owner, card.text, card.blocks).catch(() => false);
    if (!posted) return { status: 'unavailable', why: 'Slack refused the card' };

    const sentAtMs = this.now();
    const previous = this.pending.get(key);
    const waiters = new Set(previous?.waiters);
    if (trigger.agentSession) waiters.add(trigger.agentSession);
    const pending: Pending = {
      trigger,
      sentAtMs,
      watchUntilMs: sentAtMs + GOOGLE_WORKSPACE_CONSTANTS.REAUTH.WATCH_MS,
      intervalMs: GOOGLE_WORKSPACE_CONSTANTS.REAUTH.POLL_INTERVAL_MS,
      waiters,
    };
    this.pending.get(key)?.timer?.cancel();
    this.pending.set(key, pending);
    this.schedule(key, pending);
    logger.info('Posted a Google reconnect card', {
      product: trigger.product,
      kind: trigger.kind,
      account: trigger.account,
      slackChannelId: place.slackChannelId,
      threaded: !!place.threadTs,
      agentSession: trigger.agentSession,
    });
    return { status: 'posted' };
  }

  /** Check again after the (growing) poll interval, until the watch window closes. */
  private schedule(key: string, pending: Pending): void {
    pending.timer = this.setTimer(() => {
      void this.check(key, pending);
    }, pending.intervalMs);
    const R = GOOGLE_WORKSPACE_CONSTANTS.REAUTH;
    pending.intervalMs = Math.min(Math.round(pending.intervalMs * R.POLL_BACKOFF_FACTOR), R.POLL_MAX_INTERVAL_MS);
  }

  /**
   * One look at Cloud. On success the waiting agents are told to retry and
   * the throttle is lifted, so a later, different failure gets its own card.
   */
  private async check(key: string, pending: Pending): Promise<void> {
    if (this.pending.get(key) !== pending) return;
    let fixed = false;
    try {
      fixed = isReconnected(await this.deps.status(), pending.trigger);
    } catch (err) {
      logger.debug('Could not read Google status while waiting for a reconnect', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!fixed) {
      if (this.now() < pending.watchUntilMs) this.schedule(key, pending);
      else pending.timer = undefined;
      return;
    }
    this.pending.delete(key);
    this.deps.clearTokenCache(pending.trigger.account);
    const notice = reauthRetryNotice(pending.trigger);
    for (const session of pending.waiters) {
      await this.deps.tellAgent(session, notice).catch(() => false);
    }
    logger.info('Google reconnected; told the waiting agents to retry', {
      product: pending.trigger.product,
      account: pending.trigger.account,
      agents: [...pending.waiters],
    });
  }
}
