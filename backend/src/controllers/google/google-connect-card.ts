/**
 * The Slack authorization card for a Google product.
 *
 * An agent that hits `not_connected` has nothing useful to offer the owner:
 * the error says "connect it on the Connections page", and the only link it
 * could build carries the Cloud session token in the query string — which
 * must never be posted into a channel. This posts a Block Kit card whose
 * button holds a single-use ticket instead, visible only to the person who
 * asked, because Slack does not tell us who clicks a link (2026-09-21).
 *
 * @module controllers/google/google-connect-card
 */

import type { Request, Response } from 'express';
import { GOOGLE_PRODUCTS, type GoogleProduct } from '../../constants.js';
import { LoggerService } from '../../services/core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('GoogleConnectCard');

/** Where a chat channel came from in Slack, when it came from Slack at all. */
export interface SlackOrigin {
  slackChannelId: string;
  slackUserId: string;
  threadTs?: string;
  botToken?: string;
}

/** Human names for the products, for the card's first line. */
const PRODUCT_LABELS: Record<string, string> = {
  gmail: 'Gmail',
  calendar: 'Google Calendar',
  drive: 'Google Drive',
};

/**
 * Build the card. Pure, so the wording is testable without Slack.
 *
 * @param product - Product needing consent
 * @param url - The ticket link behind the button
 * @param expiresAt - When the link stops working
 * @returns Block Kit blocks and the fallback text
 */
export function buildConnectCard(
  product: string,
  url: string,
  expiresAt: string,
): { text: string; blocks: unknown[] } {
  const label = PRODUCT_LABELS[product] ?? product;
  const minutes = Math.max(1, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60_000));
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
        elements: [
          {
            type: 'mrkdwn',
            // Say both, because both surprise people: the link dies, and it
            // is for them alone.
            text: `Only you can see this. The link works once, for about ${minutes} minutes.`,
          },
        ],
      },
    ],
  };
}

/** What the endpoint needs from the rest of the system. */
export interface ConnectCardDeps {
  /** Resolve a chat-v2 channel to its Slack conversation, or null. */
  originFor: (chatChannelId: string) => Promise<SlackOrigin | null>;
  /** Ask Cloud for a single-use connect link. */
  connectUrl: (args: {
    products: GoogleProduct[];
    slackUserId: string;
    slackChannelId: string;
    slackThreadTs?: string;
  }) => Promise<{ url: string; expiresAt: string }>;
  /** Post the card so only `userId` sees it. */
  postEphemeral: (
    channelId: string,
    userId: string,
    text: string,
    blocks: unknown[],
    botToken?: string,
  ) => Promise<boolean>;
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
 * @param req - `{ product, channelId }`; `channelId` is the chat-v2 channel
 * @param res - `{ posted, expiresAt }`, or why it could not be posted
 */
export async function postConnectCard(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const product = String(body['product'] ?? '').trim().toLowerCase();
  const channelId = String(body['channelId'] ?? '').trim();

  if (!(GOOGLE_PRODUCTS as readonly string[]).includes(product)) {
    res.status(400).json({ success: false, error: `product must be one of ${GOOGLE_PRODUCTS.join(', ')}` });
    return;
  }
  if (!channelId) {
    res.status(400).json({ success: false, error: 'channelId is required' });
    return;
  }
  if (!deps) {
    res.status(503).json({ success: false, error: 'Slack is not connected on this instance' });
    return;
  }

  try {
    const origin = await deps.originFor(channelId);
    if (!origin) {
      // Worth saying plainly: the agent asked in a chat that never came from
      // Slack, so there is nowhere to show a card.
      res.status(409).json({
        success: false,
        error: 'This conversation did not come from Slack, so there is nobody to show the card to.',
      });
      return;
    }

    const { url, expiresAt } = await deps.connectUrl({
      products: [product as GoogleProduct],
      slackUserId: origin.slackUserId,
      slackChannelId: origin.slackChannelId,
      ...(origin.threadTs ? { slackThreadTs: origin.threadTs } : {}),
    });
    const card = buildConnectCard(product, url, expiresAt);
    const posted = await deps.postEphemeral(
      origin.slackChannelId,
      origin.slackUserId,
      card.text,
      card.blocks,
      origin.botToken,
    );

    if (!posted) {
      res.status(502).json({ success: false, error: 'Slack refused the card; see the backend log for the reason.' });
      return;
    }
    logger.info('Posted a Google authorization card', {
      product,
      slackChannelId: origin.slackChannelId,
      expiresAt,
    });
    res.json({ success: true, data: { posted: true, product, expiresAt } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('Could not post the authorization card', { product, error: message });
    res.status(502).json({ success: false, error: message });
  }
}
