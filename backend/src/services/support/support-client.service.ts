/**
 * Support client: how this machine reads a machine of an account that gave
 * this account support access (crewly#1558).
 *
 * Two jobs:
 *
 * 1. Ask Cloud, with this machine's own Cloud login, which grants this
 *    account RECEIVED and may use now (`/received`: the plain grant list
 *    is for a portal sign-in only), and which machines a grant reaches.
 * 2. Send one agent `GET` over the Cloud relay to a granted machine and wait
 *    for its answer. The request carries a random id; the answer comes back
 *    into this machine's relay queue as an `api_response` whose `data.id` is
 *    that id, and is picked off cloud-sync's `'message'` stream. Nothing else
 *    is matched: an `api_response` with an unknown id is left alone.
 *
 * Only the reads of {@link buildSupportReadPath} can be sent. The relay
 * decides whether the grant allows the request; this service turns its
 * refusals, the granted machine's refusals and a missing answer into the
 * small failure set of `SUPPORT_VIEW_CONSTANTS.FAILURES`.
 *
 * The Cloud token is used for the two Cloud lookups only. It is never
 * logged, returned or put in an error.
 *
 * `specs/2026-11-12-support-access-agent-read.md`
 *
 * @module services/support/support-client.service
 */

import { randomUUID } from 'crypto';
import { SUPPORT_ACCESS_CONSTANTS, SUPPORT_VIEW_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import {
  SupportViewError,
  buildSupportReadPath,
  failureFromAnswer,
  failureFromRelay,
  parseGrantMachines,
  parseReceivedGrants,
  type SupportRead,
  type SupportViewFailureCode,
  type SupportViewGrant,
  type SupportViewMachine,
} from './support-client.types.js';

const V = SUPPORT_VIEW_CONSTANTS;
const F = V.FAILURES;

/** A relay message, as far as the client reads it. */
export interface SupportClientIncomingMessage {
  type: string;
  payload: unknown;
}

/** The cloud-sync surface the client uses. */
export interface ISupportClientCloudSync {
  on(event: 'message', handler: (msg: SupportClientIncomingMessage) => void): void;
  off(event: 'message', handler: (msg: SupportClientIncomingMessage) => void): void;
  /** This machine's relay queue id, or null before registration */
  getQueueId(): string | null;
  sendSupportAgentRequest(peerQueueId: string, data: { id: string; method: string; path: string }, agentName: string): Promise<void>;
}

/** This machine's Cloud login, as far as the client needs it. */
export interface SupportClientCloudLogin {
  baseUrl: string;
  token: string;
}

/** Constructor options. */
export interface SupportClientOptions {
  cloudSync: ISupportClientCloudSync;
  /** This machine's Cloud login; null when it is not signed in */
  cloud: () => Promise<SupportClientCloudLogin | null>;
  fetchImpl?: typeof fetch;
  /** How long to wait for the granted machine's answer */
  responseTimeoutMs?: number;
  /** Request id source (tests) */
  newId?: () => string;
  logger?: Pick<ComponentLogger, 'info' | 'warn'>;
}

/** A request waiting for its answer. */
interface Pending {
  resolve: (answer: { status: number; body: unknown }) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Whether an error is a relay refusal carrying a status (and maybe a code).
 * Checked by shape so the client does not depend on cloud-sync's class.
 *
 * @param error - Thrown value
 * @returns True for `{ status: number, code: string | null }`
 */
function isRelayRefusal(error: unknown): error is { status: number; code: string | null } {
  return !!error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number';
}

/**
 * Reads granted machines for the agents of this account.
 */
export class SupportClientService {
  private readonly cloudSync: ISupportClientCloudSync;
  private readonly cloud: () => Promise<SupportClientCloudLogin | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly responseTimeoutMs: number;
  private readonly newId: () => string;
  private readonly logger: Pick<ComponentLogger, 'info' | 'warn'>;
  private readonly pending = new Map<string, Pending>();
  private handler: ((msg: SupportClientIncomingMessage) => void) | null = null;

  /**
   * @param options - Cloud sync, Cloud login, fetch, timeout, id source, logger
   */
  constructor(options: SupportClientOptions) {
    this.cloudSync = options.cloudSync;
    this.cloud = options.cloud;
    this.fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.responseTimeoutMs = options.responseTimeoutMs ?? V.RESPONSE_TIMEOUT_MS;
    this.newId = options.newId ?? randomUUID;
    this.logger = options.logger ?? LoggerService.getInstance().createComponentLogger('SupportClient');
  }

  /** Attach the answer listener. Idempotent. */
  start(): void {
    if (this.handler) return;
    this.handler = (msg) => this.onMessage(msg);
    this.cloudSync.on('message', this.handler);
  }

  /** Detach the listener and fail every request still waiting. */
  stop(): void {
    if (this.handler) {
      this.cloudSync.off('message', this.handler);
      this.handler = null;
    }
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve({ status: 0, body: null });
    }
  }

  /** How many requests are waiting for an answer (tests, diagnostics). */
  pendingCount(): number {
    return this.pending.size;
  }

  /**
   * The grants this account received and may use now.
   *
   * @returns Active received grants
   * @throws SupportViewError `not_connected` when this machine is not signed in or Cloud cannot be reached;
   *   `cloud_unsupported` when this Cloud has no received-grants list yet
   */
  async listGrants(): Promise<SupportViewGrant[]> {
    return parseReceivedGrants(await this.cloudGet(`${V.GRANTS_PATH}${V.RECEIVED_SUFFIX}`, F.CLOUD_UNSUPPORTED));
  }

  /**
   * The machines one grant reaches.
   *
   * @param grantId - Grant id (from {@link listGrants})
   * @returns Machines
   * @throws SupportViewError `access_ended` when the grant is no longer active; `not_connected` as above
   */
  async listMachines(grantId: string): Promise<SupportViewMachine[]> {
    return parseGrantMachines(await this.cloudGet(`${V.GRANTS_PATH}/${encodeURIComponent(grantId)}${V.INSTANCES_SUFFIX}`));
  }

  /**
   * Read one thing from a granted machine.
   *
   * @param machine - The machine (from {@link listMachines})
   * @param read - What to read
   * @param agentName - Name of the asking agent, sent as `supportAgent`
   * @returns The `data` of the granted machine's answer
   * @throws SupportViewError with the failure
   */
  async read(machine: Pick<SupportViewMachine, 'relayQueueId'>, read: SupportRead, agentName: string): Promise<unknown> {
    const path = buildSupportReadPath(read);
    if (!this.handler) throw new SupportViewError(F.NOT_CONNECTED);
    if (!machine.relayQueueId) throw new SupportViewError(F.OFFLINE);
    if (!this.cloudSync.getQueueId()) throw new SupportViewError(F.NOT_CONNECTED);
    if (this.pending.size >= V.MAX_PENDING) throw new SupportViewError(F.RATE_LIMITED);

    const id = this.newId();
    // Registered before the send: the answer may arrive before the send call returns.
    const answered = new Promise<{ status: number; body: unknown }>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ status: 0, body: null });
      }, this.responseTimeoutMs);
      this.pending.set(id, { resolve, timer });
    });

    try {
      await this.cloudSync.sendSupportAgentRequest(machine.relayQueueId, { id, method: SUPPORT_ACCESS_CONSTANTS.AGENT_METHOD, path }, agentName);
    } catch (error) {
      this.forget(id);
      if (isRelayRefusal(error)) throw new SupportViewError(failureFromRelay(error.status, error.code ?? null));
      this.logger.warn('Support read could not be sent', { error: error instanceof Error ? error.message : String(error) });
      throw new SupportViewError(F.NOT_CONNECTED);
    }

    const { status, body } = await answered;
    if (status === 0) throw new SupportViewError(F.OFFLINE);
    const record = body && typeof body === 'object' ? (body as { success?: unknown; code?: unknown; data?: unknown }) : null;
    if (status >= 200 && status < 300 && record?.success === true) return record.data;
    throw new SupportViewError(failureFromAnswer(status, typeof record?.code === 'string' ? record.code : null));
  }

  /**
   * Hand an `api_response` to the request waiting for it.
   *
   * @param msg - Relay message
   */
  private onMessage(msg: SupportClientIncomingMessage): void {
    if (msg?.type !== SUPPORT_ACCESS_CONSTANTS.RESPONSE_TYPE) return;
    const payload = msg.payload as { id?: unknown; status?: unknown; body?: unknown } | null | undefined;
    if (!payload || typeof payload.id !== 'string') return;
    const entry = this.pending.get(payload.id);
    if (!entry) return;
    this.forget(payload.id);
    const status = typeof payload.status === 'number' && Number.isInteger(payload.status) ? payload.status : 502;
    let size = 0;
    try {
      size = JSON.stringify(payload.body ?? null).length;
    } catch {
      size = Number.POSITIVE_INFINITY;
    }
    if (size > V.MAX_RESPONSE_CHARS) {
      this.logger.warn('Support answer larger than the cap dropped', { size });
      entry.resolve({ status: 502, body: null });
      return;
    }
    entry.resolve({ status, body: payload.body });
  }

  /**
   * Drop a waiting request and its timer.
   *
   * @param id - Request id
   */
  private forget(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
  }

  /**
   * `GET` a Cloud grants path with this machine's login.
   *
   * @param path - Path under the Cloud base URL
   * @param missing - What a 404 means: the grant is gone (default), or, for the
   *   received-grants list, a Cloud that does not have that list yet
   * @returns The response's `data` (or the body when it has none)
   * @throws SupportViewError `not_connected` / `access_ended` / `cloud_unsupported` / `failed`
   */
  private async cloudGet(path: string, missing: SupportViewFailureCode = F.ACCESS_ENDED): Promise<unknown> {
    let login: SupportClientCloudLogin | null = null;
    try {
      login = await this.cloud();
    } catch {
      login = null;
    }
    if (!login?.token || !login.baseUrl) throw new SupportViewError(F.NOT_CONNECTED);
    let response: Response;
    try {
      response = await this.fetchImpl(`${login.baseUrl.replace(/\/$/, '')}${path}`, {
        headers: { Authorization: `Bearer ${login.token}` },
        signal: AbortSignal.timeout(V.CLOUD_TIMEOUT_MS),
      });
    } catch {
      throw new SupportViewError(F.NOT_CONNECTED, 'Crewly Cloud could not be reached from this machine.');
    }
    if (response.status === 401) throw new SupportViewError(F.NOT_CONNECTED, 'This machine needs to sign in to Crewly Cloud again.');
    if (response.status === 404) throw new SupportViewError(missing);
    if (response.status === 403) throw new SupportViewError(F.ACCESS_ENDED);
    if (response.status === 429) throw new SupportViewError(F.RATE_LIMITED);
    if (!response.ok) throw new SupportViewError(F.FAILED, `Crewly Cloud answered ${response.status}.`);
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      throw new SupportViewError(F.FAILED, 'Crewly Cloud sent an answer that could not be read.');
    }
    const data = (body as { data?: unknown } | null)?.data;
    return data !== undefined ? data : body;
  }
}
