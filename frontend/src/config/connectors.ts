/**
 * The catalog of accounts this instance can connect to.
 *
 * One list, read by the Connections page (which owns the Connect UI) and by
 * the Marketplace's Connectors tab (which only points at it). Keep the ids
 * in step with `GATED_CONNECTORS` in
 * `backend/src/services/connector/connector-access.service.ts`. Remote MCP
 * servers are gated one by one as `mcp:<id>`.
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
  | 'canva'
  | 'microsoft-todo'
  | 'remote-mcp';

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
    name: 'Google',
    description: 'Connect Gmail, Calendar and Drive (Docs, Sheets, Slides) separately — and as many Google accounts as you need.',
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
  {
    id: 'microsoft-todo',
    name: 'Microsoft To Do',
    description: 'Let agents read your To Do lists, add tasks with due dates, and complete or tidy them — personal and work accounts.',
    group: 'data',
    roleGated: true,
  },
  {
    id: 'remote-mcp',
    name: 'Remote MCP servers',
    description: 'Give agents the tools of Zoho MCP or any other remote MCP server — each server has its own "which agents" list.',
    group: 'data',
    // Gated per server (`mcp:<id>`), inside the card — not one card-level list.
    roleGated: false,
  },
];

/** A preset in the "add a remote MCP server" form. */
export interface RemoteMcpPreset {
  /** Stored as the server's provider. */
  id: 'zoho' | 'custom';
  /** Default server name. */
  label: string;
  /** One-line help under the URL field. */
  help: string;
  /** Where the owner creates the server, when there is one place. */
  setupUrl?: string;
}

/** Remote MCP catalog, in render order. Zoho first. */
export const REMOTE_MCP_PRESETS: RemoteMcpPreset[] = [
  {
    id: 'zoho',
    label: 'Zoho',
    help: 'Create a server at mcp.zoho.com, pick the Zoho apps it may use, then paste its URL here.',
    setupUrl: 'https://mcp.zoho.com',
  },
  {
    id: 'custom',
    label: 'Other',
    help: 'Paste the URL of any remote (streamable HTTP) MCP server.',
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
