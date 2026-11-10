/**
 * Wires {@link SharedChannelService} to the real Crewly: Cloud (machine token),
 * Team Chat and the orchestrator.
 *
 * @module services/shared-channel/shared-channel.wiring
 */

import { homedir } from 'os';
import { join } from 'path';
import { ORCHESTRATOR_SESSION_NAME, SHARED_CHANNEL_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import { SharedChannelService, type SharedChannelDeps } from './shared-channel.service.js';
import { SharedChannelCursorStore } from './shared-channel-cursor.store.js';
import { parseSharedChannelLinks, parseSharedChannelPage, unwrapCloudData } from './shared-channel.types.js';
import { peekChatV2Service } from '../chat-v2/chat-v2.singleton.js';
import type { AgentRegistrationService } from '../agent/agent-registration.service.js';

const logger = LoggerService.getInstance().createComponentLogger('SharedChannel');

let instance: SharedChannelService | null = null;
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
  const reg = registration;
  if (!reg) throw new Error('agent delivery is not ready yet');
  const session = ORCHESTRATOR_SESSION_NAME;
  const { getSessionBackendSync } = await import('../session/index.js');
  const running = !!getSessionBackendSync()?.sessionExists(session) || !!reg.getInProcessRuntime(session);
  if (running) {
    const ready = await reg.waitForAgentReady(session, 10_000);
    if (!ready) {
      reg.holdForBusyAgent(session, text);
      return;
    }
    const res = await reg.sendMessageToAgent(session, text);
    if (!res.success && !res.queued) throw new Error(res.error ?? 'delivery failed');
    return;
  }
  const [{ queueForOfflineAgent, getOfflineAgentWaker }, { StorageService }, { SubAgentMessageQueue }] = await Promise.all([
    import('../messaging/offline-agent-message.js'),
    import('../core/storage.service.js'),
    import('../messaging/sub-agent-message-queue.service.js'),
  ]);
  const queued = await queueForOfflineAgent(session, text, {
    findMember: (name) => StorageService.getInstance().findMemberBySessionName(name),
    enqueue: (name, data) => SubAgentMessageQueue.getInstance().enqueue(name, data),
    wake: getOfflineAgentWaker(),
  });
  if (!queued) throw new Error(`${session} is not running`);
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

type ChatLike = Pick<import('../chat-v2/chat-v2.service.js').ChatV2Service, 'recordExternalMessage' | 'markExternalChannelRevoked'>;
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
