/**
 * The catalog of accounts this instance can connect to.
 *
 * One list, read by the Connections page (which owns the Connect UI) and by
 * the Marketplace's Connectors tab (which only points at it). Keep the ids
 * in step with `GATED_CONNECTORS` in
 * `backend/src/services/connector/connector-access.service.ts`.
 *
 * @module config/connectors
 */

/** Connector id — also the key of its role allowlist. */
export type ConnectorId =
  | 'slack'
  | 'whatsapp'
  | 'discord'
  | 'telegram'
  | 'google-chat'
  | 'google-workspace'
  | 'canva';

/** Which section a connector belongs to. */
export type ConnectorGroup = 'messaging' | 'data';

/** One connector. */
export interface ConnectorMeta {
  id: ConnectorId;
  name: string;
  description: string;
  group: ConnectorGroup;
  /**
   * True when agents reach it through a backend route that honours the role
   * allowlist — i.e. the card shows a "who may use this" control.
   */
  roleGated: boolean;
}

/** Section headings, in render order. */
export const CONNECTOR_GROUPS: { id: ConnectorGroup; title: string; blurb: string }[] = [
  {
    id: 'messaging',
    title: 'Messaging',
    blurb: 'Channels you talk to the orchestrator through, from anywhere.',
  },
  {
    id: 'data',
    title: 'Data & content',
    blurb: 'Accounts whose files and tools your agents may read and write on your behalf.',
  },
];

/** Every connector, in render order within its group. */
export const CONNECTORS: ConnectorMeta[] = [
  {
    id: 'slack',
    name: 'Slack',
    description: 'Connect your Slack workspace for team communication with the orchestrator.',
    group: 'messaging',
    roleGated: false,
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    description: 'Connect via WhatsApp Web to communicate with the orchestrator from your phone.',
    group: 'messaging',
    roleGated: false,
  },
  {
    id: 'discord',
    name: 'Discord',
    description: 'Connect a Discord bot to communicate with the orchestrator via Discord server.',
    group: 'messaging',
    roleGated: false,
  },
  {
    id: 'telegram',
    name: 'Telegram',
    description: 'Connect a Telegram bot for messaging the orchestrator via Telegram.',
    group: 'messaging',
    roleGated: false,
  },
  {
    id: 'google-chat',
    name: 'Google Chat',
    description: 'Connect Google Chat for workspace communication with the orchestrator.',
    group: 'messaging',
    roleGated: false,
  },
  {
    id: 'google-workspace',
    name: 'Google Workspace',
    description: 'Let agents read your Gmail and Drive (Docs, Sheets, Slides), send mail, manage your Calendar and create documents.',
    group: 'data',
    roleGated: true,
  },
  {
    id: 'canva',
    name: 'Canva',
    description: 'Let agents find, create, upload to and export your Canva designs (posters, stories, decks, videos).',
    group: 'data',
    roleGated: true,
  },
];

/**
 * Look up one connector.
 *
 * @param id - Candidate id
 * @returns The connector, or undefined
 */
export function findConnector(id: string | null | undefined): ConnectorMeta | undefined {
  return CONNECTORS.find((c) => c.id === id);
}
