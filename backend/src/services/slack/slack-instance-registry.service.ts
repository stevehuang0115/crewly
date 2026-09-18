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
import { teamChannelMembers } from './slack-team-channel.service.js';

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
  private deviceName: string | null = null;
  private version: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeStorage: (() => void) | null = null;
  private pendingInstalls: SlackPendingInstall[] = [];
  private lastHeartbeatAt: string | null = null;
  private lastError: string | null = null;
  private started = false;

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
    if (event.kind === 'team-saved' && event.created) {
      await this.syncAgents();
    }
    this.scheduleHeartbeat();
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
    const [{ deviceName }, teams, primary, version] = await Promise.all([
      this.resolveIdentity(),
      this.deps.storage.getTeams(),
      this.isPrimary(),
      this.resolveVersion(),
    ]);
    const teamChannels = this.deps.getTeamChannels();
    return {
      deviceName,
      relayQueueId: this.deps.sync.getQueueId() ?? '',
      primary,
      teams: teams.map((team) => {
        const channelId = teamChannels?.findByTeamId(team.id)?.slackChannelId;
        return {
          teamId: team.id,
          name: team.name,
          ...(channelId ? { channelId } : {}),
          agents: teamChannelMembers(team).map((m) => m.sessionName),
        };
      }),
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
    try {
      const { deviceId } = await this.resolveIdentity();
      const payload = await this.buildPayload();
      if (!payload.relayQueueId) {
        this.logger.debug('Relay queue not registered yet — skipping Slack registry heartbeat');
        return false;
      }
      await this.cloudRequest('PUT', `${SLACK_CLOUD_CONSTANTS.INSTANCES_PATH}/${encodeURIComponent(deviceId)}`, payload);
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
      const payload: SlackAgentsSyncPayload = {
        teams: teams.map((team) => ({
          teamId: team.id,
          name: team.name,
          agents: teamChannelMembers(team).map((m) => ({
            agentSession: m.sessionName,
            displayName: m.name || m.sessionName,
            ...(m.avatar ? { avatar: m.avatar } : {}),
          })),
        })),
      };
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
    this.settings = { version: 1, primary: raw?.primary === true };
    return this.settings;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async cloudRequest<T = unknown>(method: 'PUT' | 'POST', suffix: string, body: unknown): Promise<T> {
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
        body: JSON.stringify(body),
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
