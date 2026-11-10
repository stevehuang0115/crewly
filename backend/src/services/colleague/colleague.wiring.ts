/**
 * Wires {@link ColleagueMessageService} to the real Crewly: the account
 * directory, local agent delivery, the Cloud relay queue and chat history.
 *
 * @module services/colleague/colleague.wiring
 */

import { COLLEAGUE_MESSAGE_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import type { DirectoryEntry } from '../slack/slack-directory.service.js';
import { ColleagueMessageService, type ColleagueDeps, type ColleagueRecord } from './colleague-message.service.js';
import { isColleagueWireMessage } from './colleague-message.types.js';
import { colleagueNotFoundHint } from './colleague-framing.js';
import type { AgentRegistrationService } from '../agent/agent-registration.service.js';

const logger = LoggerService.getInstance().createComponentLogger('ColleagueMessage');

let instance: ColleagueMessageService | null = null;
let registration: AgentRegistrationService | null = null;
let listening = false;

/** @returns The process-wide service, or null before {@link startColleagueMessaging} */
export function getColleagueMessageService(): ColleagueMessageService | null {
  return instance;
}

/** Replace the process-wide service (tests). */
export function setColleagueMessageService(service: ColleagueMessageService | null): void {
  instance = service;
}

/**
 * Write one row of an exchange to chat-v2. Never throws.
 *
 * @param r - The row
 */
export async function recordColleagueInChat(r: ColleagueRecord): Promise<void> {
  try {
    const { peekChatV2Service } = await import('../chat-v2/chat-v2.singleton.js');
    peekChatV2Service()?.recordColleagueMessage({
      agentSession: r.agentSession, peerKey: r.peerKey, peerLabel: r.peerLabel, direction: r.direction,
      messageId: r.messageId, content: r.text, ...(r.extra ? { extra: r.extra } : {}),
    });
  } catch (err) {
    logger.debug('Could not record a colleague message in chat', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Agents of this machine (teams + orchestrator) as directory entries. */
async function localAgents(): Promise<DirectoryEntry[]> {
  const { StorageService } = await import('../core/storage.service.js');
  const { DeviceIdentityService } = await import('../cloud/device-identity.service.js');
  const identity = await DeviceIdentityService.getInstance().getOrCreateIdentity();
  const entries: DirectoryEntry[] = [];
  const add = (name: string, agentSession: string, team: string | null): void => {
    entries.push({
      name, mention: null, botUserId: null, agentSession, team, machine: 'this machine', instanceId: identity.deviceId,
      source: 'this-machine', inChannel: false, kind: 'agent',
    });
  };
  for (const team of await StorageService.getInstance().getTeams()) {
    for (const m of team.members ?? []) if (m.sessionName && m.name) add(m.name, m.sessionName, team.name);
  }
  add('Orc', ORCHESTRATOR_SESSION_NAME, 'Crewly orchestrator');
  return entries;
}

/** Deliver text to a local agent: now when it runs, queued (and the agent started) when it is down. */
async function deliverLocal(session: string, text: string): Promise<{ success: boolean; queued?: boolean; error?: string }> {
  const reg = registration;
  if (!reg) return { success: false, error: 'agent delivery is not ready yet' };
  const { getSessionBackendSync } = await import('../session/index.js');
  const running = !!getSessionBackendSync()?.sessionExists(session) || !!reg.getInProcessRuntime(session);
  if (running) {
    const ready = await reg.waitForAgentReady(session, COLLEAGUE_MESSAGE_CONSTANTS.LIVE_READY_WAIT_MS);
    if (!ready) {
      reg.holdForBusyAgent(session, text);
      return { success: true, queued: true };
    }
    const res = await reg.sendMessageToAgent(session, text);
    return { success: res.success || !!res.queued, ...(res.queued ? { queued: true } : {}), ...(res.error ? { error: res.error } : {}) };
  }
  // Down: the same queue-and-wake path an owner or agent message to a stopped member takes.
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
  return queued ? { success: true, queued: true } : { success: false, error: `${session} is not running` };
}

/** Build the real dependencies. */
export function buildColleagueDeps(): ColleagueDeps {
  return {
    self: async () => {
      const { DeviceIdentityService } = await import('../cloud/device-identity.service.js');
      const id = await DeviceIdentityService.getInstance().getOrCreateIdentity();
      return { instanceId: id.deviceId, deviceName: id.deviceName };
    },
    listDirectory: async () => {
      const { getSlackDirectoryService } = await import('../slack/slack-directory.service.js');
      const dir = getSlackDirectoryService();
      if (!dir) return null;
      return await Promise.race([
        dir.list(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), COLLEAGUE_MESSAGE_CONSTANTS.DIRECTORY_LOOKUP_MS)),
      ]);
    },
    listLocalAgents: localAgents,
    describeLocal: async (session) => {
      if (session === ORCHESTRATOR_SESSION_NAME) return { name: 'Orc', team: 'Crewly orchestrator' };
      const { StorageService } = await import('../core/storage.service.js');
      const found = await StorageService.getInstance().findMemberBySessionName(session);
      return found ? { name: found.member.name ?? session, ...(found.team?.name ? { team: found.team.name } : {}) } : null;
    },
    deliverLocal,
    sendRemote: async (instanceId, wire) => {
      const { CloudSyncService } = await import('../cloud/cloud-sync.service.js');
      const sync = CloudSyncService.getInstance();
      if (!sync.isStarted()) return { ok: false, code: 'cloud_unavailable', error: 'this machine is not connected to Crewly Cloud' };
      // Only a machine of this account is ever addressed, and the relay queue
      // id comes from the account's machine list, never from the message. The
      // machine list carries the queue the machine polls now; the device list's
      // sessionId for an instance id can be an old queue nobody polls (Fern →
      // Pia, 11-10: "delivered", never arrived), so it is only the fallback.
      const queueId = (await accountInstances()).get(instanceId)
        ?? sync.getDevices().find((d) => d.deviceId === instanceId && !!d.sessionId)?.sessionId;
      if (!queueId) {
        return { ok: false, code: 'machine_unknown', error: 'that machine is not in the list of this account\'s machines (is it signed in to the same Crewly account?)' };
      }
      try {
        await sync.sendToPeerQueueId(queueId, COLLEAGUE_MESSAGE_CONSTANTS.MESSAGE_TYPE, wire);
        return { ok: true };
      } catch (err) {
        return { ok: false, code: 'send_failed', error: err instanceof Error ? err.message : String(err) };
      }
    },
    isAccountMachine: (instanceId) => {
      try {
        // Lazy require-free check against the cached account device list.
        return accountDeviceIds().has(instanceId);
      } catch {
        return false;
      }
    },
    isMachineOnline: (instanceId) => {
      const d = cloudDevices().find((x) => x.deviceId === instanceId);
      return d ? d.status === 'online' : null;
    },
    isPaused: (session) => pausedCheck?.(session) ?? false,
    record: (r) => void recordColleagueInChat(r),
  };
}

type CloudDeviceLite = { deviceId: string; status: string };
let cloudSyncRef: { getDevices(): CloudDeviceLite[] } | null = null;
let pausedCheck: ((session: string) => boolean) | null = null;

function cloudDevices(): CloudDeviceLite[] {
  return cloudSyncRef?.getDevices() ?? [];
}
function accountDeviceIds(): Set<string> {
  const ids = new Set(cloudDevices().map((d) => d.deviceId));
  for (const id of instancesCache?.queues.keys() ?? []) ids.add(id);
  return ids;
}

let instancesCache: { at: number; queues: Map<string, string> } | null = null;

/**
 * The account's machines (instance id → relay queue id they poll now), from
 * `GET /api/cloud/slack/instances`, cached briefly. Empty when Cloud is not
 * reachable. Never throws.
 */
export async function accountInstances(): Promise<Map<string, string>> {
  if (instancesCache && Date.now() - instancesCache.at < COLLEAGUE_MESSAGE_CONSTANTS.INSTANCES_CACHE_MS) {
    return instancesCache.queues;
  }
  try {
    const { CloudClientService } = await import('../cloud/cloud-client.service.js');
    const client = CloudClientService.getInstance();
    const token = client.getToken();
    const base = client.getCloudUrl();
    if (!token || !base) return instancesCache?.queues ?? new Map();
    const response = await fetch(`${base.replace(/\/$/, '')}/api/cloud/slack/instances`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(COLLEAGUE_MESSAGE_CONSTANTS.DIRECTORY_LOOKUP_MS),
    });
    if (!response.ok) return instancesCache?.queues ?? new Map();
    const body = (await response.json().catch(() => ({}))) as { data?: unknown };
    const queues = new Map<string, string>();
    for (const row of Array.isArray(body.data) ? body.data : []) {
      const r = row as { instanceId?: unknown; relayQueueId?: unknown };
      if (typeof r.instanceId === 'string' && r.instanceId && typeof r.relayQueueId === 'string' && r.relayQueueId) {
        queues.set(r.instanceId, r.relayQueueId);
      }
    }
    instancesCache = { at: Date.now(), queues };
    return queues;
  } catch (err) {
    logger.debug('Could not list the account\'s machines', { error: err instanceof Error ? err.message : String(err) });
    return instancesCache?.queues ?? new Map();
  }
}

/** Forget the cached machine list (tests). */
export function resetAccountInstancesCache(): void {
  instancesCache = null;
}

/**
 * Start colleague messaging: build the service and listen for
 * `colleague_message` on the Cloud relay. Idempotent. Never throws.
 *
 * @param agentRegistration - The agent registration service (delivery to running agents)
 */
export async function startColleagueMessaging(agentRegistration: AgentRegistrationService): Promise<void> {
  try {
    registration = agentRegistration;
    const [{ CloudSyncService }, { isSessionPaused }] = await Promise.all([
      import('../cloud/cloud-sync.service.js'),
      import('../team/team-pause.registry.js'),
    ]);
    const sync = CloudSyncService.getInstance();
    cloudSyncRef = sync;
    pausedCheck = isSessionPaused;
    if (!instance) instance = new ColleagueMessageService(buildColleagueDeps());
    if (listening) return;
    listening = true;
    sync.on('message', (msg: { type: string; payload: unknown; id?: string }) => {
      if (msg.type !== COLLEAGUE_MESSAGE_CONSTANTS.MESSAGE_TYPE) return;
      // Refresh the machine list first so a sender known only to it passes the account check.
      void accountInstances()
        .then(() => instance?.receive(msg.payload))
        .then((out) => {
          if (!out) return;
          const from = isColleagueWireMessage(msg.payload) ? msg.payload.from.name : 'unknown';
          logger.info('Colleague message received', { from, handled: out.handled, ...('delivered' in out ? { delivered: out.delivered } : {}), ...(out.reason ? { reason: out.reason } : {}) });
        })
        .catch((err: unknown) => logger.warn('Colleague message failed', { error: err instanceof Error ? err.message : String(err) }));
    });
    logger.info('Colleague messaging started');
  } catch (err) {
    logger.warn('Colleague messaging not started (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * The hint for a local send that named someone who is not a local agent: where
 * that colleague is and how to reach them. Null when the directory does not
 * know the name or is not reachable. Never throws.
 *
 * @param target - What the sender tried to reach
 * @param fromSession - The sending agent
 * @returns Hint text, or null
 */
export async function lookupColleagueHint(target: string, fromSession?: string): Promise<string | null> {
  try {
    const { getSlackDirectoryService } = await import('../slack/slack-directory.service.js');
    const dir = getSlackDirectoryService();
    if (!dir) return null;
    const entries = await Promise.race([
      dir.list(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), COLLEAGUE_MESSAGE_CONSTANTS.DIRECTORY_LOOKUP_MS)),
    ]);
    return entries ? colleagueNotFoundHint(target, entries, fromSession) : null;
  } catch {
    return null;
  }
}
