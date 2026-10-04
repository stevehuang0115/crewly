/**
 * Crewly Apps wiring: the shared registry / Cloud client / service the
 * `/api/apps` controller uses, and the change poller started at boot
 * (specs/2026-10-04-crewly-apps-p2.md).
 *
 * @module services/apps/apps.wiring
 */

import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { getSlackInstanceRegistryService } from '../slack/slack-instance-registry.service.js';
import { AppsCloudClient } from './apps-cloud.client.js';
import { AppsRegistryService } from './apps-registry.service.js';
import { AppsService, type AppCardNotifier } from './apps.service.js';
import { AppWakeService } from './app-wake.service.js';

interface AppsParts {
  client: AppsCloudClient;
  registry: AppsRegistryService;
  service: AppsService;
}

let parts: AppsParts | null = null;
let wake: AppWakeService | null = null;

/**
 * This instance's Cloud device id (what `X-Crewly-Instance` names).
 *
 * @returns The id, or null before the Slack instance registry resolved it
 */
export async function currentInstanceId(): Promise<string | null> {
  const registry = getSlackInstanceRegistryService();
  if (!registry) return null;
  return registry.getInstanceId() ?? (await registry.resolveInstanceId());
}

/**
 * Post the app card where the agent talks with the owner, through the same
 * resolver `reply` uses.
 */
const defaultNotifyCard: AppCardNotifier = async (agentSession, text) => {
  const { deliverReply } = await import('../orc/reply-destination.wiring.js');
  const r = await deliverReply({ session: agentSession, content: text, addsNew: true });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
};

/**
 * The shared Apps parts, built on first use.
 *
 * @returns Client, registry and service
 */
export function getAppsParts(): AppsParts {
  if (!parts) {
    const client = new AppsCloudClient({ instanceId: currentInstanceId });
    const registry = new AppsRegistryService(getCrewlyHomePath());
    parts = { client, registry, service: new AppsService({ client, registry, notifyCard: defaultNotifyCard }) };
  }
  return parts;
}

/**
 * Replace the shared parts (tests), or null to rebuild lazily.
 *
 * @param next - Parts or null
 */
export function setAppsParts(next: AppsParts | null): void {
  parts = next;
}

/** Inputs of {@link startAppWake}. */
export interface StartAppWakeInput {
  /** Agent skills root (`config/skills/agent`) */
  skillsPath: string;
  /** Wake a (non-orchestrator) agent with a message; activates it when down */
  sendToAgent: (session: string, text: string) => Promise<boolean>;
  /** Hand a message to the orchestrator */
  sendToOrchestrator: (text: string) => Promise<boolean>;
  /** Teams on this instance, for resolving an `ask` target */
  getTeams: () => Promise<Array<{ members?: Array<{ sessionName?: string; name?: string }> }>>;
}

/**
 * Start the app change poller (idempotent).
 *
 * @param input - Delivery callbacks and paths
 * @returns The running service
 */
export function startAppWake(input: StartAppWakeInput): AppWakeService {
  if (wake) return wake;
  const { client, registry } = getAppsParts();
  wake = new AppWakeService({
    client,
    registry,
    skillsPath: input.skillsPath,
    deliver: (session, text) => (session ? input.sendToAgent(session, text) : input.sendToOrchestrator(text)),
    resolveAgent: async (name) => {
      const wanted = name.trim().toLowerCase();
      for (const team of await input.getTeams()) {
        for (const m of team.members ?? []) {
          if (!m.sessionName) continue;
          if (m.sessionName.toLowerCase() === wanted || (m.name ?? '').trim().toLowerCase() === wanted) return m.sessionName;
        }
      }
      return null;
    },
  });
  wake.start();
  return wake;
}

/** Stop the poller (shutdown; tests). */
export function stopAppWake(): void {
  wake?.stop();
  wake = null;
}
