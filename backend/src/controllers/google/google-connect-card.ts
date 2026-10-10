/**
 * The Slack authorization card for a Google product.
 *
 * An agent that hits `not_connected` has nothing useful to offer the owner:
 * the error says "connect it on the Connections page", and the only link it
 * could build carries the Cloud session token in the query string — which
 * must never be posted into a channel. This posts a Block Kit card whose
 * button opens the Cloud portal's Google page instead: no token, no expiry
 * (the portal mints the consent ticket when the owner taps), visible only to
 * the person who asked, because Slack does not tell us who clicks a link
 * (2026-09-21). A single-use ticket link used to sit behind the button; it
 * died after 15 minutes, before an owner on a phone got to it (2026-10-10).
 *
 * @module controllers/google/google-connect-card
 */

import type { Request, Response } from 'express';
import { GOOGLE_PRODUCTS, GOOGLE_WORKSPACE_CONSTANTS, ONBOARDING_CONSTANTS, type GoogleProduct } from '../../constants.js';
import { LoggerService } from '../../services/core/logger.service.js';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';

const logger = LoggerService.getInstance().createComponentLogger('GoogleConnectCard');

/** Where a chat channel came from in Slack, when it came from Slack at all. */
export interface SlackOrigin {
  slackChannelId: string;
  slackUserId: string;
  threadTs?: string;
  botToken?: string;
}

/** Human names for the products, for the card's first line. */
export const PRODUCT_LABELS: Record<string, string> = {
  gmail: 'Gmail',
  calendar: 'Google Calendar',
  drive: 'Google Drive',
};

/**
 * The Cloud portal link behind a card's button. Carries no credential and
 * never expires; the portal page mints the consent ticket at click time.
 *
 * @param products - Products to ask for
 * @param account - Google account to reconnect, when one is known
 * @returns Absolute portal URL
 */
export function buildPortalConnectUrl(products: readonly string[], account?: string): string {
  const base = ONBOARDING_CONSTANTS.CLOUD.CONSOLE_URL.replace(/\/$/, '');
  const url = new URL(`${base}${GOOGLE_WORKSPACE_CONSTANTS.PORTAL_CONNECT_PATH}`);
  if (products.length) url.searchParams.set('products', products.join(','));
  if (account) url.searchParams.set('account', account);
  url.searchParams.set('auto', '1');
  return url.toString();
}

/**
 * Build the card. Pure, so the wording is testable without Slack.
 *
 * A reconnect (`reconnect`) replaces the generic "Needs access" with the
 * reason the harness hit — "Gmail needs re-authorization to save drafts" —
 * and names the Google account, because an owner with two Gmail logins has
 * to know which one to pick.
 *
 * @param product - Product needing consent
 * @param url - The portal link behind the button ({@link buildPortalConnectUrl})
 * @param reconnect - Why a working connection needs the owner again, and for which account
 * @returns Block Kit blocks and the fallback text
 */
export function buildConnectCard(
  product: string,
  url: string,
  reconnect?: { message: string; account?: string },
): { text: string; blocks: unknown[] } {
  const label = PRODUCT_LABELS[product] ?? product;
  const note = 'Only you can see this.';
  if (reconnect) {
    return {
      text: reconnect.message,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: reconnect.message },
          accessory: { type: 'button', text: { type: 'plain_text', text: 'Reconnect' }, url, style: 'primary' },
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: reconnect.account ? `${reconnect.account} · ${note}` : note }],
        },
      ],
    };
  }
  return {
    text: `${label} needs access — open the link to authorize Crewly.`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${label}*\nNeeds access` },
        accessory: { type: 'button', text: { type: 'plain_text', text: 'Add' }, url, style: 'primary' },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: note }],
      },
    ],
  };
}

/** What the endpoint needs from the rest of the system. */
export interface ConnectCardDeps {
  /** Resolve a chat-v2 channel (or a Slack channel / thread ref) to its Slack conversation, or null. */
  originFor: (chatChannelId: string) => Promise<SlackOrigin | null>;
  /** Post the card so only `userId` sees it. */
  postEphemeral: (
    channelId: string,
    userId: string,
    text: string,
    blocks: unknown[],
    botToken?: string,
    threadTs?: string,
  ) => Promise<boolean>;
  /**
   * Used when the origin is unknown or refused the card: post where the
   * asking agent is working, else in the owner's DM. True when posted.
   */
  fallbackPost?: (args: { product: GoogleProduct; account?: string; agentSession?: string }) => Promise<boolean>;
}

let deps: ConnectCardDeps | null = null;

/**
 * Wire the endpoint. Called once at boot; tests install their own.
 *
 * @param next - The collaborators
 */
export function setConnectCardDeps(next: ConnectCardDeps | null): void {
  deps = next;
}

/**
 * `POST /api/google/connect-card` — ask the owner to authorize a product.
 *
 * The card goes where the agent is talking to the owner (`channelId`, the
 * `[CHAT:…]` id, a Slack channel id or a Slack thread key). When that place
 * cannot be resolved, or Slack refuses it, the card goes to the place the
 * harness knows the agent is working in, else the owner's DM — never a 409
 * for an owner who has to be reached somehow. Every call posts a card: an
 * agent asks again when the owner says the last one failed.
 *
 * @param req - `{ product, channelId?, account? }`
 * @param res - `{ posted }`, or why it could not be posted
 */
export async function postConnectCard(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const product = String(body['product'] ?? '').trim().toLowerCase();
  const channelId = String(body['channelId'] ?? '').trim();
  const account = String(body['account'] ?? '').trim() || undefined;

  if (!(GOOGLE_PRODUCTS as readonly string[]).includes(product)) {
    res.status(400).json({ success: false, error: `product must be one of ${GOOGLE_PRODUCTS.join(', ')}` });
    return;
  }
  if (!deps) {
    res.status(503).json({ success: false, error: 'Slack is not connected on this instance' });
    return;
  }

  try {
    const url = buildPortalConnectUrl([product], account);
    const card = buildConnectCard(product, url, account ? { message: `${PRODUCT_LABELS[product] ?? product} needs access — tap to connect.`, account } : undefined);
    const origin = channelId ? await deps.originFor(channelId) : null;
    if (origin) {
      const posted = await deps.postEphemeral(
        origin.slackChannelId,
        origin.slackUserId,
        card.text,
        card.blocks,
        origin.botToken,
        origin.threadTs,
      );
      if (posted) {
        logger.info('Posted a Google authorization card', { product, slackChannelId: origin.slackChannelId, threaded: !!origin.threadTs });
        res.json({ success: true, data: { posted: true, product, where: 'conversation' } });
        return;
      }
    }

    const agentSession = readAgentSessionHeader(req);
    const posted = (await deps.fallbackPost?.({ product: product as GoogleProduct, ...(account ? { account } : {}), ...(agentSession ? { agentSession } : {}) })) ?? false;
    if (posted) {
      logger.info('Posted a Google authorization card via fallback', { product, channelId, agentSession, origin: origin ? 'refused' : 'unknown' });
      res.json({ success: true, data: { posted: true, product, where: 'fallback' } });
      return;
    }
    logger.warn('Could not post the authorization card anywhere', { product, channelId, agentSession });
    res.status(502).json({
      success: false,
      error: 'Slack did not take the card (no conversation, work place or owner DM reachable from this instance).',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('Could not post the authorization card', { product, error: message });
    res.status(502).json({ success: false, error: message });
  }
}
