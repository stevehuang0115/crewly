/**
 * Wires {@link SharedChannelService} to the real Crewly: Cloud (machine token),
 * Team Chat and the orchestrator.
 *
 * @module services/shared-channel/shared-channel.wiring
 */

import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import { ORCHESTRATOR_SESSION_NAME, SHARED_CHANNEL_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import { SharedChannelService, type SharedChannelDeps } from './shared-channel.service.js';
import { SharedChannelCursorStore } from './shared-channel-cursor.store.js';
import { parseSharedChannelLinks, parseSharedChannelPage, parseSharedChannelPostAnswer, unwrapCloudData } from './shared-channel.types.js';
import { peekChatV2Service } from '../chat-v2/chat-v2.singleton.js';
import type { AgentRegistrationService } from '../agent/agent-registration.service.js';
import { deliverToLocalAgent } from '../messaging/deliver-to-local-agent.js';
import { SharedChannelSendService, type SharedChannelPostBody, type SharedChannelPostResult, type SharedSendDeps } from './shared-channel-send.service.js';
import { SharedChannelTrialStore } from './shared-channel-trial.store.js';

const logger = LoggerService.getInstance().createComponentLogger('SharedChannel');

let instance: SharedChannelService | null = null;
let sendInstance: SharedChannelSendService | null = null;
let listening = false;
let registration: AgentRegistrationService | null = null;

/** @returns The process-wide service, or null before {@link startSharedChannels} */
export function getSharedChannelService(): SharedChannelService | null {
  return instance;
}

/** Replace the process-wide service (tests). */
export function setSharedChannelService(service: SharedChannelService | null): void {
  instance = service;
}

/** @returns The process-wide send service, or null before {@link startSharedChannels} */
export function getSharedChannelSendService(): SharedChannelSendService | null {
  return sendInstance;
}

/** Replace the process-wide send service (tests). */
export function setSharedChannelSendService(service: SharedChannelSendService | null): void {
  sendInstance = service;
}

/**
 * GET a JSON answer from Cloud with this machine's token. Null on any failure.
 *
 * @param path - Path and query after the Cloud base URL
 * @returns Parsed body, or null
 */
async function cloudGet(path: string): Promise<unknown | null> {
  try {
    const { CloudClientService } = await import('../cloud/cloud-client.service.js');
    const client = CloudClientService.getInstance();
    const token = client.getToken();
    const base = client.getCloudUrl();
    if (!token || !base) return null;
    const response = await fetch(`${base.replace(/\/$/, '')}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(SHARED_CHANNEL_CONSTANTS.REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.debug('Cloud answered a shared-channel request with an error', { status: response.status });
      return null;
    }
    const body: unknown = await response.json().catch(() => null);
    return body === null ? null : unwrapCloudData(body);
  } catch (err) {
    logger.debug('Shared-channel request to Cloud failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Deliver text to the orchestrator: now when it is ready, held for it when busy, queued (and started) when down. */
async function notifyOrchestrator(text: string): Promise<void> {
  const res = await deliverToLocalAgent(registration, ORCHESTRATOR_SESSION_NAME, text, SHARED_CHANNEL_CONSTANTS.ORCHESTRATOR_READY_WAIT_MS);
  if (!res.success) throw new Error(res.error ?? 'delivery failed');
}

/**
 * POST a message to Cloud with this machine's token. Never throws: status 0
 * means Cloud could not be reached.
 *
 * @param linkId - Link id
 * @param body - Body of the crewly-auth send contract
 * @returns Cloud's answer
 */
export async function cloudPostSharedMessage(linkId: string, body: SharedChannelPostBody): Promise<SharedChannelPostResult> {
  try {
    const { CloudClientService } = await import('../cloud/cloud-client.service.js');
    const client = CloudClientService.getInstance();
    const token = client.getToken();
    const base = client.getCloudUrl();
    if (!token || !base) return { ok: false, status: 0, code: 'not_signed_in', error: 'this machine is not signed in to Crewly Cloud' };
    const response = await fetch(`${base.replace(/\/$/, '')}${SHARED_CHANNEL_CONSTANTS.LINKS_PATH}/${encodeURIComponent(linkId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SHARED_CHANNEL_CONSTANTS.REQUEST_TIMEOUT_MS),
    });
    const json: unknown = await response.json().catch(() => null);
    return parseSharedChannelPostAnswer(response.status, json, response.headers.get('retry-after'));
  } catch (err) {
    logger.debug('Shared-channel send to Cloud failed', { error: err instanceof Error ? err.message : String(err) });
    return { ok: false, status: 0, code: 'network', error: 'Crewly Cloud cannot be reached right now' };
  }
}

/**
 * Build the real dependencies.
 *
 * @param crewlyHome - Directory of the cursor file (default `~/.crewly`)
 */
export function buildSharedChannelDeps(crewlyHome: string = join(homedir(), '.crewly')): SharedChannelDeps {
  const cursors = SharedChannelCursorStore.inDir(crewlyHome, SHARED_CHANNEL_CONSTANTS.CURSOR_FILE);
  // `mirror` and `markRevoked` are synchronous in the service contract; the chat
  // service is looked up on each call (it may open after the wiring starts).
  return {
    listLinks: async () => {
      const body = await cloudGet(SHARED_CHANNEL_CONSTANTS.LINKS_PATH);
      return body === null ? null : parseSharedChannelLinks(body);
    },
    fetchMessages: async (linkId, after, limit) => {
      const q = `limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ''}`;
      const body = await cloudGet(`${SHARED_CHANNEL_CONSTANTS.LINKS_PATH}/${encodeURIComponent(linkId)}/messages?${q}`);
      return body === null ? null : parseSharedChannelPage(body);
    },
    cursors,
    mirror: (input) => {
      const service = chatRef ?? peekChatV2Service();
      if (!service) throw new Error('chat is not ready yet');
      return service.recordExternalMessage({
        linkId: input.linkId, counterpart: input.counterpart, messageId: input.messageId, senderName: input.senderName,
        direction: input.direction, text: input.text, createdAtMs: input.createdAtMs, ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      }) !== null;
    },
    markRevoked: (linkId, counterpart) => {
      (chatRef ?? peekChatV2Service())?.markExternalChannelRevoked(linkId, counterpart);
    },
    notifyOrchestrator,
    log: logger,
  };
}

/**
 * Build the real dependencies of the send side.
 *
 * @param crewlyHome - Directory of the trial file (default `~/.crewly`)
 * @returns Dependencies
 */
export function buildSharedChannelSendDeps(crewlyHome: string = join(homedir(), '.crewly')): SharedSendDeps {
  const trial = SharedChannelTrialStore.inDir(crewlyHome, SHARED_CHANNEL_CONSTANTS.TRIAL_FILE);
  return {
    listLinks: async () => {
      const body = await cloudGet(SHARED_CHANNEL_CONSTANTS.LINKS_PATH);
      return body === null ? null : parseSharedChannelLinks(body);
    },
    post: cloudPostSharedMessage,
    recordSent: (input) => {
      const service = chatRef ?? peekChatV2Service();
      if (!service) throw new Error('chat is not ready yet');
      // The row whether new or already filed: the owner's post is answered with it.
      return service.recordExternalMessageRow({
        linkId: input.linkId, counterpart: input.counterpart, messageId: input.messageId, senderName: input.senderName,
        direction: input.direction, text: input.text, createdAtMs: input.createdAtMs, ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      }).id;
    },
    trial,
    decisions: () => decisionsRef(),
    agentIdentity: async (session) => {
      if (session === ORCHESTRATOR_SESSION_NAME) return { name: SHARED_CHANNEL_CONSTANTS.ORCHESTRATOR_SENDER_NAME };
      const { StorageService } = await import('../core/storage.service.js');
      const found = await StorageService.getInstance().findMemberBySessionName(session);
      return { name: found?.member.name || session, ...(found?.team?.name ? { team: found.team.name } : {}) };
    },
    recentPeople: (session) => privateSourceRef?.(session) ?? [],
    newId: () => randomUUID(),
    instanceId: async () => {
      const { DeviceIdentityService } = await import('../cloud/device-identity.service.js');
      return (await DeviceIdentityService.getInstance().getOrCreateIdentity()).deviceId;
    },
    log: logger,
  };
}

type DecisionsLike = ReturnType<SharedSendDeps['decisions']>;
let decisionsRef: () => DecisionsLike = () => null;
let privateSourceRef: ((session: string) => string[]) | null = null;

type ChatLike = Pick<import('../chat-v2/chat-v2.service.js').ChatV2Service, 'recordExternalMessage' | 'recordExternalMessageRow' | 'markExternalChannelRevoked'>;
let chatRef: ChatLike | null = null;

/** Set the chat service the wiring writes to (tests). */
export function setSharedChannelChat(chat: ChatLike | null): void {
  chatRef = chat;
}

/**
 * Start shared channels: listen for Cloud pushes, then backfill every link on
 * boot and again whenever the relay reconnects after a gap. Idempotent. Never throws.
 *
 * @param agentRegistration - The agent registration service (delivery to the orchestrator)
 */
export async function startSharedChannels(agentRegistration: AgentRegistrationService): Promise<void> {
  try {
    registration = agentRegistration;
    const { CloudSyncService } = await import('../cloud/cloud-sync.service.js');
    if (!instance) instance = new SharedChannelService(buildSharedChannelDeps());
    if (!sendInstance) {
      const [{ DecisionService }, { getPrivateSourceTracker }] = await Promise.all([
        import('../decisions/decision.service.js'),
        import('../people/private-source.service.js'),
      ]);
      decisionsRef = () => DecisionService.getInstance();
      privateSourceRef = (session) => getPrivateSourceTracker().recentPeople(session);
      sendInstance = new SharedChannelSendService(buildSharedChannelSendDeps());
      // The owner's Send / Don't send on a held message lands here (crewly#1543 slice 5).
      DecisionService.registerKindHandler('shared_send', sendInstance);
    }
    if (listening) return;
    listening = true;
    const sync = CloudSyncService.getInstance();
    sync.on('message', (msg: { type: string; payload: unknown }) => {
      if (msg.type !== SHARED_CHANNEL_CONSTANTS.MESSAGE_TYPE && msg.type !== SHARED_CHANNEL_CONSTANTS.REVOKED_TYPE) return;
      void instance?.receive(msg.type, msg.payload).then((out) => {
        logger.info('Shared channel push handled', { type: msg.type, handled: out.handled, ...(out.mirrored !== undefined ? { mirrored: out.mirrored } : {}), ...(out.reason ? { reason: out.reason } : {}) });
      });
    });
    // Pushes missed while the relay was down are read again from Cloud's history.
    sync.on('inbound-gap-recovered', () => void instance?.syncAll());
    void instance.syncAll().then((n) => logger.info('Shared channels backfilled', { mirrored: n }));
    // Cloud may not be reachable yet at boot: read again a little later (cursors make it cheap).
    for (const delayMs of SHARED_CHANNEL_CONSTANTS.BOOT_RETRY_DELAYS_MS) {
      setTimeout(() => void instance?.syncAll(), delayMs).unref();
    }
    logger.info('Shared channels started');
  } catch (err) {
    logger.warn('Shared channels not started (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
  }
}
