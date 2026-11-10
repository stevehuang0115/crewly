/**
 * Deliver text to an agent of this machine the way an owner or colleague
 * message is delivered: now when the agent runs and is ready, held for it
 * when it is busy, and queued (with the agent started) when it is down.
 *
 * Shared by the colleague messages (`message-colleague`) and the shared
 * channels with other companies (crewly#1543), which both wake a local agent
 * from a message that did not come through a chat post.
 *
 * @module services/messaging/deliver-to-local-agent
 */

import type { AgentRegistrationService } from '../agent/agent-registration.service.js';

/** The agent-registration surface used here. */
export type LocalAgentRegistration = Pick<
  AgentRegistrationService,
  'getInProcessRuntime' | 'waitForAgentReady' | 'holdForBusyAgent' | 'sendMessageToAgent'
>;

/** Outcome of a delivery. */
export interface LocalDeliveryResult {
  success: boolean;
  /** True when it waits for the agent (busy, or down and queued) */
  queued?: boolean;
  error?: string;
}

/**
 * Deliver text to a local agent. Never throws for a delivery failure; the
 * result says what happened.
 *
 * @param registration - The agent registration service, or null before it is up
 * @param session - Agent session name
 * @param text - Text to deliver
 * @param readyWaitMs - How long to wait for a running agent to be ready before holding it
 * @returns What happened
 *
 * @example
 * ```typescript
 * const r = await deliverToLocalAgent(reg, 'crewly-orc', 'hello', 10_000);
 * if (!r.success) logger.warn(r.error);
 * ```
 */
export async function deliverToLocalAgent(
  registration: LocalAgentRegistration | null,
  session: string,
  text: string,
  readyWaitMs: number,
): Promise<LocalDeliveryResult> {
  const reg = registration;
  if (!reg) return { success: false, error: 'agent delivery is not ready yet' };
  const { getSessionBackendSync } = await import('../session/index.js');
  const running = !!getSessionBackendSync()?.sessionExists(session) || !!reg.getInProcessRuntime(session);
  if (running) {
    const ready = await reg.waitForAgentReady(session, readyWaitMs);
    if (!ready) {
      reg.holdForBusyAgent(session, text);
      return { success: true, queued: true };
    }
    const res = await reg.sendMessageToAgent(session, text);
    return { success: res.success || !!res.queued, ...(res.queued ? { queued: true } : {}), ...(res.error ? { error: res.error } : {}) };
  }
  // Down: the same queue-and-wake path an owner or agent message to a stopped member takes.
  const [{ queueForOfflineAgent, getOfflineAgentWaker }, { StorageService }, { SubAgentMessageQueue }] = await Promise.all([
    import('./offline-agent-message.js'),
    import('../core/storage.service.js'),
    import('./sub-agent-message-queue.service.js'),
  ]);
  const queued = await queueForOfflineAgent(session, text, {
    findMember: (name) => StorageService.getInstance().findMemberBySessionName(name),
    enqueue: (name, data) => SubAgentMessageQueue.getInstance().enqueue(name, data),
    wake: getOfflineAgentWaker(),
  });
  return queued ? { success: true, queued: true } : { success: false, error: `${session} is not running` };
}
