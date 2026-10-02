/**
 * Token caps — the real dependencies, bound to the running backend.
 *
 * Kept apart from the service so the service stays testable with fakes;
 * heavy services are imported lazily so importing this module from index.ts
 * adds no import cycles.
 *
 * specs/2026-10-02-spend-cap.md
 *
 * @module services/spend/spend-cap.wiring
 */

import * as path from 'path';
import { ORCHESTRATOR_SESSION_NAME, SPEND_CAP_CONSTANTS, USAGE_CONSTANTS } from '../../constants.js';
import { DecisionService } from '../decisions/decision.service.js';
import { TokenUsageService } from '../monitoring/token-usage.service.js';
import { SubAgentMessageQueue } from '../messaging/sub-agent-message-queue.service.js';
import { setSpendCapGate } from './spend-cap.gate.js';
import { createSpendCapInterceptor, type NamedAgent, type NamedTeam } from './spend-cap-command.js';
import { SpendCapService, setSpendCapService, type CapTeam, type SpendCapLogger } from './spend-cap.service.js';
import { FileSpendCapStore } from './spend-cap.store.js';
import { SpendLedger } from './spend-ledger.service.js';

/** Team facts the wiring reads. */
interface StorageLike {
  getTeams(): Promise<Array<{ id?: string; name?: string; members: Array<{ name: string; sessionName: string }> }>>;
}

/** The registration-service calls the wiring makes. */
interface RegistrationLike {
  isInProcessRuntimeActive(sessionName: string): boolean;
  sendMessageToAgent(sessionName: string, message: string): Promise<{ success: boolean; queued?: boolean }>;
}

/** What index.ts provides. */
export interface SpendCapWiringInput {
  crewlyHome: string;
  storage: StorageLike;
  registration: () => RegistrationLike | null;
  /** Whether a PTY session exists */
  sessionExists: (sessionName: string) => boolean;
  /** Start a stopped team member (activate-on-send) */
  activate: (sessionName: string) => Promise<unknown>;
  logger: SpendCapLogger;
}

/**
 * Build the service, install it as the delivery / wake gate, register the
 * decision-card handler and the orc-DM commands, and start its tick.
 *
 * @param input - Backend context
 * @returns The running service
 */
export async function startSpendCaps(input: SpendCapWiringInput): Promise<SpendCapService> {
  const names = new Map<string, string>([[ORCHESTRATOR_SESSION_NAME, 'Orc']]);
  const agents = async (): Promise<NamedAgent[]> => {
    const list: NamedAgent[] = [{ session: ORCHESTRATOR_SESSION_NAME, name: 'Orc' }];
    for (const team of await input.storage.getTeams().catch(() => [])) {
      for (const m of team.members ?? []) {
        if (!m.sessionName) continue;
        list.push({ session: m.sessionName, name: m.name || m.sessionName });
        names.set(m.sessionName, m.name || m.sessionName);
      }
    }
    return list;
  };
  const teams = async (): Promise<CapTeam[]> => {
    const out: CapTeam[] = [];
    for (const team of await input.storage.getTeams().catch(() => [])) {
      if (!team.id) continue;
      out.push({ id: team.id, name: team.name || team.id, members: (team.members ?? []).map((m) => m.sessionName).filter(Boolean) });
    }
    return out;
  };

  const { SlackReloginDmService } = await import('../slack/slack-relogin-dm.service.js');
  const { getSlackService } = await import('../slack/slack.service.js');
  const { getSlackAgentIdentityService } = await import('../slack/slack-agent-identity.service.js');
  const dm = new SlackReloginDmService(
    () => getSlackService(),
    undefined,
    (agentSession) => getSlackAgentIdentityService()?.getInstalled(agentSession)?.botToken ?? null,
  );

  const release = async (sessions: string[]): Promise<void> => {
    const reg = input.registration();
    if (!reg) return;
    const queue = SubAgentMessageQueue.getInstance();
    for (const session of sessions) {
      if (!queue.hasPending(session)) continue;
      const live = reg.isInProcessRuntimeActive(session) || input.sessionExists(session);
      if (live || session === ORCHESTRATOR_SESSION_NAME) {
        await queue.flush(session, (data) => reg.sendMessageToAgent(session, data));
      } else {
        // Registration flushes the persistent queue once the agent is up.
        await input.activate(session);
      }
    }
  };

  const service = new SpendCapService({
    store: new FileSpendCapStore(
      path.join(input.crewlyHome, SPEND_CAP_CONSTANTS.STORE_FILE),
      path.join(input.crewlyHome, SPEND_CAP_CONSTANTS.LEGACY_USD_STORE_FILE),
      (config) =>
        input.logger.info('Migrated daily spend caps from USD to tokens', {
          tokensPerUsd: USAGE_CONSTANTS.TOKENS_PER_USD,
          caps: config,
        }),
    ),
    ledger: new SpendLedger(TokenUsageService.getInstance()),
    notifyOwner: (text) => dm.sendToOwner(text),
    decisions: () => DecisionService.getInstance(),
    displayNameOf: (session) => names.get(session) ?? session,
    knownSessions: async () => (await agents()).map((a) => a.session),
    teams,
    onReleased: release,
    logger: input.logger,
  });

  setSpendCapService(service);
  setSpendCapGate(service);
  DecisionService.registerKindHandler(SPEND_CAP_CONSTANTS.DECISION_KIND, service);

  try {
    const { getSlackOrchestratorBridge } = await import('../slack/slack-orchestrator-bridge.js');
    getSlackOrchestratorBridge().addInboundInterceptor(
      'the token cap commands',
      createSpendCapInterceptor({
        ownerDmScope: (m) => dm.ownerDmScope(m),
        replyTargetOf: (m) => dm.replyTargetOf(m),
        reply: (text, target) => dm.sendToOwner(text, target as ReturnType<typeof dm.replyTargetOf>),
        agents,
        teams: async (): Promise<NamedTeam[]> => (await teams()).map((t) => ({ id: t.id, name: t.name })),
        setCaps: (patch) => service.setCaps(patch),
        boost: (b) => service.boost(b),
        orcStop: () => service.stopOf(ORCHESTRATOR_SESSION_NAME),
        onError: (err) => input.logger.warn('Token cap command failed', { error: err instanceof Error ? err.message : String(err) }),
      }),
    );
  } catch (err) {
    input.logger.warn('Token cap Slack commands not wired (non-critical)', { error: err instanceof Error ? err.message : String(err) });
  }

  await agents().catch(() => undefined);
  service.start();
  return service;
}
