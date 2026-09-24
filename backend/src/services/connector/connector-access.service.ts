/**
 * Which agents may use a connected account.
 *
 * A connector (Google Workspace, Canva, Microsoft To Do, …) is one grant for the whole
 * instance, so without this every agent can read the owner's mail the
 * moment the owner connects it. Skills carry `X-Agent-Session`, so the
 * backend can tell which role is calling and refuse.
 *
 * The default is **open**: a connector with no allowlist is usable by every
 * agent, which is what installs had before this existed. An allowlist names
 * exactly the roles allowed — `orchestrator` included, so the owner can
 * keep even the orc out of their inbox. The owner's own calls (the
 * dashboard, no `X-Agent-Session`) are never gated.
 *
 * Stored at `<CREWLY_HOME>/connector-access.json`.
 *
 * @module services/connector/connector-access.service
 */

import * as path from 'path';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';

/** Per-connector access rule. */
export interface ConnectorAccess {
  /** Roles allowed to use it. Empty = every agent. */
  allowedRoles: string[];
}

/** The whole file: connector id → rule. */
export type ConnectorAccessMap = Record<string, ConnectorAccess>;

/** Connector ids the backend gates (must match the frontend catalog). */
export const GATED_CONNECTORS = ['google-workspace', 'canva', 'microsoft-todo'] as const;

/** One of {@link GATED_CONNECTORS}. */
export type GatedConnectorId = (typeof GATED_CONNECTORS)[number];

/** Filename under CREWLY_HOME. */
const FILE_NAME = 'connector-access.json';

/**
 * Reads and writes the per-connector role allowlists.
 */
export class ConnectorAccessService {
  private static instance: ConnectorAccessService | null = null;
  private readonly logger: ComponentLogger;
  private readonly filePath: string;
  private cache: ConnectorAccessMap | null = null;

  /**
   * @param crewlyHome - Override the home directory (tests)
   */
  constructor(crewlyHome?: string) {
    this.logger = LoggerService.getInstance().createComponentLogger('ConnectorAccess');
    this.filePath = path.join(crewlyHome || getCrewlyHomePath(), FILE_NAME);
  }

  static getInstance(): ConnectorAccessService {
    if (!ConnectorAccessService.instance) ConnectorAccessService.instance = new ConnectorAccessService();
    return ConnectorAccessService.instance;
  }

  /** Reset the singleton (tests). */
  static resetInstance(): void {
    ConnectorAccessService.instance = null;
  }

  /**
   * Every rule on file.
   *
   * @returns Connector id → rule (connectors with no rule are absent)
   */
  async list(): Promise<ConnectorAccessMap> {
    if (this.cache) return this.cache;
    const raw = await safeReadJson<ConnectorAccessMap>(this.filePath, {}, this.logger);
    const clean: ConnectorAccessMap = {};
    for (const [id, rule] of Object.entries(raw ?? {})) {
      const roles = Array.isArray(rule?.allowedRoles) ? rule.allowedRoles.map((r) => String(r).toLowerCase()).filter(Boolean) : [];
      clean[id] = { allowedRoles: [...new Set(roles)] };
    }
    this.cache = clean;
    return clean;
  }

  /**
   * The allowlist for one connector.
   *
   * @param connectorId - Connector id
   * @returns Its roles (empty = open to every agent)
   */
  async allowedRoles(connectorId: string): Promise<string[]> {
    return (await this.list())[connectorId]?.allowedRoles ?? [];
  }

  /**
   * Replace a connector's allowlist.
   *
   * @param connectorId - Connector id
   * @param roles - Allowed roles; empty opens it to every agent
   * @returns The stored rule
   */
  async setAllowedRoles(connectorId: string, roles: string[]): Promise<ConnectorAccess> {
    const normalized = [...new Set((roles ?? []).map((r) => String(r).trim().toLowerCase()).filter(Boolean))];
    const map = { ...(await this.list()) };
    map[connectorId] = { allowedRoles: normalized };
    await atomicWriteJson(this.filePath, map);
    this.cache = map;
    this.logger.info('Connector access updated', { connectorId, allowedRoles: normalized });
    return map[connectorId];
  }

  /**
   * Whether a caller may use a connector.
   *
   * @param connectorId - Connector id
   * @param role - Caller role; undefined = the owner (always allowed)
   * @returns True when allowed
   */
  async isAllowed(connectorId: string, role: string | undefined): Promise<boolean> {
    if (!role) return true; // the owner / dashboard
    const roles = await this.allowedRoles(connectorId);
    if (roles.length === 0) return true; // no rule = open
    return roles.includes(role.toLowerCase());
  }

  /** Drop the in-memory copy (tests, or an external edit of the file). */
  invalidate(): void {
    this.cache = null;
  }
}
