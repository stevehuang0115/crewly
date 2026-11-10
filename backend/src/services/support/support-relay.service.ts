/**
 * Support relay: the one door from a support grantee into this instance
 * (crewly#1558 slice 2).
 *
 * Listens for `api_request` messages that carry the relay's `supportGrant`
 * envelope (see {@link IncomingMessage.supportGrant}; cloud-sync copies it
 * from the TOP level of the relay wrapper, which the relay strips from every
 * sender payload). For each one, in order:
 *
 * 1. a malformed envelope is dropped (logged + audited, no answer);
 * 2. the owner's kill switch `support.allowGrantees` off → 403;
 * 3. an encrypted payload → 403 (the relay never vouches for one);
 * 4. a path outside clean `/support/*` → 403;
 * 5. a method the role may not use → 403 (viewer: GET; admin: GET, POST);
 * 6. otherwise the in-process {@link SupportApiService} answers.
 *
 * The answer goes back as `api_response` to the envelope's `replyQueueId`
 * (relay-validated as the grantee's queue). Every call is audited.
 *
 * Requests WITHOUT an envelope are not handled here (the mobile API relay
 * handles those for the owner, and its allowlist has no `/support/` path),
 * and requests WITH one are ignored by the mobile relay: a grantee never
 * reaches an owner route, and an owner call never runs as a grantee.
 *
 * @module services/support/support-relay.service
 */

import { SUPPORT_ACCESS_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { SupportAuditService, type SupportOutcome } from './support-audit.service.js';
import { supportError } from './support-api.service.js';
import {
  isSupportApiPath,
  roleAllowsMethod,
  supportCallerFromEnvelope,
  type SupportApiRequest,
  type SupportApiResponse,
  type SupportCaller,
  type SupportGrantEnvelope,
} from './support.types.js';

const C = SUPPORT_ACCESS_CONSTANTS;

/** The incoming relay message, as far as the support relay reads it. */
export interface SupportRelayIncomingMessage {
  type: string;
  payload: unknown;
  encrypted?: boolean;
  fromDeviceName?: string;
  /** Validated envelope; null = the wrapper had one but it was malformed; undefined = none */
  supportGrant?: SupportGrantEnvelope | null;
}

/** The cloud-sync surface the relay uses. */
export interface ISupportRelayCloudSync {
  on(event: 'message', handler: (msg: SupportRelayIncomingMessage) => void): void;
  off(event: 'message', handler: (msg: SupportRelayIncomingMessage) => void): void;
  sendToPeerQueueId(peerQueueId: string, type: string, payload: unknown): Promise<unknown>;
}

/** The support API surface the relay calls. */
export interface ISupportApi {
  handle(caller: SupportCaller, request: SupportApiRequest): Promise<SupportApiResponse>;
}

/** Constructor options. */
export interface SupportRelayOptions {
  cloudSync: ISupportRelayCloudSync;
  api: ISupportApi;
  /** The owner's kill switch (`support.allowGrantees`); a failure to read counts as off */
  allowGrantees: () => Promise<boolean>;
  audit?: Pick<SupportAuditService, 'note'>;
  logger?: Pick<ComponentLogger, 'info' | 'warn'>;
}

/**
 * Handles relay-vouched support requests.
 */
export class SupportRelayService {
  private readonly cloudSync: ISupportRelayCloudSync;
  private readonly api: ISupportApi;
  private readonly allowGrantees: () => Promise<boolean>;
  private readonly audit: Pick<SupportAuditService, 'note'>;
  private readonly logger: Pick<ComponentLogger, 'info' | 'warn'>;
  private handler: ((msg: SupportRelayIncomingMessage) => void) | null = null;

  /**
   * @param options - Cloud sync, API, kill switch, audit, logger
   */
  constructor(options: SupportRelayOptions) {
    this.cloudSync = options.cloudSync;
    this.api = options.api;
    this.allowGrantees = options.allowGrantees;
    this.audit = options.audit ?? new SupportAuditService();
    this.logger = options.logger ?? LoggerService.getInstance().createComponentLogger('SupportRelay');
  }

  /** Attach the relay listener. Idempotent. */
  start(): void {
    if (this.handler) return;
    this.handler = (msg) => {
      if (msg.type !== C.REQUEST_TYPE || msg.supportGrant === undefined) return;
      void this.handleRequest(msg).catch((error) => {
        this.logger.warn('Support request failed unexpectedly', { error: error instanceof Error ? error.message : String(error) });
      });
    };
    this.cloudSync.on('message', this.handler);
    this.logger.info('SupportRelayService started: granted support accounts can call /api/support');
  }

  /** Detach the relay listener. */
  stop(): void {
    if (this.handler) {
      this.cloudSync.off('message', this.handler);
      this.handler = null;
    }
  }

  /**
   * Check, answer and audit one support request. Exposed for tests.
   *
   * @param msg - Relay message carrying `supportGrant`
   * @returns When the answer was sent (or the request dropped)
   */
  async handleRequest(msg: SupportRelayIncomingMessage): Promise<void> {
    const payload = msg.payload as { id?: unknown; method?: unknown; path?: unknown; body?: unknown } | null | undefined;
    const method = typeof payload?.method === 'string' ? payload.method : '';
    const reqPath = typeof payload?.path === 'string' ? payload.path : '';
    // The attempted path is recorded as sent (cut short; the query is dropped by the audit).
    const auditPath = reqPath ? reqPath.slice(0, C.MAX_AUDIT_PATH_CHARS) : '(none)';

    if (!msg.supportGrant) {
      this.logger.warn('Support request with a malformed grant envelope dropped');
      this.audit.note({ caller: null, method, path: auditPath, outcome: 'refused', status: 400, code: C.CODES.BAD_REQUEST });
      return;
    }
    const caller = supportCallerFromEnvelope(msg.supportGrant);
    if (!payload || typeof payload.id !== 'string' || payload.id.length === 0) {
      this.logger.warn('Support request without an id dropped', { grantId: caller.grantId });
      this.audit.note({ caller, method, path: auditPath, outcome: 'refused', status: 400, code: C.CODES.BAD_REQUEST });
      return;
    }
    const id = payload.id;

    const refuse = async (status: number, code: string, error: string): Promise<void> => {
      this.audit.note({ caller, method, path: auditPath, outcome: 'refused', status, code });
      await this.reply(caller, id, supportError(status, code, error));
    };

    let allowed = false;
    try {
      allowed = await this.allowGrantees();
    } catch {
      allowed = false;
    }
    if (!allowed) return refuse(403, C.CODES.DISABLED, 'The owner of this instance has turned support access off');
    if (msg.encrypted === true) return refuse(403, C.CODES.ENCRYPTED, 'Support requests must not be encrypted');
    if (!isSupportApiPath(reqPath)) return refuse(403, C.CODES.PATH, 'A support grant reaches only /api/support/ paths');
    if (!roleAllowsMethod(caller.role, method)) return refuse(403, C.CODES.METHOD, `A ${caller.role} grant cannot send ${method || '(no method)'}`);

    const response = await this.api.handle(caller, { method, path: reqPath, ...(payload.body !== undefined ? { body: payload.body } : {}) });
    const outcome: SupportOutcome = response.status < 400 ? 'ok' : response.status === 500 || response.status === 503 ? 'error' : 'refused';
    const code = (response.body as { code?: unknown } | null)?.code;
    this.audit.note({ caller, method, path: reqPath, outcome, status: response.status, ...(typeof code === 'string' ? { code } : {}) });
    await this.reply(caller, id, response);
  }

  /**
   * Send the `api_response` to the grantee's queue.
   *
   * @param caller - Grantee
   * @param id - Request id
   * @param response - Status and body
   */
  private async reply(caller: SupportCaller, id: string, response: SupportApiResponse): Promise<void> {
    try {
      await this.cloudSync.sendToPeerQueueId(caller.replyQueueId, C.RESPONSE_TYPE, { id, status: response.status, body: response.body });
    } catch (error) {
      this.logger.warn('Failed to send support api_response', { grantId: caller.grantId, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
