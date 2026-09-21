/**
 * Slack Instance Registry Service — tells Crewly Cloud what this instance
 * can handle, so Slack traffic reaches the right machine.
 *
 * Several OSS instances of one Crewly account may run at once (laptop,
 * VPS, …). Cloud receives every Slack event for the account's workspace and
 * routes it by a registry: which instance owns which team channel and which
 * agent sessions, and which instance is the **primary** (DMs to the master
 * bot and unmapped channels). This service keeps that registry fresh:
 *
 *  - `PUT /api/cloud/slack/instances/:instanceId` on boot, on every team
 *    save (debounced) and every 5 minutes, with the team → channel mapping
 *    from `SlackTeamChannelService` and each team's member session names;
 *  - `POST /api/cloud/slack/agents/sync` with the team roster on boot and
 *    when a team is created, so Cloud provisions the per-agent apps; the
 *    returned `installUrls` (agents still needing their one-time install
 *    click) are kept for Settings.
 *
 * `instanceId` is the Cloud device id (`DeviceIdentityService`), the relay
 * `queueId` comes from `CloudSyncService`, and `primary` is
 * `CREWLY_SLACK_PRIMARY=1` or the persisted Settings toggle
 * (`~/.crewly/slack-instance.json`).
 *
 * @module services/slack/slack-instance-registry.service
 */

import * as path from 'path';
import { promises as fs } from 'fs';
import type { Team } from '../../types/index.js';
import type {
  SlackAgentsSyncPayload,
  SlackAgentsSyncResult,
  SlackInstanceRegistryPayload,
  SlackInstanceSettingsFile,
  SlackPendingInstall,
  SlackTeamChannelMapping,
} from '../../types/slack.types.js';
import type { StorageEvent } from '../core/storage.service.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { SLACK_CLOUD_CONSTANTS } from '../../constants.js';
import { SlackIdentityCloudError, type IdentityCloudClient } from './slack-agent-identity.service.js';
import { teamChannelMembers, orchestratorSyncEntry } from './slack-team-channel.service.js';

/** The slice of DeviceIdentityService this service needs. */
export interface RegistryDeviceIdentity {
  getOrCreateIdentity(): Promise<{ deviceId: string; deviceName: string }>;
}

/** The slice of CloudSyncService this service needs. */
export interface RegistryCloudSync {
  getQueueId(): string | null;
}

/** The slice of StorageService this service needs. */
export interface RegistryStorage {
  getTeams(): Promise<Team[]>;
  onStorageEvent(listener: (event: StorageEvent) => Promise<void> | void): () => void;
}

/** The slice of SlackTeamChannelService this service needs. */
export interface RegistryTeamChannels {
  findByTeamId(teamId: string): SlackTeamChannelMapping | null;
}

/** Constructor dependencies. */
export interface SlackInstanceRegistryServiceDeps {
  cloud: IdentityCloudClient;
  identity: RegistryDeviceIdentity;
  sync: RegistryCloudSync;
  storage: RegistryStorage;
  /** Resolved lazily — the team-channel service is built after Slack connects. */
  getTeamChannels: () => RegistryTeamChannels | null;
  /**
   * The Slack workspace this instance is actually serving (the Cloud config
   * it connected with). Agent apps are created with that workspace's config
   * token. Falls back to the saved workspace choice when omitted.
   */
  getBoundWorkspaceId?: () => string | null;
  /** Crewly version reported to Cloud; read from package.json when omitted. */
  version?: string;
  /** Settings path; defaults to `<CREWLY_HOME>/slack-instance.json`. */
  settingsPath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

/**
 * Read the Crewly version from package.json (best-effort).
 *
 * @returns Version string or 'unknown'
 */
async function readCrewlyVersion(): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Service — see module docs.
 */
export class SlackInstanceRegistryService {
  private readonly logger: ComponentLogger;
  private readonly deps: SlackInstanceRegistryServiceDeps;
  private readonly settingsPath: string;
  private readonly fetchImpl: typeof fetch;
  private settings: SlackInstanceSettingsFile | null = null;
  private instanceId: string | null = null;
  /** Last synced roster per team, so a deleted team's bots can still be removed. */
  private readonly lastRoster = new Map<string, string[]>();
  private deviceName: string | null = null;
  private version: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeStorage: (() => void) | null = null;
  private pendingInstalls: SlackPendingInstall[] = [];
  private lastHeartbeatAt: string | null = null;
  private lastError: string | null = null;
  private started = false;
  /** Consecutive heartbeats skipped because the relay queue was not registered yet */
  private queueWaitRetries = 0;

  constructor(deps: SlackInstanceRegistryServiceDeps) {
    this.deps = deps;
    this.settingsPath =
      deps.settingsPath ?? path.join(getCrewlyHomePath(), SLACK_CLOUD_CONSTANTS.INSTANCE_SETTINGS_FILENAME);
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.logger = LoggerService.getInstance().createComponentLogger('SlackInstanceRegistry');
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Boot: heartbeat + agent sync now, then heartbeat every 5 minutes and on
   * every team save. Idempotent; never throws (Cloud failures are logged).
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribeStorage = this.deps.storage.onStorageEvent((event) => this.handleStorageEvent(event));
    const setI = this.deps.setInterval ?? setInterval;
    this.heartbeatTimer = setI(() => {
      void this.heartbeat();
    }, SLACK_CLOUD_CONSTANTS.REGISTRY_HEARTBEAT_INTERVAL_MS);
    (this.heartbeatTimer as { unref?: () => void }).unref?.();
    await this.heartbeat();
    await this.syncAgents();
  }

  /** Undo {@link start}. */
  stop(): void {
    if (!this.started) return;
    this.unsubscribeStorage?.();
    this.unsubscribeStorage = null;
    if (this.heartbeatTimer) {
      (this.deps.clearInterval ?? clearInterval)(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.debounceTimer) {
      (this.deps.clearTimeout ?? clearTimeout)(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.started = false;
  }

  /**
   * React to team lifecycle: every save re-registers (debounced — status
   * writes fire this too); a created team also provisions its agents.
   *
   * @param event - Storage event
   */
  async handleStorageEvent(event: StorageEvent): Promise<void> {
    if (event.kind === 'team-saved') {
      // Created: provision. Updated: a member may have been renamed or
      // removed — the sync renames / prunes on Cloud. Debounced by the
      // heartbeat schedule so a burst of status writes does not spam Cloud.
      this.scheduleAgentSync();
    } else if (event.kind === 'team-deleted') {
      await this.removeTeamAgents(event.teamId);
    }
    this.scheduleHeartbeat();
  }

  private agentSyncTimer: ReturnType<typeof setTimeout> | null = null;

  /** Coalesce team saves into one agent sync a few seconds later. */
  private scheduleAgentSync(): void {
    if (this.agentSyncTimer) return;
    const setT = this.deps.setTimeout ?? setTimeout;
    this.agentSyncTimer = setT(() => {
      this.agentSyncTimer = null;
      void this.syncAgents();
    }, SLACK_CLOUD_CONSTANTS.TEAM_SAVED_DEBOUNCE_MS);
    (this.agentSyncTimer as { unref?: () => void }).unref?.();
  }

  /**
   * A deleted team's agents lose their Slack apps. The team is gone from
   * storage, so the pruning sync cannot see it; the sessions are remembered
   * from the last registry payload instead.
   *
   * @param teamId - The deleted team
   */
  async removeTeamAgents(teamId: string): Promise<void> {
    const sessions = this.lastRoster.get(teamId) ?? [];
    this.lastRoster.delete(teamId);
    if (!this.isAvailable() || sessions.length === 0) return;
    for (const agentSession of sessions) {
      try {
        await this.cloudRequest('DELETE', `${SLACK_CLOUD_CONSTANTS.AGENTS_PATH}/${encodeURIComponent(agentSession)}`, undefined);
        this.logger.info('Slack agent app removed for deleted team', { teamId, agentSession });
      } catch (err) {
        this.logger.warn('Could not remove a deleted team\'s Slack agent app', {
          teamId,
          agentSession,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Cloud calls
  // -------------------------------------------------------------------------

  /**
   * Build the registry payload from the current teams, channel mappings
   * and settings.
   *
   * @returns The `PUT /instances/:id` body
   */
  async buildPayload(): Promise<SlackInstanceRegistryPayload> {
    const [{ deviceName }, teams, primary, version, slackTeamId] = await Promise.all([
      this.resolveIdentity(),
      this.deps.storage.getTeams(),
      this.isPrimary(),
      this.resolveVersion(),
      this.getWorkspaceId(),
    ]);
    const teamChannels = this.deps.getTeamChannels();
    // The Orchestrator Team is assembled by the teams API for display and is
    // never stored, so it is absent from `getTeams()` and has to be added by
    // hand — without it Cloud has no roster entry for this machine's orc and
    // every DM to its bot is stranded.
    const orc = orchestratorSyncEntry(deviceName);
    return {
      deviceName,
      relayQueueId: this.deps.sync.getQueueId() ?? '',
      primary,
      ...(slackTeamId ? { slackTeamId } : {}),
      teams: teams.map((team) => {
        const channelId = teamChannels?.findByTeamId(team.id)?.slackChannelId;
        return {
          teamId: team.id,
          name: team.name,
          ...(channelId ? { channelId } : {}),
          agents: teamChannelMembers(team).map((m) => m.sessionName),
        };
      }).concat(orc ? [{ teamId: orc.teamId, name: orc.name, agents: [orc.agentSession] }] : []),
      crewlyVersion: version,
    };
  }

  /**
   * `PUT /api/cloud/slack/instances/:instanceId`. Skipped (false) when not
   * signed in to Cloud or before the relay queue is registered.
   *
   * @returns True when Cloud accepted the registration
   */
  async heartbeat(): Promise<boolean> {
    if (!this.isAvailable()) return false;
    if (!this.deps.sync.getQueueId()) {
      // Cloud Sync registers its queue asynchronously right after login;
      // retry on the short debounce a few times, then leave it to the
      // 5-minute cadence (and team saves).
      this.logger.debug('Relay queue not registered yet — skipping Slack registry heartbeat');
      if (this.started && this.queueWaitRetries < SLACK_CLOUD_CONSTANTS.QUEUE_WAIT_MAX_RETRIES) {
        this.queueWaitRetries += 1;
        this.scheduleHeartbeat();
      }
      return false;
    }
    try {
      const { deviceId } = await this.resolveIdentity();
      const payload = await this.buildPayload();
      await this.cloudRequest('PUT', `${SLACK_CLOUD_CONSTANTS.INSTANCES_PATH}/${encodeURIComponent(deviceId)}`, payload);
      this.queueWaitRetries = 0;
      this.lastHeartbeatAt = new Date(this.now()).toISOString();
      this.lastError = null;
      this.logger.debug('Slack instance registered', {
        instanceId: deviceId,
        teams: payload.teams.length,
        primary: payload.primary,
      });
      return true;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger.warn('Slack instance registry heartbeat failed', { error: this.lastError });
      return false;
    }
  }

  /**
   * `POST /api/cloud/slack/agents/sync` with every team's roster; keeps the
   * returned pending install links.
   *
   * @returns Cloud's answer, or null when skipped / failed
   */
  async syncAgents(): Promise<SlackAgentsSyncResult | null> {
    if (!this.isAvailable()) return null;
    try {
      const teams = await this.deps.storage.getTeams();
      // The orchestrator is named after this machine, so two machines in one
      // Slack workspace get two bots instead of sharing the master one.
      const { deviceName } = await this.resolveIdentity();
      const orc = orchestratorSyncEntry(deviceName);
      // Every member of every team gets a bot (owner's call, 2026-09-18: an
      // agent must be @-able like a colleague even before its team has a
      // channel). Renames and removals follow through on each sync.
      const payload: SlackAgentsSyncPayload = {
        teams: teams.map((team) => {
          const members = teamChannelMembers(team);
          this.lastRoster.set(team.id, members.map((m) => m.sessionName));
          return {
            teamId: team.id,
            name: team.name,
            agents: members.map((m) => ({
              agentSession: m.sessionName,
              displayName: m.name || m.sessionName,
              ...(m.avatar ? { avatar: m.avatar } : {}),
            })),
          };
        }).concat(
          orc
            ? [{ teamId: orc.teamId, name: orc.name, agents: [{ agentSession: orc.agentSession, displayName: orc.displayName }] }]
            : [],
        ),
        prune: true,
      };
      const slackTeamId = this.deps.getBoundWorkspaceId?.() ?? (await this.getWorkspaceId());
      if (slackTeamId) payload.slackTeamId = slackTeamId;
      const result = await this.cloudRequest<SlackAgentsSyncResult>('POST', SLACK_CLOUD_CONSTANTS.AGENTS_SYNC_PATH, payload);
      this.pendingInstalls = Array.isArray(result?.installUrls)
        ? result.installUrls.filter((u) => u && typeof u.agentSession === 'string' && typeof u.url === 'string')
        : [];
      this.lastError = null;
      if (this.pendingInstalls.length > 0) {
        this.logger.info('Slack agent apps waiting for their install click', {
          agents: this.pendingInstalls.map((p) => p.agentSession),
        });
      }
      return { installUrls: [...this.pendingInstalls] };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger.warn('Slack agent sync failed', { error: this.lastError });
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Primary flag
  // -------------------------------------------------------------------------

  /**
   * Whether this instance is the account's primary: `CREWLY_SLACK_PRIMARY`
   * (`1`/`true`) wins, otherwise the persisted Settings toggle.
   *
   * @returns True when primary
   */
  async isPrimary(): Promise<boolean> {
    const raw = ((this.deps.env ?? process.env)[SLACK_CLOUD_CONSTANTS.PRIMARY_ENV_VAR] ?? '').trim().toLowerCase();
    if (raw === '1' || raw === 'true') return true;
    const settings = await this.loadSettings();
    return settings.primary;
  }

  /**
   * Persist the Settings toggle and re-register immediately so Cloud moves
   * the flag (it clears `primary` on the account's other instances).
   *
   * @param primary - The new value
   */
  async setPrimary(primary: boolean): Promise<void> {
    const settings = await this.loadSettings();
    settings.primary = primary;
    await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
    await atomicWriteJson(this.settingsPath, settings);
    await this.heartbeat();
  }

  // -------------------------------------------------------------------------
  // Read model
  // -------------------------------------------------------------------------

  /**
   * Agents still needing their one-time install click (from the last sync).
   *
   * @returns Copies
   */
  getPendingInstalls(): SlackPendingInstall[] {
    return this.pendingInstalls.map((p) => ({ ...p }));
  }

  /** @returns The Cloud device id once resolved */
  getInstanceId(): string | null {
    return this.instanceId;
  }

  /**
   * Resolve (and cache) the Cloud device id now, without a heartbeat.
   *
   * @returns The device id, or null when the identity store is unavailable
   */
  async resolveInstanceId(): Promise<string | null> {
    try {
      return (await this.resolveIdentity()).deviceId;
    } catch {
      return null;
    }
  }

  /** @returns ISO timestamp of the last accepted heartbeat */
  getLastHeartbeatAt(): string | null {
    return this.lastHeartbeatAt;
  }

  /** @returns Last Cloud failure, if the most recent call failed */
  getLastError(): string | null {
    return this.lastError;
  }

  /**
   * Whether Cloud can be reached.
   *
   * @returns True when signed in with a token and url
   */
  isAvailable(): boolean {
    return this.deps.cloud.isConnected() && !!this.deps.cloud.getToken() && !!this.deps.cloud.getCloudUrl();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private scheduleHeartbeat(): void {
    if (this.debounceTimer) return;
    const setT = this.deps.setTimeout ?? setTimeout;
    this.debounceTimer = setT(() => {
      this.debounceTimer = null;
      void this.heartbeat();
    }, SLACK_CLOUD_CONSTANTS.TEAM_SAVED_DEBOUNCE_MS);
    (this.debounceTimer as { unref?: () => void }).unref?.();
  }

  private async resolveIdentity(): Promise<{ deviceId: string; deviceName: string }> {
    if (this.instanceId && this.deviceName) return { deviceId: this.instanceId, deviceName: this.deviceName };
    const identity = await this.deps.identity.getOrCreateIdentity();
    this.instanceId = identity.deviceId;
    this.deviceName = identity.deviceName;
    return identity;
  }

  private async resolveVersion(): Promise<string> {
    if (this.version) return this.version;
    this.version = this.deps.version ?? (await readCrewlyVersion());
    return this.version;
  }

  private async loadSettings(): Promise<SlackInstanceSettingsFile> {
    if (this.settings) return this.settings;
    const raw = await safeReadJson<Partial<SlackInstanceSettingsFile> | null>(this.settingsPath, null);
    this.settings = {
      version: 1,
      primary: raw?.primary === true,
      ...(typeof raw?.slackTeamId === 'string' && raw.slackTeamId ? { slackTeamId: raw.slackTeamId } : {}),
    };
    return this.settings;
  }

  /**
   * The workspace this instance chose to serve (Settings), when the account
   * has several. Null = let Cloud decide (its binding, or the only one).
   *
   * @returns Slack team id or null
   */
  async getWorkspaceId(): Promise<string | null> {
    return (await this.loadSettings()).slackTeamId ?? null;
  }

  /**
   * Persist the workspace choice and re-register at once so Cloud re-binds
   * this instance; the next config refresh then serves that workspace.
   *
   * @param slackTeamId - Slack team id to serve
   */
  async setWorkspaceId(slackTeamId: string): Promise<void> {
    const settings = await this.loadSettings();
    settings.slackTeamId = slackTeamId;
    await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
    await atomicWriteJson(this.settingsPath, settings);
    await this.heartbeat();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async cloudRequest<T = unknown>(method: 'PUT' | 'POST' | 'DELETE', suffix: string, body: unknown): Promise<T> {
    const token = this.deps.cloud.getToken();
    const base = this.deps.cloud.getCloudUrl();
    if (!token || !base) {
      throw new SlackIdentityCloudError(401, 'not_logged_in', 'Not logged in to Crewly Cloud');
    }
    const url = `${base.replace(/\/$/, '')}${SLACK_CLOUD_CONSTANTS.CLOUD_PATH}${suffix}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SLACK_CLOUD_CONSTANTS.REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

let instance: SlackInstanceRegistryService | null = null;

/**
 * Install the process-wide instance (composition root).
 *
 * @param service - The service or null
 */
export function setSlackInstanceRegistryService(service: SlackInstanceRegistryService | null): void {
  instance = service;
}

/**
 * The process-wide instance, or null before wiring.
 *
 * @returns The service or null
 */
export function getSlackInstanceRegistryService(): SlackInstanceRegistryService | null {
  return instance;
}
