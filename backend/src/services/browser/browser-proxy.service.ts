/**
 * Browser Proxy Service
 *
 * Connects to the Cloud Relay as an 'agent' and provides addressed messaging
 * to browser instances. Any Crewly agent can call browser tools through this
 * service without needing relay pairing.
 *
 * Architecture:
 *   Agent → /api/browser/* → BrowserProxyService → Cloud Relay → Extension
 *   Extension → Cloud Relay → BrowserProxyService → HTTP response → Agent
 *
 * @module services/browser/browser-proxy.service
 */

import WebSocket from 'ws';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { BrowserCommandResponse } from './browser-bridge.service.js';
import { BROWSER_BRIDGE_CONSTANTS, BROWSER_PROXY_CONSTANTS } from '../../constants.js';

/** Minimal info about a connected browser instance. */
export interface BrowserInstanceInfo {
  /** Persistent UUID of the extension install */
  instanceId: string;
  /** User-set friendly name */
  instanceName: string;
  /** Relay session ID */
  sessionId: string;
  /** ISO timestamp of last activity (heartbeat, command, or event) */
  lastSeenAt: string;
  /**
   * Optional stable identifier of the physical device the extension runs on.
   * Used to dedup re-install events that produce a fresh `instanceId` UUID
   * for the same underlying browser. Backward compatible: if absent on either
   * side of a comparison, dedup is skipped — older ext builds that do not
   * emit this field continue to behave exactly as before.
   *
   * Spec: `.crewly/specs/browser-ext-stale-status-fix-2026-04-30.md`.
   */
  deviceFingerprint?: string;
}

/** Pending command waiting for a relay response. */
interface PendingProxyCommand {
  /** Resolve the promise with the response */
  resolve: (value: BrowserCommandResponse) => void;
  /** Reject the promise on timeout/error */
  reject: (reason: Error) => void;
  /** Timeout timer handle */
  timer: ReturnType<typeof setTimeout>;
}

/** Connection state of the proxy to the cloud relay. */
export type ProxyConnectionState = 'disconnected' | 'connecting' | 'connected';

/** Default relay WebSocket URL. */
const DEFAULT_RELAY_URL = 'wss://api.crewlyai.com/relay';

/** Heartbeat interval to keep the relay connection alive (ms). */
const HEARTBEAT_INTERVAL_MS = 25_000;

/** Reconnect delay after disconnection (ms). */
const RECONNECT_DELAY_MS = 5_000;

/** Maximum reconnect delay for exponential backoff (ms). */
const MAX_RECONNECT_DELAY_MS = 60_000;

/** Delay before retrying reconnect when no auth token is available (ms). */
const NO_TOKEN_RETRY_DELAY_MS = 30_000;

/**
 * Function type for resolving fresh auth tokens.
 * Used to fetch updated JWT from CloudClientService on reconnect.
 *
 * @returns Fresh JWT token string, or null if unavailable
 */
export type TokenResolver = () => string | null;

/**
 * BrowserProxyService connects to the Cloud Relay and routes browser commands
 * to specific extension instances using addressed messaging (relay_to).
 *
 * Singleton — one relay connection per backend instance.
 */
export class BrowserProxyService {
  private static instance: BrowserProxyService | null = null;
  private readonly logger: ComponentLogger;

  /** WebSocket connection to cloud relay */
  private ws: WebSocket | null = null;
  /** Current relay session ID (assigned after registration) */
  private sessionId: string | null = null;
  /** Connection state */
  private state: ProxyConnectionState = 'disconnected';
  /** Map of commandId → pending command awaiting response */
  private pendingCommands: Map<string, PendingProxyCommand> = new Map();
  /** Known browser instances from relay browser_list + browser_event */
  private instances: Map<string, BrowserInstanceInfo> = new Map();
  /** Command counter for unique IDs */
  private commandCounter = 0;
  /** Heartbeat interval timer */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Reconnect timer */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Wall-clock TTL sweep timer. Runs every {@link BROWSER_PROXY_CONSTANTS.SWEEP_INTERVAL_MS}
   * and purges any `BrowserInstanceInfo` whose `lastSeenAt` exceeds
   * {@link BROWSER_PROXY_CONSTANTS.STALE_PURGE_THRESHOLD_MS}. Independent of
   * the heartbeat — guards against the relay dropping a `disconnected` event.
   */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Auth token for relay registration */
  private authToken: string | null = null;
  /** Relay WebSocket URL */
  private relayUrl: string = DEFAULT_RELAY_URL;
  /** Whether auto-reconnect is enabled */
  private autoReconnect = true;
  /** Guard flag to prevent double handleDisconnect calls */
  private disconnecting = false;
  /** Consecutive reconnect attempt counter (for exponential backoff) */
  private reconnectAttempts = 0;
  /** Callback to resolve a fresh token on reconnect (avoids stale JWT) */
  private tokenResolver: TokenResolver | null = null;

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('BrowserProxy');
  }

  /**
   * Get the singleton instance.
   *
   * @returns BrowserProxyService instance
   */
  static getInstance(): BrowserProxyService {
    if (!BrowserProxyService.instance) {
      BrowserProxyService.instance = new BrowserProxyService();
    }
    return BrowserProxyService.instance;
  }

  /**
   * Reset singleton instance (for testing).
   */
  static resetInstance(): void {
    BrowserProxyService.instance = null;
  }

  /**
   * Register a token resolver function that provides fresh JWTs on reconnect.
   * This avoids reconnect loops caused by stale expired tokens.
   *
   * Typically called once during server startup with:
   *   `proxy.setTokenResolver(() => CloudClientService.getInstance().getToken())`
   *
   * @param resolver - Function returning a fresh JWT or null
   */
  setTokenResolver(resolver: TokenResolver): void {
    this.tokenResolver = resolver;
  }

  /**
   * Called externally when the auth token has been refreshed (e.g., by CloudClientService).
   * Updates the stored token so the next heartbeat/reconnect uses the fresh one.
   *
   * Behavior depends on current state:
   * - **connected**: re-registers with the relay using the new token immediately
   *   to prevent the relay from closing the connection due to an expired token.
   * - **disconnected** (with autoReconnect): triggers a reconnect using the fresh
   *   token. This handles the case where handleDisconnect gave up because no
   *   valid token was available at the time of disconnection.
   * - **connecting**: does nothing extra — the ongoing connection attempt will
   *   pick up the new token.
   *
   * @param newToken - Fresh JWT auth token
   */
  updateToken(newToken: string): void {
    const oldToken = this.authToken;
    this.authToken = newToken;

    if (oldToken === newToken) return;

    this.logger.info('Auth token updated', { state: this.state });

    // If currently connected, force a re-register so the relay accepts the new JWT.
    // The relay should respond with a new 'registered' message without dropping
    // the existing session, but if it does close, handleDisconnect will auto-reconnect.
    if (this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN) {
      this.sendRaw({
        type: 'register',
        role: 'agent',
        pairingCode: `backend-proxy-${Date.now()}`,
        token: this.authToken,
      });
      return;
    }

    // If disconnected and auto-reconnect is enabled but no reconnect is pending,
    // use the fresh token to reconnect now. This covers the scenario where
    // handleDisconnect stopped retrying because the token was stale/null.
    if (this.state === 'disconnected' && this.autoReconnect && !this.reconnectTimer) {
      this.logger.info('Triggering reconnect with fresh token after disconnect');
      this.reconnectAttempts = 0; // Reset backoff since we have a fresh token
      this.connect(this.authToken);
    }
  }

  /**
   * Connect to the cloud relay WebSocket server.
   *
   * Registers as role 'agent' with a pairing code matching the backend identity.
   * After connection, requests the browser instance list and subscribes to events.
   *
   * @param token - JWT auth token for relay registration
   * @param relayUrl - Optional relay URL override
   */
  connect(token: string, relayUrl?: string): void {
    if (this.state !== 'disconnected') {
      this.logger.warn('Already connected or connecting to relay');
      return;
    }

    this.authToken = token;
    if (relayUrl) this.relayUrl = relayUrl;
    this.state = 'connecting';
    this.autoReconnect = true;
    this.disconnecting = false;

    this.logger.info('Connecting to cloud relay for browser proxy', {
      url: this.relayUrl,
      attempt: this.reconnectAttempts,
    });

    // Close stale WS reference if any (prevents leaked event listeners)
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        // Ignore
      }
      this.ws = null;
    }

    this.ws = new WebSocket(this.relayUrl);

    this.ws.on('open', () => {
      this.logger.info('Relay WebSocket connected, registering as agent');
      this.sendRaw({
        type: 'register',
        role: 'agent',
        pairingCode: `backend-proxy-${Date.now()}`,
        token: this.authToken,
      });
    });

    this.ws.on('message', (data: Buffer | string) => {
      this.handleMessage(typeof data === 'string' ? data : data.toString('utf8'));
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.logger.info('Relay WebSocket closed', { code, reason: reason.toString() });
      this.handleDisconnect(code);
    });

    this.ws.on('error', (err: Error) => {
      this.logger.error('Relay WebSocket error', { error: err.message });
      // Don't call handleDisconnect here — 'close' event always fires after 'error'
      // and handleDisconnect is called from the close handler.
    });
  }

  /**
   * Disconnect from the cloud relay.
   */
  disconnect(): void {
    this.autoReconnect = false;
    this.reconnectAttempts = 0;
    this.cleanup();
  }

  /**
   * Check if the proxy is connected to the relay and has browser instances available.
   *
   * @returns True if connected and at least one browser instance is known
   */
  isAvailable(): boolean {
    return this.state === 'connected' && this.instances.size > 0;
  }

  /**
   * Check if the proxy has a live relay connection (even if no browsers registered yet).
   *
   * @returns True if WebSocket to relay is connected
   */
  isConnected(): boolean {
    return this.state === 'connected';
  }

  /**
   * Get the current connection state.
   *
   * @returns Connection state string
   */
  getState(): ProxyConnectionState {
    return this.state;
  }

  /**
   * Get the list of known browser instances.
   *
   * @returns Array of browser instance info
   */
  getInstances(): BrowserInstanceInfo[] {
    return Array.from(this.instances.values());
  }

  /**
   * Send a browser command to a specific instance (or the only connected one).
   *
   * Routes via relay_to addressed messaging. The command is forwarded by the
   * relay server to the matching browser extension, which executes the tool
   * and returns the response via relay_response.
   *
   * @param tool - Tool name (e.g. 'navigate', 'screenshot', 'getTabs')
   * @param params - Tool parameters
   * @param instance - Target instance name or ID (optional if only 1 connected)
   * @param timeoutMs - Command timeout in milliseconds
   * @param agentName - Agent name for extension banner display
   * @returns Response from the Chrome Extension
   * @throws Error if no instances available, target not found, or timeout
   */
  async sendCommand(
    tool: string,
    params?: Record<string, unknown>,
    instance?: string,
    timeoutMs: number = BROWSER_BRIDGE_CONSTANTS.COMMAND_TIMEOUT_MS,
    agentName?: string,
  ): Promise<BrowserCommandResponse> {
    if (this.state !== 'connected' || !this.ws) {
      throw new Error('Browser proxy not connected to relay');
    }

    // Resolve target instance
    const targetInstance = this.resolveInstance(instance);
    if (!targetInstance) {
      const available = this.getInstances().map((i) => i.instanceName).join(', ');
      throw new Error(
        instance
          ? `Browser instance "${instance}" not found. Available: ${available || 'none'}`
          : this.instances.size === 0
            ? `No browser instances connected`
            : `Could not resolve a browser instance from ${this.instances.size} candidates (none have a recent lastSeenAt). Available: ${available}`,
      );
    }

    const id = `proxy-${++this.commandCounter}-${Date.now()}`;
    const payload = JSON.stringify({
      id,
      tool,
      params: params ?? {},
      agentName,
    });

    return new Promise<BrowserCommandResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`Browser command '${tool}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingCommands.set(id, { resolve, reject, timer });

      this.sendRaw({
        type: 'relay_to',
        targetInstance: targetInstance.instanceName,
        payload,
      });

      this.logger.debug('Command sent via relay_to', {
        id,
        tool,
        target: targetInstance.instanceName,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  /**
   * Resolve which browser instance to target.
   *
   * Auto-select rules when no explicit `instance` is provided:
   *   - 0 instances → null (caller raises "No browser instances connected")
   *   - 1 instance  → that instance
   *   - N>1 instances → the freshest by `lastSeenAt`. This handles two cases:
   *       (a) Multiple Chromes connected (user gets the most-recently-active one).
   *       (b) Ghost entries left behind by a relay that has not yet pruned a
   *           stale session after the extension reconnected with a new sessionId.
   *           The freshest entry is the live one.
   *     Ties on `lastSeenAt` are broken by insertion order (Map iteration).
   *
   * @param instance - Explicit instance name/ID, or undefined for auto-select
   * @returns Matching BrowserInstanceInfo or null
   */
  private resolveInstance(instance?: string): BrowserInstanceInfo | null {
    if (!instance) {
      const size = this.instances.size;
      if (size === 0) return null;
      if (size === 1) {
        return this.instances.values().next().value ?? null;
      }
      // Multiple candidates → pick the freshest by lastSeenAt to tolerate
      // ghost entries from extension reconnect cycles and to pick the most
      // active browser when several are genuinely connected.
      let freshest: BrowserInstanceInfo | null = null;
      let freshestTs = -Infinity;
      for (const info of this.instances.values()) {
        const ts = Date.parse(info.lastSeenAt);
        if (Number.isFinite(ts) && ts > freshestTs) {
          freshestTs = ts;
          freshest = info;
        }
      }
      return freshest;
    }

    // Search by name or ID
    for (const info of this.instances.values()) {
      if (info.instanceName === instance || info.instanceId === instance) {
        return info;
      }
    }
    return null;
  }

  /**
   * Handle incoming WebSocket message from the relay.
   *
   * @param raw - Raw JSON string
   */
  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.logger.warn('Non-JSON relay message ignored');
      return;
    }

    const type = msg.type as string;

    switch (type) {
      case 'registered':
        this.sessionId = msg.sessionId as string;
        this.state = 'connected';
        this.reconnectAttempts = 0; // Reset backoff on successful registration
        this.startHeartbeat();
        this.startSweepTimer();
        this.logger.info('Registered with relay', { sessionId: this.sessionId });
        // Request browser instance list
        this.sendRaw({ type: 'list_browsers' });
        break;

      case 'browser_list':
        this.handleBrowserList(msg.instances as BrowserInstanceInfo[]);
        break;

      case 'browser_event':
        this.handleBrowserEvent(msg as Record<string, unknown>);
        break;

      case 'relay': {
        // Response from a browser instance — update lastSeenAt
        const senderSessionId = msg.senderSessionId as string | undefined;
        if (senderSessionId) {
          for (const inst of this.instances.values()) {
            if (inst.sessionId === senderSessionId) {
              inst.lastSeenAt = new Date().toISOString();
              break;
            }
          }
        }
        const payload = msg.payload as string;
        this.handleRelayPayload(payload);
        break;
      }

      case 'heartbeat_ack':
        // Heartbeat acknowledged — connection is healthy
        break;

      case 'error':
        this.handleRelayError(msg);
        break;

      default:
        this.logger.debug('Unhandled relay message', { type });
    }
  }

  /**
   * Handle relay error messages. AUTH_FAILED errors trigger an immediate
   * token refresh attempt before the relay closes the connection.
   *
   * @param msg - Error message from relay
   */
  private handleRelayError(msg: Record<string, unknown>): void {
    const code = msg.code as string;
    const message = msg.message as string;

    this.logger.warn('Relay error', { code, message });

    if (code === 'AUTH_FAILED') {
      // Token is expired/invalid OR the user's plan claim is stale (for
      // example, admin just upgraded the account from free → pro but the
      // in-memory JWT still carries plan:"free"). Try fast path first
      // (cached resolver), then fall back to an active refresh which
      // exchanges the refresh token against /api/cloud/refresh so the
      // new access + relay tokens carry the latest plan from MongoDB.
      const freshToken = this.tokenResolver?.();
      if (freshToken && freshToken !== this.authToken) {
        this.authToken = freshToken;
        this.logger.info('Fetched fresh token after AUTH_FAILED, will use on next reconnect');
        return;
      }

      // No cached fresh token — actively refresh. The tokenRefreshCallbacks
      // in CloudClientService will push the new relay/access token back to
      // this proxy via updateToken() once the refresh completes, so the next
      // reconnect attempt uses the post-plan-change token.
      this.logger.info('No cached fresh token; triggering active refresh after AUTH_FAILED');
      import('../cloud/cloud-client.service.js')
        .then(({ CloudClientService }) => CloudClientService.getInstance().tryRefreshToken())
        .then((ok) => {
          this.logger.info('Active refresh after AUTH_FAILED complete', { refreshed: ok });
        })
        .catch((err) => {
          this.logger.warn('Active refresh after AUTH_FAILED threw', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    } else if (code === 'BROWSER_NOT_FOUND' || code === 'BROWSER_UNAVAILABLE') {
      this.logger.warn('Browser not reachable via relay', { code });
    }
  }

  /**
   * Handle browser_list message from relay.
   *
   * Behavior:
   * 1. Clear and rebuild the local instance Map from the relay snapshot.
   *    `deviceFingerprint`, when present on incoming entries, is preserved
   *    via the spread so the dedup pass below can use it.
   * 2. Group entries by `deviceFingerprint`. For each group with more than
   *    one entry (relay snapshot contains a ghost row alongside the live
   *    row, e.g. extension was reinstalled and the relay still caches the
   *    previous session), invoke `dedupByFingerprint` with the freshest
   *    entry in the group — the freshest "wins" and older rows are removed.
   *
   * @param instances - Array of browser instance info from relay
   */
  private handleBrowserList(instances: BrowserInstanceInfo[]): void {
    const now = new Date().toISOString();
    this.instances.clear();
    for (const inst of instances) {
      this.instances.set(inst.instanceId, {
        ...inst,
        lastSeenAt: inst.lastSeenAt || now,
      });
    }

    // Dedup pass: for each fingerprint group with >1 entries, keep the
    // freshest by lastSeenAt and let dedupByFingerprint delete the rest.
    const fingerprintGroups = new Map<string, BrowserInstanceInfo[]>();
    for (const inst of this.instances.values()) {
      const fp = inst.deviceFingerprint;
      if (typeof fp !== 'string' || fp.length === 0) continue;
      const group = fingerprintGroups.get(fp);
      if (group) {
        group.push(inst);
      } else {
        fingerprintGroups.set(fp, [inst]);
      }
    }
    for (const group of fingerprintGroups.values()) {
      if (group.length < 2) continue;
      let freshest = group[0];
      let freshestTs = Date.parse(freshest.lastSeenAt);
      if (!Number.isFinite(freshestTs)) freshestTs = 0;
      for (let i = 1; i < group.length; i++) {
        const ts = Date.parse(group[i].lastSeenAt);
        const tsNum = Number.isFinite(ts) ? ts : 0;
        // `>=` (not `>`) so that ties resolve to the later-inserted entry,
        // matching Map iteration order semantics callers may rely on.
        if (tsNum >= freshestTs) {
          freshestTs = tsNum;
          freshest = group[i];
        }
      }
      this.dedupByFingerprint(freshest);
    }

    this.logger.info('Browser instances updated', {
      count: this.instances.size,
      names: instances.map((i) => i.instanceName),
    });
  }

  /**
   * Handle browser_event (connected/disconnected/updated) from relay.
   *
   * On `connected`, propagates the optional `deviceFingerprint` from the
   * relay payload onto the new entry, then runs `dedupByFingerprint` so
   * an older entry with the same fingerprint (e.g. previous install of
   * the extension on this device) is collapsed in favor of the new one.
   *
   * @param msg - Event message
   */
  private handleBrowserEvent(msg: Record<string, unknown>): void {
    const event = msg.event as string;
    const instanceId = msg.instanceId as string;
    const instanceName = msg.instanceName as string;
    const rawFingerprint = msg.deviceFingerprint;
    const deviceFingerprint =
      typeof rawFingerprint === 'string' && rawFingerprint.length > 0
        ? rawFingerprint
        : undefined;

    const now = new Date().toISOString();

    switch (event) {
      case 'connected': {
        const incoming: BrowserInstanceInfo = {
          instanceId,
          instanceName,
          sessionId: '', // Will be populated by next list_browsers
          lastSeenAt: now,
          deviceFingerprint,
        };
        this.instances.set(instanceId, incoming);
        this.dedupByFingerprint(incoming);
        this.logger.info('Browser instance connected', {
          instanceId,
          instanceName,
          hasFingerprint: deviceFingerprint !== undefined,
        });
        // Refresh full list to get sessionId
        this.sendRaw({ type: 'list_browsers' });
        break;
      }

      case 'disconnected':
        this.instances.delete(instanceId);
        this.logger.info('Browser instance disconnected', { instanceId, instanceName });
        break;

      case 'updated': {
        // Update name and lastSeenAt
        const existing = this.instances.get(instanceId);
        if (existing) {
          existing.instanceName = instanceName;
          existing.lastSeenAt = now;
        }
        break;
      }
    }
  }

  /**
   * Handle a relay payload (response from a browser instance).
   *
   * @param payload - JSON string containing the command response
   */
  private handleRelayPayload(payload: string): void {
    let response: BrowserCommandResponse;
    try {
      response = JSON.parse(payload) as BrowserCommandResponse;
    } catch {
      this.logger.warn('Failed to parse relay payload as command response');
      return;
    }

    if (!response.id) return;

    const pending = this.pendingCommands.get(response.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingCommands.delete(response.id);
      pending.resolve(response);
      this.logger.debug('Command response received', {
        id: response.id,
        success: response.success,
      });
    }
  }

  /**
   * Send a raw JSON message to the relay WebSocket.
   *
   * @param msg - Message object to serialize and send
   */
  private sendRaw(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Start heartbeat interval to keep relay connection alive.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendRaw({ type: 'heartbeat' });
      } else {
        // WS not open but heartbeat still running — stop and trigger reconnect
        this.logger.warn('Heartbeat firing but WS not open, triggering disconnect');
        this.stopHeartbeat();
        this.handleDisconnect();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Stop heartbeat interval.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Start the wall-clock TTL sweep timer.
   *
   * Independent of the heartbeat. Every
   * {@link BROWSER_PROXY_CONSTANTS.SWEEP_INTERVAL_MS} (default 60s) it walks
   * `this.instances` and deletes any entry whose `lastSeenAt` is older than
   * {@link BROWSER_PROXY_CONSTANTS.STALE_PURGE_THRESHOLD_MS} (default 5 min).
   *
   * Why: the relay is supposed to push a `browser_event:disconnected` when
   * an extension drops, but in practice that event is occasionally lost
   * (network blip, ext crash without graceful close). Without a sweep, the
   * `instances` Map accumulates phantom entries that the Cloud Portal then
   * renders as "Online" even though their `lastSeenAt` is hours stale.
   *
   * Idempotent: calls `stopSweepTimer()` first to avoid stacking intervals
   * on an already-running proxy (e.g. on reconnect).
   */
  private startSweepTimer(): void {
    this.stopSweepTimer();
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [instanceId, info] of this.instances) {
        const lastSeenMs = Date.parse(info.lastSeenAt);
        if (!Number.isFinite(lastSeenMs)) {
          // Bad timestamp — treat as stale to drain garbage rather than keep
          // a row we cannot reason about.
          this.instances.delete(instanceId);
          this.logger.info('Purged browser instance with unparseable lastSeenAt', {
            instanceId,
            instanceName: info.instanceName,
            lastSeenAt: info.lastSeenAt,
          });
          continue;
        }
        if (now - lastSeenMs > BROWSER_PROXY_CONSTANTS.STALE_PURGE_THRESHOLD_MS) {
          this.instances.delete(instanceId);
          this.logger.info('Purged stale browser instance', {
            instanceId,
            instanceName: info.instanceName,
            lastSeenAt: info.lastSeenAt,
          });
        }
      }
    }, BROWSER_PROXY_CONSTANTS.SWEEP_INTERVAL_MS);
  }

  /**
   * Stop the wall-clock TTL sweep timer. Safe to call when no timer is
   * running (no-op via the null guard).
   */
  private stopSweepTimer(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Collapse older entries in `this.instances` that share a `deviceFingerprint`
   * with the incoming entry.
   *
   * Use case: a user reinstalls / updates the Chrome extension. The fresh
   * install generates a new `instanceId` UUID and registers via the relay.
   * Without dedup, the Cloud Portal would show two rows for the same
   * physical browser — the new live one and the old phantom one — until
   * the TTL sweep eventually purges the old row 5 min later.
   *
   * Backward compatible: if `incoming.deviceFingerprint` is falsy or empty,
   * this is a no-op. Older ext builds that do not yet emit `deviceFingerprint`
   * therefore continue to behave exactly as before — the TTL sweep alone
   * still cleans them up over the 5-min threshold.
   *
   * @param incoming - Entry that was just registered/refreshed
   */
  private dedupByFingerprint(incoming: BrowserInstanceInfo): void {
    const fp = incoming.deviceFingerprint;
    if (typeof fp !== 'string' || fp.length === 0) return;

    for (const [otherId, other] of this.instances) {
      if (otherId === incoming.instanceId) continue;
      if (other.deviceFingerprint === fp) {
        this.instances.delete(otherId);
        this.logger.info('Deduped older instance by fingerprint', {
          keptInstanceId: incoming.instanceId,
          removedInstanceId: otherId,
          deviceFingerprint: fp,
        });
      }
    }
  }

  /**
   * Handle disconnection — clean up and optionally reconnect with backoff.
   *
   * Protected against double-invocation (e.g. error + close events) via
   * the `disconnecting` guard flag.
   *
   * @param closeCode - WebSocket close code (if available)
   */
  private handleDisconnect(closeCode?: number): void {
    // Guard against double-invocation from error + close events
    if (this.disconnecting) return;
    this.disconnecting = true;

    const previousState = this.state;
    this.state = 'disconnected';
    this.sessionId = null;
    this.stopHeartbeat();
    this.stopSweepTimer();

    // Clean up old WebSocket reference
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        if (this.ws.readyState !== WebSocket.CLOSED && this.ws.readyState !== WebSocket.CLOSING) {
          this.ws.close();
        }
      } catch {
        // Ignore
      }
      this.ws = null;
    }

    // Reject all pending commands
    for (const [id, pending] of this.pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Relay connection lost'));
      this.pendingCommands.delete(id);
    }

    // Auto-reconnect with exponential backoff
    if (this.autoReconnect) {
      // Resolve a fresh token — either from the resolver or the stored one
      let token = this.tokenResolver?.() ?? this.authToken;

      // If AUTH_FAILED (4003), the stored token is stale — only reconnect if we got a fresh one
      if (closeCode === 4003 && token === this.authToken) {
        // Token hasn't been refreshed — resolver returned same stale token.
        // Still attempt reconnect (CloudClient's proactive refresh may succeed soon).
        this.logger.warn('AUTH_FAILED but no fresh token available yet, will retry with backoff');
      }

      if (token) {
        this.authToken = token;
        this.reconnectAttempts++;

        // Exponential backoff: 5s, 10s, 20s, 40s, capped at 60s
        const delay = Math.min(
          RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
          MAX_RECONNECT_DELAY_MS,
        );

        this.logger.info('Scheduling reconnect', {
          attempt: this.reconnectAttempts,
          delayMs: delay,
          previousState,
          closeCode,
        });

        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.disconnecting = false;

          // Resolve token again right before connecting (may have been refreshed during backoff)
          const latestToken = this.tokenResolver?.() ?? this.authToken;
          if (latestToken) {
            this.authToken = latestToken;
          }

          this.connect(this.authToken!);
        }, delay);
      } else {
        // No token available right now. Schedule a single delayed retry.
        // If updateToken() receives a fresh token before this timer fires,
        // the timer will pick it up via this.authToken (already updated).
        // If updateToken() arrives after this timer fires with still-null token,
        // it will trigger connect() directly via the !this.reconnectTimer path.
        this.logger.warn('No auth token available for reconnect — will retry in 30s or when token arrives');
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.disconnecting = false;

          const latestToken = this.tokenResolver?.() ?? this.authToken;
          if (latestToken) {
            this.authToken = latestToken;
            this.reconnectAttempts = 0;
            this.connect(this.authToken);
          } else {
            this.logger.warn('Still no auth token after delayed retry — staying disconnected until token refresh');
          }
        }, NO_TOKEN_RETRY_DELAY_MS);
        this.disconnecting = false;
      }
    } else {
      this.disconnecting = false;
    }
  }

  /**
   * Full cleanup — close WebSocket, stop timers, clear state.
   */
  private cleanup(): void {
    this.stopHeartbeat();
    this.stopSweepTimer();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject all pending commands
    for (const [id, pending] of this.pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Browser proxy shutting down'));
    }
    this.pendingCommands.clear();

    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close(1000, 'Proxy shutdown');
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }

    this.state = 'disconnected';
    this.sessionId = null;
    this.instances.clear();
    this.disconnecting = false;
    this.reconnectAttempts = 0;
  }
}
