/**
 * Slack Cloud Config Service — the Cloud-owned Slack setup, cached locally.
 *
 * Slack v3 ("Crewly Cloud owns Slack"): the owner installs the Crewly Slack
 * app once from the portal; every OSS instance signed in to the same Crewly
 * account then gets the workspace bot token, bot user id and the installed
 * per-agent identities from `GET /api/cloud/slack/config` — no manual
 * tokens. This service:
 *
 *  - fetches that config on boot and every 10 minutes while signed in;
 *  - caches it at `~/.crewly/slack-cloud-config.json` (mode 0600) so a
 *    restart without Cloud reachability still connects;
 *  - exposes the master bot as a {@link SlackConfig} with the `cloud`
 *    transport for `SlackService`, and the agents for
 *    `SlackAgentIdentityService`;
 *  - notifies listeners when the config appears, changes or goes away, so
 *    the initializer can (re)connect without a restart.
 *
 * Source precedence lives in {@link resolveSlackSourceMode}: unset → Cloud
 * wins when both exist (logged once), `CREWLY_SLACK_SOURCE=env` → never
 * touch Cloud, `CREWLY_SLACK_SOURCE=cloud` → never use local tokens.
 *
 * @module services/slack/slack-cloud-config.service
 */

import * as path from 'path';
import { promises as fs } from 'fs';
import type {
  SlackCloudAgentConfig,
  SlackCloudConfig,
  SlackCloudConfigFile,
  SlackConfig,
  SlackCloudWorkspaceSummary,
} from '../../types/slack.types.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { SLACK_CLOUD_CONSTANTS } from '../../constants.js';
import { SlackIdentityCloudError, type IdentityCloudClient } from './slack-agent-identity.service.js';

/** Where the Slack tokens come from. */
export type SlackSourceMode = 'env' | 'cloud' | 'auto';

/** Constructor dependencies. */
export interface SlackCloudConfigServiceDeps {
  cloud: IdentityCloudClient;
  /**
   * This instance's Cloud device id, when known. Sent with `GET /config` so
   * Cloud can serve the workspace this instance is bound to when the
   * account holds several.
   */
  getInstanceId?: () => string | null;
  /** Cache path; defaults to `<CREWLY_HOME>/slack-cloud-config.json`. */
  storePath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Timer overrides for tests. */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  /** Environment override for tests. */
  env?: NodeJS.ProcessEnv;
}

/** Listener for config changes (`null` = Cloud has no workspace any more). */
export type SlackCloudConfigListener = (config: SlackCloudConfig | null) => void;

/**
 * Read `CREWLY_SLACK_SOURCE` into a mode. Anything but `env` / `cloud`
 * (case-insensitive) is `auto`.
 *
 * @param env - Environment to read (defaults to `process.env`)
 * @returns The mode
 */
export function resolveSlackSourceMode(env: NodeJS.ProcessEnv = process.env): SlackSourceMode {
  const raw = (env[SLACK_CLOUD_CONSTANTS.SOURCE_ENV_VAR] ?? '').trim().toLowerCase();
  if (raw === 'env' || raw === 'cloud') return raw;
  return 'auto';
}

/**
 * Service — see module docs.
 */
export class SlackCloudConfigService {
  private readonly logger: ComponentLogger;
  private readonly deps: SlackCloudConfigServiceDeps;
  private readonly storePath: string;
  private readonly fetchImpl: typeof fetch;
  private config: SlackCloudConfig | null = null;
  private fetchedAt: string | null = null;
  private loading: Promise<SlackCloudConfig | null> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastError: string | null = null;
  /** Set when Cloud answered `workspace_not_selected`: the list to choose from. */
  private availableWorkspaces: SlackCloudWorkspaceSummary[] | null = null;
  private readonly listeners = new Set<SlackCloudConfigListener>();

  constructor(deps: SlackCloudConfigServiceDeps) {
    this.deps = deps;
    this.storePath =
      deps.storePath ?? path.join(getCrewlyHomePath(), SLACK_CLOUD_CONSTANTS.CONFIG_CACHE_FILENAME);
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.logger = LoggerService.getInstance().createComponentLogger('SlackCloudConfig');
  }

  // -------------------------------------------------------------------------
  // Availability / mode
  // -------------------------------------------------------------------------

  /**
   * Whether Cloud can be asked (signed in, url + token known) and the source
   * mode does not forbid it.
   *
   * @returns True when `refresh()` can reach Cloud
   */
  isAvailable(): boolean {
    if (this.getSourceMode() === 'env') return false;
    return this.deps.cloud.isConnected() && !!this.deps.cloud.getToken() && !!this.deps.cloud.getCloudUrl();
  }

  /**
   * The configured source mode (`CREWLY_SLACK_SOURCE`).
   *
   * @returns `env`, `cloud` or `auto`
   */
  getSourceMode(): SlackSourceMode {
    return resolveSlackSourceMode(this.deps.env ?? process.env);
  }

  // -------------------------------------------------------------------------
  // Cache + Cloud
  // -------------------------------------------------------------------------

  /**
   * Load the cached config from disk once. Never touches Cloud.
   *
   * @returns The cached config or null
   */
  async load(): Promise<SlackCloudConfig | null> {
    if (this.config) return this.config;
    if (!this.loading) {
      this.loading = safeReadJson<SlackCloudConfigFile | null>(this.storePath, null).then((raw) => {
        if (raw && isCloudConfig(raw.config)) {
          this.config = raw.config;
          this.fetchedAt = typeof raw.fetchedAt === 'string' ? raw.fetchedAt : null;
        }
        return this.config;
      });
    }
    return this.loading;
  }

  /**
   * Fetch `GET /api/cloud/slack/config`, update the cache and notify
   * listeners when the config changed. A 404 means the account has no
   * workspace installed: the cache is cleared. A network / Cloud failure
   * keeps whatever is cached and is reported via {@link getLastError}.
   *
   * @returns The current config after the refresh (cached on failure)
   */
  async refresh(): Promise<SlackCloudConfig | null> {
    await this.load();
    if (!this.isAvailable()) return this.config;
    try {
      const fetched = await this.fetchFromCloud();
      this.lastError = null;
      await this.apply(fetched);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger.warn('Cloud Slack config refresh failed — keeping cached copy', {
        error: this.lastError,
        cached: !!this.config,
      });
    }
    return this.config;
  }

  /**
   * Convenience for boot: cached copy first, then a Cloud refresh when
   * possible. Returns the best available config.
   *
   * @returns The config or null
   */
  async loadOrRefresh(): Promise<SlackCloudConfig | null> {
    await this.load();
    if (this.isAvailable()) await this.refresh();
    return this.config;
  }

  /**
   * Forget the cached config (workspace removed). Notifies listeners.
   */
  async clear(): Promise<void> {
    await this.apply(null);
  }

  /**
   * Remove the account's Slack workspace on Cloud (`DELETE
   * /api/cloud/slack/workspace`) and forget the local cache. Every instance
   * of the account loses Slack on its next refresh.
   *
   * @returns True when Cloud removed a workspace
   * @throws {SlackIdentityCloudError} on a Cloud failure
   */
  async removeWorkspace(): Promise<boolean> {
    const token = this.deps.cloud.getToken();
    const base = this.deps.cloud.getCloudUrl();
    if (!token || !base) {
      throw new SlackIdentityCloudError(401, 'not_logged_in', 'Not logged in to Crewly Cloud');
    }
    // Name the workspace this instance serves so an account with several
    // loses only this one.
    const current = this.config?.workspace.slackTeamId;
    const url =
      `${base.replace(/\/$/, '')}${SLACK_CLOUD_CONSTANTS.CLOUD_PATH}${SLACK_CLOUD_CONSTANTS.WORKSPACE_PATH}` +
      (current ? `/${encodeURIComponent(current)}` : '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SLACK_CLOUD_CONSTANTS.REQUEST_TIMEOUT_MS);
    let removed = false;
    try {
      const res = await this.fetchImpl(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: { success?: boolean; data?: { removed?: boolean }; error?: string; code?: string } = {};
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        parsed = {};
      }
      if (res.status !== 404 && (!res.ok || parsed.success !== true)) {
        throw new SlackIdentityCloudError(
          res.status,
          parsed.code ?? `http_${res.status}`,
          parsed.error ?? `Cloud request failed (${res.status})`,
        );
      }
      removed = res.ok && parsed.data?.removed !== false;
    } catch (err) {
      if (err instanceof SlackIdentityCloudError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new SlackIdentityCloudError(502, 'network', `Cloud unreachable: ${message}`);
    } finally {
      clearTimeout(timer);
    }
    await this.clear();
    return removed;
  }

  /**
   * Periodic refresh (every 10 min). Idempotent; never keeps the process
   * alive on its own.
   */
  start(): void {
    if (this.refreshTimer) return;
    const setI = this.deps.setInterval ?? setInterval;
    this.refreshTimer = setI(() => {
      void this.refresh();
    }, SLACK_CLOUD_CONSTANTS.CONFIG_REFRESH_INTERVAL_MS);
    (this.refreshTimer as { unref?: () => void }).unref?.();
  }

  /** Stop the periodic refresh. */
  stop(): void {
    if (!this.refreshTimer) return;
    const clearI = this.deps.clearInterval ?? clearInterval;
    clearI(this.refreshTimer);
    this.refreshTimer = null;
  }

  // -------------------------------------------------------------------------
  // Read model
  // -------------------------------------------------------------------------

  /**
   * The in-memory config (call {@link load} / {@link refresh} first).
   *
   * @returns The config or null
   */
  getConfig(): SlackCloudConfig | null {
    return this.config;
  }

  /**
   * ISO timestamp of the last successful Cloud fetch (or the cache's).
   *
   * @returns Timestamp or null
   */
  getFetchedAt(): string | null {
    return this.fetchedAt;
  }

  /**
   * Last refresh failure, if the most recent attempt failed.
   *
   * @returns Error message or null
   */
  getLastError(): string | null {
    return this.lastError;
  }

  /**
   * The master workspace as a {@link SlackConfig} for `SlackService`
   * (`transport: 'cloud'`, no socket credentials). Optional env knobs
   * (`SLACK_DEFAULT_CHANNEL`, `SLACK_ALLOWED_USERS`) still apply.
   *
   * @returns The config, or null without a workspace
   */
  toSlackConfig(): SlackConfig | null {
    const workspace = this.config?.workspace;
    if (!workspace?.botToken) return null;
    const env = this.deps.env ?? process.env;
    return {
      botToken: workspace.botToken,
      appToken: '',
      signingSecret: '',
      socketMode: false,
      transport: 'cloud',
      botUserId: workspace.botUserId,
      defaultChannelId: env.SLACK_DEFAULT_CHANNEL,
      allowedUserIds: env.SLACK_ALLOWED_USERS?.split(',').filter(Boolean),
    };
  }

  /**
   * Installed per-agent identities from the config.
   *
   * @returns Copies (tokens included — never log them)
   */
  getAgents(): SlackCloudAgentConfig[] {
    return (this.config?.agents ?? []).map((a) => ({ ...a }));
  }

  /**
   * Register a change listener. Fired after the cache is written.
   *
   * @param listener - Called with the new config (null when removed)
   * @returns Unsubscribe
   */
  onChange(listener: SlackCloudConfigListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Persist + notify when the config differs from the current one. */
  private async apply(next: SlackCloudConfig | null): Promise<void> {
    const changed = JSON.stringify(next) !== JSON.stringify(this.config);
    this.config = next;
    this.fetchedAt = new Date(this.now()).toISOString();
    if (next) {
      const file: SlackCloudConfigFile = { version: 1, fetchedAt: this.fetchedAt, config: next };
      await fs.mkdir(path.dirname(this.storePath), { recursive: true });
      await atomicWriteJson(this.storePath, file);
      await fs.chmod(this.storePath, 0o600).catch(() => undefined);
    } else {
      await fs.unlink(this.storePath).catch(() => undefined);
    }
    if (!changed) return;
    this.logger.info(next ? 'Cloud Slack config updated' : 'Cloud Slack config removed', {
      workspace: next?.workspace.slackTeamName,
      agents: next?.agents.length ?? 0,
    });
    for (const listener of this.listeners) {
      try {
        listener(next ? { ...next } : null);
      } catch (err) {
        this.logger.warn('onChange listener threw', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /**
   * Workspaces Cloud listed the last time it refused `/config` with
   * `workspace_not_selected`; null otherwise.
   *
   * @returns Copies, or null
   */
  getAvailableWorkspaces(): SlackCloudWorkspaceSummary[] | null {
    return this.availableWorkspaces ? this.availableWorkspaces.map((w) => ({ ...w })) : null;
  }

  /**
   * `GET /api/cloud/slack/workspaces` — every workspace on the account.
   *
   * @returns The list (empty when none is installed)
   * @throws {SlackIdentityCloudError} on a Cloud failure
   */
  async listWorkspaces(): Promise<SlackCloudWorkspaceSummary[]> {
    const token = this.deps.cloud.getToken();
    const base = this.deps.cloud.getCloudUrl();
    if (!token || !base) {
      throw new SlackIdentityCloudError(401, 'not_logged_in', 'Not logged in to Crewly Cloud');
    }
    const url = `${base.replace(/\/$/, '')}${SLACK_CLOUD_CONSTANTS.CLOUD_PATH}${SLACK_CLOUD_CONSTANTS.WORKSPACES_PATH}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SLACK_CLOUD_CONSTANTS.REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
      const text = await res.text();
      let parsed: { success?: boolean; data?: unknown; error?: string; code?: string } = {};
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        parsed = {};
      }
      if (!res.ok || parsed.success !== true || !Array.isArray(parsed.data)) {
        throw new SlackIdentityCloudError(res.status, parsed.code ?? `http_${res.status}`, parsed.error ?? `Cloud request failed (${res.status})`);
      }
      return (parsed.data as unknown[]).filter(isWorkspaceSummary);
    } catch (err) {
      if (err instanceof SlackIdentityCloudError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new SlackIdentityCloudError(502, 'network', `Cloud unreachable: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * `GET /api/cloud/slack/config?instanceId=…`; null on 404 (not connected)
   * and on 409 `workspace_not_selected` (several workspaces, none bound —
   * the list is kept in {@link getAvailableWorkspaces}).
   */
  private async fetchFromCloud(): Promise<SlackCloudConfig | null> {
    const token = this.deps.cloud.getToken();
    const base = this.deps.cloud.getCloudUrl();
    if (!token || !base) {
      throw new SlackIdentityCloudError(401, 'not_logged_in', 'Not logged in to Crewly Cloud');
    }
    const instanceId = this.deps.getInstanceId?.() ?? null;
    const url =
      `${base.replace(/\/$/, '')}${SLACK_CLOUD_CONSTANTS.CLOUD_PATH}${SLACK_CLOUD_CONSTANTS.CONFIG_PATH}` +
      (instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SLACK_CLOUD_CONSTANTS.REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (res.status === 404) {
        this.availableWorkspaces = null;
        return null;
      }
      const text = await res.text();
      let parsed: { success?: boolean; data?: unknown; error?: string; code?: string; details?: { workspaces?: unknown } } = {};
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        parsed = {};
      }
      if (res.status === 409 && parsed.code === 'workspace_not_selected') {
        const list = Array.isArray(parsed.details?.workspaces) ? (parsed.details!.workspaces as unknown[]) : [];
        this.availableWorkspaces = list.filter(isWorkspaceSummary);
        this.logger.info('Cloud holds several Slack workspaces; this instance has not chosen one yet', {
          workspaces: this.availableWorkspaces.map((w) => w.slackTeamName),
        });
        return null;
      }
      this.availableWorkspaces = null;
      if (!res.ok || parsed.success !== true) {
        throw new SlackIdentityCloudError(
          res.status,
          parsed.code ?? `http_${res.status}`,
          parsed.error ?? `Cloud request failed (${res.status})`,
        );
      }
      if (!isCloudConfig(parsed.data)) {
        throw new SlackIdentityCloudError(502, 'bad_config', 'Cloud returned a malformed Slack config');
      }
      return parsed.data;
    } catch (err) {
      if (err instanceof SlackIdentityCloudError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new SlackIdentityCloudError(502, 'network', `Cloud unreachable: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

/**
 * Runtime guard for the Cloud config payload.
 *
 * @param value - Parsed JSON
 * @returns True when it has a workspace with a bot token and an agents list
 */
export function isCloudConfig(value: unknown): value is SlackCloudConfig {
  const v = value as Partial<SlackCloudConfig> | null;
  if (!v || typeof v !== 'object') return false;
  const w = v.workspace as Partial<SlackCloudConfig['workspace']> | undefined;
  if (!w || typeof w.botToken !== 'string' || !w.botToken || typeof w.slackTeamId !== 'string') return false;
  if (!Array.isArray(v.agents)) return false;
  return v.agents.every(
    (a) =>
      a &&
      typeof (a as SlackCloudAgentConfig).agentSession === 'string' &&
      typeof (a as SlackCloudAgentConfig).botToken === 'string' &&
      typeof (a as SlackCloudAgentConfig).botUserId === 'string',
  );
}

/**
 * Runtime guard for a workspace summary from Cloud.
 *
 * @param value - Parsed JSON
 * @returns True when it names a Slack team
 */
export function isWorkspaceSummary(value: unknown): value is SlackCloudWorkspaceSummary {
  const v = value as Partial<SlackCloudWorkspaceSummary> | null;
  return !!v && typeof v === 'object' && typeof v.slackTeamId === 'string' && v.slackTeamId.length > 0 && typeof v.slackTeamName === 'string';
}

let instance: SlackCloudConfigService | null = null;

/**
 * Install the process-wide instance (composition root).
 *
 * @param service - The service or null
 */
export function setSlackCloudConfigService(service: SlackCloudConfigService | null): void {
  instance = service;
}

/**
 * The process-wide instance, or null before wiring.
 *
 * @returns The service or null
 */
export function getSlackCloudConfigService(): SlackCloudConfigService | null {
  return instance;
}
