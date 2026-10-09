/**
 * CloudTalkInboundService — the machine side of Cloud Talk
 * (specs/unified-conversations-cloud-store.md §D.3, Phase 3).
 *
 * The owner talks to an agent from the Crewly Cloud portal. Cloud stores the
 * message and pushes a `talk_message` relay message to this machine with
 * only ids in it (`{messageId, clientMessageId, instanceId, agentSession}`).
 * This service:
 *
 *  1. fetches the text from Cloud with this machine's own Cloud token
 *     (`GET /api/cloud/conversations/talk/:messageId?instanceId=`). Cloud only
 *     answers for a message stored on the token's account and addressed to
 *     this machine, so a push anybody else managed to drop in the relay
 *     queue is never delivered;
 *  2. records it in the agent's DM — the channel the dashboard and the
 *     agent's Slack DM use — with `source: 'cloud-talk'` and the Talk
 *     `clientMessageId` (idempotent: a re-push records nothing new). The
 *     conversation uploader then sends it back to Cloud with that
 *     `clientMessageId`, which is what marks it `delivered` there;
 *  3. hands it to the agent exactly like a Crewly Chat DM (ticket intake +
 *     the chat-v2 dispatcher, which wakes a sleeping agent). The agent
 *     answers in that DM; the reply-affinity rule (G6) keeps the answer off
 *     Slack because the owner's latest turn there came from Cloud Talk.
 *
 * A message for an agent this machine does not have is refused
 * (`POST …/talk/:messageId/failed`) so the portal says so. Fetch failures are
 * retried a few times; after that Cloud re-pushes the message on its own.
 *
 * Older OSS versions ignore `talk_message` (every relay listener filters on
 * its own `type`), and Cloud only sends it to machines that advertise the
 * `talk_message` capability, which this service turns on when it starts.
 *
 * @module services/cloud/cloud-talk-inbound.service
 */

import { CLOUD_TALK_CONSTANTS, ORCHESTRATOR_SESSION_NAME, SLACK_AGENT_DM_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { ChatChannelDTO, ChatMessageDTO, ChatPrincipal } from '../chat-v2/types.js';
import { recordCloudTalkTurn, type CloudTalkChat } from '../chat-v2/owner-inbound.utils.js';
import type { IncomingMessage } from './cloud-sync.types.js';
import { isDrivePayload } from '../drive/drive-cloud.contract.js';
import {
  parseTalkFetchResponse,
  parseTalkRelayData,
  type TalkFetchResponse,
  type TalkRelayData,
} from './conversation-ingest.contract.js';

/** Emitter of relay messages (CloudSyncService). */
export interface CloudTalkSource {
  on(event: 'message', listener: (msg: IncomingMessage) => void): unknown;
  off(event: 'message', listener: (msg: IncomingMessage) => void): unknown;
}

/** The Cloud session (CloudClientService). */
export interface CloudTalkCloud {
  getToken(): string | null;
  getCloudUrl(): string | null;
  /** Refresh an expired access token; true when a new one is in place. */
  tryRefreshToken?(): Promise<boolean>;
}

/** The chat-v2 operations needed (ChatV2Service). */
export interface CloudTalkInboundChat extends CloudTalkChat {
  getChannel(channelId: string, principal: ChatPrincipal): ChatChannelDTO;
}

/** `fetch` signature (injectable for tests). */
export type CloudTalkFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Constructor dependencies. */
export interface CloudTalkInboundDeps {
  source: CloudTalkSource;
  cloud: CloudTalkCloud;
  chat: CloudTalkInboundChat;
  /** This machine's id (device id = relay queue id = Cloud instance id) and name. */
  identity: () => Promise<{ instanceId: string; deviceName?: string }>;
  /** Hand the recorded message to the agent (ticket intake + dispatcher). */
  deliver: (channel: ChatChannelDTO, message: ChatMessageDTO) => Promise<void>;
  /** Whether the agent exists here; omitted = assume it does. */
  agentExists?: (agentSession: string) => Promise<boolean>;
  /** Owner principal of the DM channels (default: the single-user OSS owner). */
  ownerUserId?: string;
  fetchImpl?: CloudTalkFetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: ComponentLogger;
}

/** Outcome of the Talk fetch. */
type FetchOutcome =
  | { kind: 'ok'; message: TalkFetchResponse }
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'error'; error: string };

/** What {@link CloudTalkInboundService.handle} did with one push (tests, logs). */
export type CloudTalkOutcome =
  | 'delivered'
  | 'duplicate'
  | 'ignored'
  | 'not_for_this_machine'
  | 'unverified'
  | 'expired'
  | 'fetch_failed'
  | 'refused';

let active = false;

/**
 * Whether the Talk handler is running on this machine — Cloud is told the
 * machine handles `talk_message` only then.
 *
 * @returns True once started
 */
export function isCloudTalkInboundActive(): boolean {
  return active;
}

/**
 * Capabilities to advertise to Cloud (heartbeat and uploads).
 *
 * @returns `['talk_message']` while the handler runs, else `[]`
 */
export function cloudTalkCapabilities(): string[] {
  return active ? [CLOUD_TALK_CONSTANTS.CAPABILITY] : [];
}

/**
 * The machine's own session name for an agent Cloud names. Cloud already
 * uses local names; the per-machine Slack spelling of the orchestrator
 * (`crewly-orc@<instance>`) is folded back defensively.
 *
 * @param agentSession - Session as Cloud sent it
 * @returns Local session name
 */
function localSession(agentSession: string): string {
  return agentSession.startsWith(`${ORCHESTRATOR_SESSION_NAME}@`) ? ORCHESTRATOR_SESSION_NAME : agentSession;
}

/** Receives Cloud Talk messages — see module docs. */
export class CloudTalkInboundService {
  private readonly logger: ComponentLogger;
  private readonly fetchImpl: CloudTalkFetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly ownerUserId: string;
  private readonly inFlight = new Set<string>();
  private readonly listener = (msg: IncomingMessage): void => {
    void this.handle(msg);
  };
  private started = false;

  constructor(private readonly deps: CloudTalkInboundDeps) {
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('CloudTalkInbound');
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.ownerUserId = deps.ownerUserId ?? SLACK_AGENT_DM_CONSTANTS.OWNER_USER_ID;
  }

  /** Subscribe to relay messages and advertise the capability. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.deps.source.on('message', this.listener);
    active = true;
    this.logger.info('Cloud Talk handler started');
  }

  /** Unsubscribe; the capability is no longer advertised. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.deps.source.off('message', this.listener);
    active = false;
  }

  /**
   * Handle one relay message. Anything but a well-formed `talk_message` is
   * ignored. Never throws.
   *
   * @param msg - Relay message from CloudSyncService
   * @returns What was done
   */
  async handle(msg: IncomingMessage): Promise<CloudTalkOutcome> {
    if (msg?.type !== CLOUD_TALK_CONSTANTS.RELAY_MESSAGE_TYPE) return 'ignored';
    // Drive mode reuses the envelope (`kind: 'drive'`); DriveAgentService handles it.
    if (isDrivePayload(msg.payload)) return 'ignored';
    const data = parseTalkRelayData(msg.payload);
    if (!data) {
      this.logger.warn('Ignored a malformed talk_message relay message');
      return 'ignored';
    }
    if (this.inFlight.has(data.messageId)) return 'duplicate';
    this.inFlight.add(data.messageId);
    try {
      return await this.process(data);
    } catch (error) {
      this.logger.warn('Cloud Talk message handling failed', {
        messageId: data.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'fetch_failed';
    } finally {
      this.inFlight.delete(data.messageId);
    }
  }

  private async process(data: TalkRelayData): Promise<CloudTalkOutcome> {
    const { instanceId, deviceName } = await this.deps.identity();
    if (data.instanceId !== instanceId) {
      this.logger.warn('Ignored a talk_message addressed to another machine', { target: data.instanceId });
      return 'not_for_this_machine';
    }

    const fetched = await this.fetchMessage(data, instanceId);
    if (fetched.kind === 'not_found') {
      // Not a message Cloud stored for this account and machine: not from Cloud.
      this.logger.warn('Ignored a talk_message Crewly Cloud does not know for this machine', { messageId: data.messageId });
      return 'unverified';
    }
    if (fetched.kind === 'expired') {
      this.logger.info('Skipped a Cloud Talk message already marked as not delivered', { messageId: data.messageId });
      return 'expired';
    }
    if (fetched.kind === 'error') {
      this.logger.warn('Could not fetch a Cloud Talk message; Cloud will push it again', { messageId: data.messageId, error: fetched.error });
      return 'fetch_failed';
    }
    const message = fetched.message;
    if (message.clientMessageId !== data.clientMessageId || message.agentSession !== data.agentSession || message.instanceId !== instanceId) {
      this.logger.warn('Ignored a talk_message that does not match what Cloud stored', { messageId: data.messageId });
      return 'unverified';
    }

    const agentSession = localSession(message.agentSession);
    if (this.deps.agentExists && !(await this.deps.agentExists(agentSession))) {
      await this.reportFailed(data, instanceId, `No agent named "${agentSession}" on ${deviceName || 'this machine'}`);
      return 'refused';
    }

    let recorded: ReturnType<typeof recordCloudTalkTurn>;
    try {
      recorded = recordCloudTalkTurn(this.deps.chat, {
        agentSession,
        text: message.text,
        clientMessageId: message.clientMessageId,
        ownerUserId: this.ownerUserId,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.reportFailed(data, instanceId, `Could not record the message on ${deviceName || 'this machine'}: ${reason}`);
      return 'refused';
    }
    if (recorded.deduped) {
      // Already recorded (a re-push); the upload has confirmed it or will.
      return 'duplicate';
    }

    this.logger.info('Cloud Talk message received', { agentSession, messageId: data.messageId });
    try {
      const channel = this.deps.chat.getChannel(recorded.channelId, { userId: this.ownerUserId, source: 'oss' });
      await this.deps.deliver(channel, recorded.message);
    } catch (error) {
      // Recorded (so Cloud shows it delivered), but the agent was not paged.
      this.logger.warn('Cloud Talk message recorded but not handed to the agent', {
        agentSession,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return 'delivered';
  }

  private url(suffix: string): string | null {
    const base = this.deps.cloud.getCloudUrl();
    return base ? `${base.replace(/\/$/, '')}${CLOUD_TALK_CONSTANTS.MESSAGE_PATH}${suffix}` : null;
  }

  /**
   * Fetch the Talk message from Cloud with this machine's token; one token
   * refresh on 401, a few retries on network / 5xx errors.
   */
  private async fetchMessage(data: TalkRelayData, instanceId: string): Promise<FetchOutcome> {
    const url = this.url(`/${encodeURIComponent(data.messageId)}?instanceId=${encodeURIComponent(instanceId)}`);
    if (!url) return { kind: 'error', error: 'not signed in to Crewly Cloud' };
    const delays = CLOUD_TALK_CONSTANTS.FETCH_RETRY_DELAYS_MS;
    let refreshed = false;
    let lastError = 'unknown';
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await this.sleep(delays[attempt - 1]!);
      const token = this.deps.cloud.getToken();
      if (!token) return { kind: 'error', error: 'not signed in to Crewly Cloud' };
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(CLOUD_TALK_CONSTANTS.REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        continue;
      }
      if (response.status === 401 && !refreshed && this.deps.cloud.tryRefreshToken) {
        refreshed = true;
        if (await this.deps.cloud.tryRefreshToken().catch(() => false)) {
          attempt--; // the retry with the new token is free
          continue;
        }
      }
      if (response.status === 404) return { kind: 'not_found' };
      if (response.status === 410) return { kind: 'expired' };
      if (response.ok) {
        const parsed = parseTalkFetchResponse(await response.json().catch(() => null));
        return parsed ? { kind: 'ok', message: parsed } : { kind: 'error', error: 'unusable response from Crewly Cloud' };
      }
      lastError = `HTTP ${response.status}`;
      if (response.status >= 400 && response.status < 500 && response.status !== 429) break;
    }
    return { kind: 'error', error: lastError };
  }

  /** Tell Cloud this machine cannot deliver a message (best effort). */
  private async reportFailed(data: TalkRelayData, instanceId: string, error: string): Promise<void> {
    this.logger.warn('Cloud Talk message refused', { messageId: data.messageId, error });
    const url = this.url(`/${encodeURIComponent(data.messageId)}/failed`);
    const token = this.deps.cloud.getToken();
    if (!url || !token) return;
    try {
      await this.fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId, error }),
        signal: AbortSignal.timeout(CLOUD_TALK_CONSTANTS.REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Cloud marks it failed after 24 h anyway.
    }
  }
}
