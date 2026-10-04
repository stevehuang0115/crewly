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
import { AppsService, type AppCardPoster } from './apps.service.js';
import { AppWakeService } from './app-wake.service.js';

/** The team shape the apps code reads. */
export interface AppsTeam {
  members?: Array<{ sessionName?: string; name?: string }>;
}

/** Where teams come from. */
export type AppsTeamsSource = () => Promise<AppsTeam[]>;

interface AppsParts {
  client: AppsCloudClient;
  registry: AppsRegistryService;
  service: AppsService;
}

let parts: AppsParts | null = null;
let wake: AppWakeService | null = null;

/** Default teams source: the storage service, loaded lazily. */
const defaultTeams: AppsTeamsSource = async () => {
  const { StorageService } = await import('../core/storage.service.js');
  return StorageService.getInstance().getTeams();
};

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
 * The team that has this session as a member.
 *
 * @param teams - Teams
 * @param session - Agent session
 * @returns The team, or undefined
 */
function teamOf(teams: AppsTeam[], session: string): AppsTeam | undefined {
  return teams.find((t) => (t.members ?? []).some((m) => m.sessionName === session));
}

/**
 * Whether two sessions are members of the same team.
 *
 * @param teams - Teams source
 * @returns Predicate
 */
export function sameTeamFrom(teams: AppsTeamsSource): (a: string, b: string) => Promise<boolean> {
  return async (a, b) => {
    const team = teamOf(await teams(), a);
    return !!team && (team.members ?? []).some((m) => m.sessionName === b);
  };
}

/**
 * Resolve an `ask` target name to a session — only inside the publisher's
 * own team (by session or display name, case-insensitive).
 *
 * @param teams - Teams source
 * @returns Resolver
 */
export function teamAgentResolver(teams: AppsTeamsSource): (name: string, publisher: string) => Promise<string | null> {
  return async (name, publisher) => {
    const team = teamOf(await teams(), publisher);
    if (!team) return null;
    const wanted = name.trim().toLowerCase();
    for (const m of team.members ?? []) {
      if (!m.sessionName) continue;
      if (m.sessionName.toLowerCase() === wanted || (m.name ?? '').trim().toLowerCase() === wanted) return m.sessionName;
    }
    return null;
  };
}

/**
 * The real card poster (specs/2026-10-04-crewly-apps-p3.md §1).
 *
 * - `ownerDm`: the agent's DM with the owner — the same lookup `reply` uses
 *   for its last step (Slack DM link, else the dashboard DM of a real team
 *   member). Cloud forwards only the owner's Slack DMs to an agent bot, so a
 *   linked Slack DM is one-to-one with the owner.
 * - `postToOwnerDm`: straight into that conversation, with no resolver and
 *   no fallback, so a signed link can never be re-routed into a room. Not
 *   traced either: the run trace records reply text, and this text holds
 *   the token.
 * - `postReply`: the P2 path (`deliverReply`), for the plain-URL card.
 */
export const defaultCardPoster: AppCardPoster = {
  ownerDm: async (agentSession) => {
    const { defaultReplyDeliveryDeps } = await import('../orc/reply-destination.wiring.js');
    return (await defaultReplyDeliveryDeps()).resolver.ownerDm(agentSession);
  },
  postToOwnerDm: async (agentSession, conversationId, text) => {
    const { deliverAgentReplyToConversation } = await import('../../controllers/chat/chat.controller.js');
    const id = await deliverAgentReplyToConversation({ conversationId, agentSession, content: text });
    return id ? { ok: true } : { ok: false, error: 'the DM did not take the card' };
  },
  postReply: async (agentSession, text) => {
    const { deliverReply } = await import('../orc/reply-destination.wiring.js');
    const r = await deliverReply({ session: agentSession, content: text, addsNew: true });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
};

/**
 * The shared Apps parts, built on first use.
 *
 * @param teams - Teams source (default: the storage service)
 * @returns Client, registry and service
 */
export function getAppsParts(teams: AppsTeamsSource = defaultTeams): AppsParts {
  if (!parts) {
    const client = new AppsCloudClient({ instanceId: currentInstanceId });
    const registry = new AppsRegistryService(getCrewlyHomePath());
    parts = { client, registry, service: new AppsService({ client, registry, cards: defaultCardPoster, sameTeam: sameTeamFrom(teams) }) };
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
  /** Wake an agent with a message; `activate` = start it first when it is down */
  sendToAgent: (session: string, text: string, activate: boolean) => Promise<boolean>;
  /** Hand a message to the orchestrator */
  sendToOrchestrator: (text: string) => Promise<boolean>;
  /** Whether an agent's session is running */
  sessionExists: (session: string) => boolean;
  /** Teams on this instance */
  getTeams: AppsTeamsSource;
}

/**
 * Start the app change poller (idempotent).
 *
 * @param input - Delivery callbacks and paths
 * @returns The running service
 */
export function startAppWake(input: StartAppWakeInput): AppWakeService {
  if (wake) return wake;
  const { client, registry } = getAppsParts(input.getTeams);
  wake = new AppWakeService({
    client,
    registry,
    skillsPath: input.skillsPath,
    deliver: (session, text, opts) => (session ? input.sendToAgent(session, text, opts.activate) : input.sendToOrchestrator(text)),
    resolveAgent: teamAgentResolver(input.getTeams),
    isRunning: input.sessionExists,
  });
  wake.start();
  return wake;
}

/** Stop the poller (shutdown; tests). */
export function stopAppWake(): void {
  wake?.stop();
  wake = null;
}
