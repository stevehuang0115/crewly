/**
 * Mobile API Relay — generic REST passthrough over the Cloud relay queue.
 *
 * The Cloud relay's chat adapter (`ChatV2RelayAdapter`) services a CLOSED set
 * of chat RPCs. The mobile app needs more than chat — approvals, escalations,
 * teams, requests, task-pool, backups — and adding each as a bespoke RPC would
 * never keep up with the REST surface. Instead this service forwards a SMALL,
 * ALLOWLISTED subset of the local REST API over the relay:
 *
 *   phone →(relay queue)→ `api_request {id, method, path, body}`
 *     → allowlist check → local HTTP `http://127.0.0.1:<webPort>/api<path>`
 *     → `api_response {id, status, body}` →(relay queue)→ phone
 *
 * Security model: the relay only pairs devices under the SAME cloud account
 * (sha256 pairing code derived from the JWT sub — see RelayContext/PWA), so the
 * caller is the account owner. The allowlist below still constrains the surface
 * to read endpoints + a few explicitly-safe mutations (approve/resolve/send),
 * so a compromised phone session cannot, e.g., rewrite settings or run skills.
 *
 * @module services/cloud/mobile-api-relay.service
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** Inbound request payload (mirrors the chat_request envelope shape). */
export interface ApiRequestPayload {
  id: string;
  method: 'GET' | 'POST';
  /** Path under `/api`, e.g. `/escalations` or `/task-pool/items`. */
  path: string;
  body?: unknown;
}

/** Outbound response payload. */
export interface ApiResponsePayload {
  id: string;
  status: number;
  body: unknown;
}

/** Minimal cloud-sync surface (mirrors ChatV2RelayAdapter's ICloudSyncLike). */
export interface IMobileRelayCloudSync {
  on(event: 'message', handler: (msg: MobileRelayIncomingMessage) => void): void;
  off(event: 'message', handler: (msg: MobileRelayIncomingMessage) => void): void;
  sendMessage(toDeviceId: string, type: string, payload: unknown): Promise<unknown>;
}

/** Minimal incoming-message shape from CloudSyncService. */
export interface MobileRelayIncomingMessage {
  type: string;
  payload: unknown;
  from?: string;
  fromDeviceName?: string;
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

/**
 * Allowed `method path-prefix` pairs. A request passes when its method matches
 * and its path starts with one of the prefixes for that method. Keep this
 * tight: reads broadly, mutations only where the mobile UX needs them.
 */
export const MOBILE_API_ALLOWLIST: ReadonlyArray<{ method: 'GET' | 'POST'; prefix: string }> = [
  // Reads — status surfaces.
  { method: 'GET', prefix: '/teams' },
  { method: 'GET', prefix: '/requests' },
  { method: 'GET', prefix: '/task-pool' },
  { method: 'GET', prefix: '/escalations' },
  { method: 'GET', prefix: '/approvals' },
  { method: 'GET', prefix: '/health' },
  { method: 'GET', prefix: '/cloud/status' },
  { method: 'GET', prefix: '/cloud/devices' },
  { method: 'GET', prefix: '/team-health' },
  { method: 'GET', prefix: '/projects' },   // list + /:id + /:id/status|stats
  { method: 'GET', prefix: '/wiki/' },      // vaults/tree/page/search reads
  { method: 'GET', prefix: '/chat/' },      // LAN-parity chat reads (messages incl. ?cursor=)
  // Mutations — human-in-the-loop actions only.
  { method: 'POST', prefix: '/escalations/' }, // …/:id/resolve
  { method: 'POST', prefix: '/approvals/' },   // …/:id/approve|reject
];

/**
 * Check a request against {@link MOBILE_API_ALLOWLIST}. Also rejects path
 * traversal (`..`), protocol-relative tricks, and non-`/`-rooted paths.
 *
 * @param method - HTTP method of the proxied request.
 * @param path - Path under `/api`.
 * @returns true when the request may be proxied.
 */
export function isAllowedMobileApiCall(method: string, path: string): boolean {
  if (method !== 'GET' && method !== 'POST') return false;
  if (!path.startsWith('/') || path.includes('..') || path.startsWith('//')) return false;
  return MOBILE_API_ALLOWLIST.some((e) => e.method === method && path.startsWith(e.prefix));
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Constructor options. */
export interface MobileApiRelayOptions {
  cloudSync: IMobileRelayCloudSync;
  /** Local web port the REST API listens on (e.g. 8787). */
  webPort: number;
  logger?: ComponentLogger;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Listens for `api_request` messages on the relay and proxies allowlisted
 * calls to the local REST API, replying with `api_response`. Lifecycle
 * mirrors ChatV2RelayAdapter (start/stop, idempotent).
 */
export class MobileApiRelayService {
  private readonly cloudSync: IMobileRelayCloudSync;
  private readonly webPort: number;
  private readonly logger: ComponentLogger;
  private readonly fetchImpl: typeof fetch;
  private handler: ((msg: MobileRelayIncomingMessage) => void) | null = null;

  constructor(options: MobileApiRelayOptions) {
    this.cloudSync = options.cloudSync;
    this.webPort = options.webPort;
    this.logger =
      options.logger ?? LoggerService.getInstance().createComponentLogger('MobileApiRelay');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Attach the relay listener. Idempotent. */
  start(): void {
    if (this.handler) {
      this.logger.warn('MobileApiRelayService.start called twice — ignoring');
      return;
    }
    this.handler = (msg: MobileRelayIncomingMessage): void => {
      if (msg.type !== 'api_request') return;
      void this.handleRequest(msg);
    };
    this.cloudSync.on('message', this.handler);
    this.logger.info('MobileApiRelayService started — mobile app can call allowlisted REST over relay');
  }

  /** Detach the relay listener. Safe during shutdown. */
  stop(): void {
    if (this.handler) {
      this.cloudSync.off('message', this.handler);
      this.handler = null;
    }
  }

  /**
   * Validate, proxy, and reply to one `api_request`. Never throws — every
   * outcome (including allowlist rejection and local fetch failure) is
   * reported to the caller as an `api_response` so the phone never hangs.
   *
   * @param msg - The incoming relay message (payload: {@link ApiRequestPayload}).
   */
  private async handleRequest(msg: MobileRelayIncomingMessage): Promise<void> {
    const fromDevice = msg.from || msg.fromDeviceName || '';
    const payload = msg.payload as Partial<ApiRequestPayload> | undefined;
    if (!fromDevice || !payload || typeof payload.id !== 'string') {
      this.logger.warn('api_request missing sender or id — dropping');
      return;
    }

    const reply = async (status: number, body: unknown): Promise<void> => {
      const response: ApiResponsePayload = { id: payload.id as string, status, body };
      try {
        await this.cloudSync.sendMessage(fromDevice, 'api_response', response);
      } catch (err) {
        this.logger.warn('Failed to send api_response (phone will retry)', {
          id: payload.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const method = String(payload.method ?? '');
    const path = String(payload.path ?? '');
    if (!isAllowedMobileApiCall(method, path)) {
      this.logger.warn('api_request blocked by allowlist', { method, path });
      await reply(403, { success: false, error: `not allowed: ${method} ${path}` });
      return;
    }

    try {
      const url = `http://127.0.0.1:${this.webPort}/api${path}`;
      const res = await this.fetchImpl(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(method === 'POST' && payload.body !== undefined
          ? { body: JSON.stringify(payload.body) }
          : {}),
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      await reply(res.status, body);
    } catch (err) {
      this.logger.warn('api_request local proxy failed', {
        method,
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      await reply(502, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
