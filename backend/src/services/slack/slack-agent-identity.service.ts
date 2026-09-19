/**
 * Slack Agent Identity Service — one real Slack bot user per agent.
 *
 * Crewly Cloud (`/api/cloud/slack/*`) creates one Slack app per agent with
 * the owner's app configuration token, hands back an install link, and after
 * the owner's one consent click holds the agent's bot token. This service is
 * the OSS half:
 *
 *  - talks to Cloud with the OSS install's Cloud access token;
 *  - caches identities (bot user id, bot token) in
 *    `~/.crewly/slack-agent-identities.json` (mode 0600) so posting works
 *    without a Cloud round-trip;
 *  - polls Cloud while any install is pending so a click on the link shows
 *    up here within ~30 s;
 *  - remembers where each install link was announced and which channels the
 *    bot has been invited into, so the team-channel service does each once.
 *
 * Team channels use it to post replies as the agent (its own token) and to
 * resolve native `<@U…>` mentions. Everything degrades gracefully: with no
 * Cloud login or no identity, replies fall back to the cosmetic
 * username/icon override.
 *
 * @module services/slack/slack-agent-identity.service
 */

import * as path from 'path';
import { promises as fs } from 'fs';
import type {
  SlackAgentIdentityRecord,
  SlackAgentIdentitiesFile,
  SlackCloudAgentConfig,
} from '../../types/slack.types.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { SLACK_AGENT_IDENTITY_CONSTANTS } from '../../constants.js';

/** The slice of CloudClientService this service needs. */
export interface IdentityCloudClient {
  isConnected(): boolean;
  getToken(): string | null;
  getCloudUrl(): string | null;
}

/** Constructor dependencies. */
export interface SlackAgentIdentityServiceDeps {
  cloud: IdentityCloudClient;
  /** The Slack workspace this instance serves; config tokens are per workspace. */
  getWorkspaceId?: () => string | null;
  storePath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Timer override for tests. */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

/** Cloud's config-token status. */
export interface CloudConfigTokenStatus {
  configured: boolean;
  status?: 'ok' | 'invalid';
  expiresAt?: string;
  /** Workspace the stored token belongs to. */
  slackTeamId?: string;
  lastError?: string;
}

/** Cloud's `/slack/status` payload. */
export interface CloudSlackStatus {
  enabled: boolean;
  configToken: CloudConfigTokenStatus;
  agents: { total: number; installed: number; pending: number };
}

/** Cloud's agent view (see auth service `SlackAgentView`). */
interface CloudAgentView {
  agentSession: string;
  displayName: string;
  appId: string;
  status: 'pending_install' | 'installed' | 'error';
  botUserId?: string;
  teamId?: string;
  installUrl?: string;
  reinstall?: boolean;
  error?: string;
  botToken?: string;
}

/** Error from Cloud with the stable code it returned. */
export class SlackIdentityCloudError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SlackIdentityCloudError';
  }
}

const EMPTY: SlackAgentIdentitiesFile = { version: 1, identities: [] };

/**
 * Service — see module docs.
 */
export class SlackAgentIdentityService {
  private readonly logger: ComponentLogger;
  private readonly deps: SlackAgentIdentityServiceDeps;
  private readonly storePath: string;
  private readonly fetchImpl: typeof fetch;
  private store: SlackAgentIdentitiesFile | null = null;
  private loading: Promise<SlackAgentIdentitiesFile> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollingSince = 0;
  private readonly listeners = new Set<(record: SlackAgentIdentityRecord) => void>();

  constructor(deps: SlackAgentIdentityServiceDeps) {
    this.deps = deps;
    this.storePath =
      deps.storePath ?? path.join(getCrewlyHomePath(), SLACK_AGENT_IDENTITY_CONSTANTS.STORE_FILENAME);
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.logger = LoggerService.getInstance().createComponentLogger('SlackAgentIdentity');
  }

  // -------------------------------------------------------------------------
  // Availability
  // -------------------------------------------------------------------------

  /**
   * Whether Cloud can be reached (logged in with a token).
   *
   * @returns True when the OSS install is connected to Crewly Cloud
   */
  isAvailable(): boolean {
    return this.deps.cloud.isConnected() && !!this.deps.cloud.getToken() && !!this.deps.cloud.getCloudUrl();
  }

  /**
   * Register a callback for the moment an identity becomes installed
   * (bot user id + token known). The team-channel service uses it to invite
   * the new bot into its channels.
   *
   * @param listener - Called with the installed record
   * @returns Unsubscribe
   */
  onInstalled(listener: (record: SlackAgentIdentityRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Cloud calls
  // -------------------------------------------------------------------------

  /**
   * Cloud-side status: whether the feature is enabled there, whether this
   * account has a config token, and agent counts.
   *
   * @returns The status
   * @throws {SlackIdentityCloudError} on a Cloud failure
   */
  async getCloudStatus(): Promise<CloudSlackStatus> {
    return this.cloudRequest<CloudSlackStatus>('GET', `/status${this.workspaceQuery()}`);
  }

  /**
   * Store the owner's Slack app configuration token on Cloud (validated
   * there by rotating it once).
   *
   * @param token - Config access token (may be empty/expired)
   * @param refreshToken - Config refresh token (required)
   * @returns The stored token's status
   */
  async setConfigToken(token: string, refreshToken: string): Promise<CloudConfigTokenStatus> {
    const slackTeamId = this.deps.getWorkspaceId?.() ?? null;
    return this.cloudRequest<CloudConfigTokenStatus>('PUT', '/config-token', {
      token,
      refreshToken,
      ...(slackTeamId ? { slackTeamId } : {}),
    });
  }

  /**
   * Remove the config token on Cloud.
   *
   * @returns True when one existed
   */
  async deleteConfigToken(): Promise<boolean> {
    const res = await this.cloudRequest<{ removed: boolean }>('DELETE', `/config-token${this.workspaceQuery()}`);
    return res.removed;
  }

  /** `?slackTeamId=…` for the workspace this instance serves, or ''. */
  private workspaceQuery(): string {
    const slackTeamId = this.deps.getWorkspaceId?.() ?? null;
    return slackTeamId ? `?slackTeamId=${encodeURIComponent(slackTeamId)}` : '';
  }

  /**
   * Ask Cloud for an identity for an agent (idempotent). Returns the cached
   * record updated with Cloud's answer, including `installUrl` while the
   * install is pending.
   *
   * @param agentSession - Stable agent id
   * @param displayName - Name the bot will carry in Slack
   * @param description - Optional app description
   * @returns The record
   */
  async provision(agentSession: string, displayName: string, description?: string): Promise<SlackAgentIdentityRecord> {
    const view = await this.cloudRequest<CloudAgentView>('POST', '/agents', { agentSession, displayName, description });
    const record = await this.mergeView(view);
    if (record.status === 'pending_install') this.ensurePolling();
    return record;
  }

  /**
   * Pull every identity (with tokens) from Cloud into the local cache.
   * Newly installed ones fire {@link onInstalled}.
   *
   * @returns All records after the merge
   */
  async refreshFromCloud(): Promise<SlackAgentIdentityRecord[]> {
    const views = await this.cloudRequest<CloudAgentView[]>('GET', '/agents?includeTokens=1');
    for (const view of views) await this.mergeView(view);
    // Cloud is the source of truth: an identity it no longer lists (pruned
    // when the member left, the channel was unlinked, or the team was
    // deleted) is dropped here too, or Settings keeps showing 27 "waiting
    // for install" rows for bots that no longer exist.
    const known = new Set(views.map((v) => v.agentSession));
    const store = await this.load();
    const before = store.identities.length;
    store.identities = store.identities.filter((r) => known.has(r.agentSession));
    if (store.identities.length !== before) {
      await this.save();
      this.logger.info('Dropped identities Cloud no longer holds', { removed: before - store.identities.length });
    }
    if (!store.identities.some((r) => r.status === 'pending_install')) this.stopPolling();
    return store.identities.map((r) => ({ ...r }));
  }

  /**
   * Merge the installed identities handed down with the Cloud-owned Slack
   * config (`GET /api/cloud/slack/config` → `agents`). Each entry is a fully
   * installed bot user, so it lands as `installed` and fires
   * {@link onInstalled} the first time it is seen — the team-channel
   * service then invites the bot into its channels. Idempotent.
   *
   * @param agents - Agents from the Cloud config
   * @returns Number of records that became installed by this call
   */
  async applyCloudConfig(agents: SlackCloudAgentConfig[]): Promise<number> {
    let newlyInstalled = 0;
    for (const agent of agents) {
      if (!agent.agentSession || !agent.botToken || !agent.botUserId) continue;
      const before = this.getInstalled(agent.agentSession);
      await this.mergeView({
        agentSession: agent.agentSession,
        displayName: agent.displayName || agent.agentSession,
        appId: agent.appId,
        status: 'installed',
        botUserId: agent.botUserId,
        teamId: agent.teamId,
        botToken: agent.botToken,
      });
      if (!before) newlyInstalled += 1;
    }
    return newlyInstalled;
  }

  /**
   * Delete an agent's Slack app on Cloud and forget it locally.
   *
   * @param agentSession - The agent
   * @returns True when a record existed on Cloud
   */
  async remove(agentSession: string): Promise<boolean> {
    let removed = false;
    try {
      const res = await this.cloudRequest<{ removed: boolean }>('DELETE', `/agents/${encodeURIComponent(agentSession)}`);
      removed = res.removed;
    } catch (err) {
      if (!(err instanceof SlackIdentityCloudError && err.status === 404)) throw err;
    }
    const store = await this.load();
    store.identities = store.identities.filter((r) => r.agentSession !== agentSession);
    await this.save();
    return removed;
  }

  // -------------------------------------------------------------------------
  // Local cache
  // -------------------------------------------------------------------------

  /**
   * All cached identities (tokens included — callers must not log them).
   *
   * @returns Copies
   */
  async list(): Promise<SlackAgentIdentityRecord[]> {
    const store = await this.load();
    return store.identities.map((r) => ({ ...r }));
  }

  /**
   * Cached identity for an agent, if any. Synchronous read of the loaded
   * cache (call {@link list} or any Cloud method first to load it).
   *
   * @param agentSession - The agent
   * @returns The record or null
   */
  get(agentSession: string): SlackAgentIdentityRecord | null {
    return this.store?.identities.find((r) => r.agentSession === agentSession) ?? null;
  }

  /**
   * Installed identity (bot user + token) for an agent, or null.
   *
   * @param agentSession - The agent
   * @returns `{ botUserId, botToken }` when installed
   */
  getInstalled(agentSession: string): { botUserId: string; botToken: string } | null {
    const r = this.get(agentSession);
    if (r && r.status === 'installed' && r.botUserId && r.botToken) {
      return { botUserId: r.botUserId, botToken: r.botToken };
    }
    return null;
  }

  /**
   * Agent session for a Slack bot user id (native mention resolution).
   *
   * @param botUserId - Slack user id
   * @returns The agent session or null
   */
  findByBotUserId(botUserId: string): string | null {
    return this.store?.identities.find((r) => r.botUserId === botUserId)?.agentSession ?? null;
  }

  /**
   * Mark that an install link was announced in a channel / the bot was
   * invited into a channel, so it is not repeated.
   *
   * @param agentSession - The agent
   * @param patch - Channel ids to add to either list
   */
  async markChannel(agentSession: string, patch: { announcedIn?: string; invitedTo?: string }): Promise<void> {
    const store = await this.load();
    const r = store.identities.find((x) => x.agentSession === agentSession);
    if (!r) return;
    if (patch.announcedIn && !r.announcedIn.includes(patch.announcedIn)) r.announcedIn.push(patch.announcedIn);
    if (patch.invitedTo && !r.invitedTo.includes(patch.invitedTo)) r.invitedTo.push(patch.invitedTo);
    r.updatedAt = new Date(this.now()).toISOString();
    await this.save();
  }

  /** Load the cache once. */
  async load(): Promise<SlackAgentIdentitiesFile> {
    if (this.store) return this.store;
    if (!this.loading) {
      this.loading = safeReadJson<SlackAgentIdentitiesFile>(this.storePath, EMPTY).then((raw) => {
        const identities = Array.isArray(raw?.identities) ? raw.identities.filter(isRecord) : [];
        this.store = { version: 1, identities };
        if (identities.some((r) => r.status === 'pending_install')) this.ensurePolling();
        return this.store;
      });
    }
    return this.loading;
  }

  /** Stop timers (shutdown / tests). */
  stop(): void {
    this.stopPolling();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async mergeView(view: CloudAgentView): Promise<SlackAgentIdentityRecord> {
    const store = await this.load();
    const nowIso = new Date(this.now()).toISOString();
    let record = store.identities.find((r) => r.agentSession === view.agentSession);
    const wasInstalled = record?.status === 'installed';
    if (!record) {
      record = {
        agentSession: view.agentSession,
        displayName: view.displayName,
        appId: view.appId,
        status: view.status,
        announcedIn: [],
        invitedTo: [],
        updatedAt: nowIso,
      };
      store.identities.push(record);
    }
    record.displayName = view.displayName;
    record.appId = view.appId;
    record.status = view.status;
    record.updatedAt = nowIso;
    if (view.botUserId) record.botUserId = view.botUserId;
    if (view.teamId) record.teamId = view.teamId;
    if (view.botToken) record.botToken = view.botToken;
    if (view.installUrl) record.installUrl = view.installUrl;
    else if (view.status === 'installed') delete record.installUrl;
    if (view.reinstall) record.reinstall = true;
    else delete record.reinstall;
    if (view.error) record.error = view.error;
    else delete record.error;
    await this.save();
    if (!wasInstalled && record.status === 'installed' && record.botToken) {
      this.logger.info('Slack agent identity installed', {
        agentSession: record.agentSession,
        botUserId: record.botUserId,
      });
      for (const l of this.listeners) {
        try {
          l({ ...record });
        } catch (err) {
          this.logger.warn('onInstalled listener threw', { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    return { ...record };
  }

  private async save(): Promise<void> {
    const store = await this.load();
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await atomicWriteJson(this.storePath, store);
    await fs.chmod(this.storePath, 0o600).catch(() => undefined);
  }

  private ensurePolling(): void {
    if (this.pollTimer) return;
    this.pollingSince = this.now();
    const setI = this.deps.setInterval ?? setInterval;
    this.pollTimer = setI(() => {
      void this.pollTick();
    }, SLACK_AGENT_IDENTITY_CONSTANTS.PENDING_POLL_INTERVAL_MS);
    // Never keep the process alive just for this.
    (this.pollTimer as { unref?: () => void }).unref?.();
  }

  private stopPolling(): void {
    if (!this.pollTimer) return;
    const clearI = this.deps.clearInterval ?? clearInterval;
    clearI(this.pollTimer);
    this.pollTimer = null;
  }

  /** One poll: refresh from Cloud; give up after the max age. */
  async pollTick(): Promise<void> {
    if (this.now() - this.pollingSince > SLACK_AGENT_IDENTITY_CONSTANTS.PENDING_POLL_MAX_AGE_MS) {
      this.logger.info('Stopped polling for pending Slack installs (max age reached)');
      this.stopPolling();
      return;
    }
    if (!this.isAvailable()) return;
    try {
      await this.refreshFromCloud();
    } catch (err) {
      this.logger.debug('Pending-install poll failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async cloudRequest<T>(method: 'GET' | 'PUT' | 'POST' | 'DELETE', suffix: string, body?: unknown): Promise<T> {
    const token = this.deps.cloud.getToken();
    const base = this.deps.cloud.getCloudUrl();
    if (!token || !base) {
      throw new SlackIdentityCloudError(401, 'not_logged_in', 'Not logged in to Crewly Cloud');
    }
    const url = `${base.replace(/\/$/, '')}${SLACK_AGENT_IDENTITY_CONSTANTS.CLOUD_PATH}${suffix}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SLACK_AGENT_IDENTITY_CONSTANTS.REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: { success?: boolean; data?: T; error?: string; code?: string } = {};
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        parsed = {};
      }
      if (!res.ok || parsed.success !== true) {
        throw new SlackIdentityCloudError(
          res.status,
          parsed.code ?? `http_${res.status}`,
          parsed.error ?? `Cloud request failed (${res.status})`,
        );
      }
      return parsed.data as T;
    } catch (err) {
      if (err instanceof SlackIdentityCloudError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new SlackIdentityCloudError(502, 'network', `Cloud unreachable: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function isRecord(value: unknown): value is SlackAgentIdentityRecord {
  const v = value as Partial<SlackAgentIdentityRecord> | null;
  return !!v && typeof v.agentSession === 'string' && typeof v.appId === 'string' && typeof v.status === 'string';
}

let instance: SlackAgentIdentityService | null = null;

/**
 * Install the process-wide instance (composition root).
 *
 * @param service - The service or null
 */
export function setSlackAgentIdentityService(service: SlackAgentIdentityService | null): void {
  instance = service;
}

/**
 * The process-wide instance, or null before wiring.
 *
 * @returns The service or null
 */
export function getSlackAgentIdentityService(): SlackAgentIdentityService | null {
  return instance;
}
