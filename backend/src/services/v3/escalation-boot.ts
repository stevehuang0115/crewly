/**
 * Escalation Boot
 *
 * Production wiring for {@link EscalationService}. The service (evaluate
 * every mission's `policy.escalationRules` every 5 minutes → notify /
 * pause / block) was fully implemented but never instantiated, so the
 * escalation rules on every policy template were dead configuration.
 *
 * This module keeps the boot logic out of `index.ts` so it can be unit
 * tested: env gating, the owner-facing `[ESCALATION]` notification handler,
 * and the "no missions ⇒ no-op" property.
 *
 * Env:
 *   `CREWLY_ESCALATION_ENABLED=false` — do not start the service
 *   anything else (or unset)        — start it (default)
 *
 * @module services/v3/escalation-boot
 */

import { EscalationService, type EscalationActionHandler } from './escalation.service.js';
import { getMissionProjectPath } from './mission-paths.js';
import type { Mission, EscalationRule } from '../../types/v2/mission.types.js';
import type { ComponentLogger } from '../core/logger.service.js';
import { MESSAGE_SOURCES, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Env var that disables the escalation loop when set to `'false'`. */
export const ESCALATION_ENABLED_ENV = 'CREWLY_ESCALATION_ENABLED';

/** Conversation id stamped on owner-facing escalation messages. */
export const ESCALATION_CONVERSATION_ID = 'system_escalation';

/** Envelope prefix the orchestrator prompt recognises for policy escalations. */
export const ESCALATION_ENVELOPE_PREFIX = '[ESCALATION]';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal MessageQueueService surface used to reach the orchestrator. */
export interface EscalationMessageQueueLike {
  enqueue(input: {
    content: string;
    conversationId: string;
    source: typeof MESSAGE_SOURCES.SYSTEM_EVENT;
    targetSession?: string;
    sourceMetadata?: Record<string, unknown>;
  }): unknown;
}

/** Dependencies for {@link bootEscalationService}. */
export interface EscalationBootDependencies {
  /** Queue used to surface escalations to the orchestrator (and thus the owner). */
  messageQueue: EscalationMessageQueueLike;
  logger: ComponentLogger;
  /** Project root override (defaults to the shared missions resolver's root). */
  projectPath?: string;
  /** Test seam — defaults to `new EscalationService(projectPath)`. */
  createService?: (projectPath: string) => EscalationService;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether the escalation loop should start. Only the literal string
 * `'false'` disables it — every other value (including unset) enables.
 *
 * @returns `true` when the service should be booted
 */
export function isEscalationEnabled(): boolean {
  return process.env[ESCALATION_ENABLED_ENV] !== 'false';
}

/**
 * Build the owner-facing envelope for a triggered escalation rule.
 *
 * @param mission - The escalated mission
 * @param rule - The rule that fired
 * @param action - The action taken
 * @returns One-line `[ESCALATION]` message for the orchestrator queue
 */
export function formatEscalationEnvelope(
  mission: Mission,
  rule: EscalationRule,
  action: 'notify' | 'pause' | 'block',
): string {
  const objective =
    mission.objective.length > 80 ? `${mission.objective.slice(0, 80)}…` : mission.objective;
  return (
    `${ESCALATION_ENVELOPE_PREFIX} Mission "${objective}" (${mission.id}) — ` +
    `policy rule ${rule.condition} exceeded threshold ${rule.threshold}; ` +
    `action=${action}, escalateTo=${rule.escalateTo}. ` +
    (action === 'notify'
      ? 'Owner attention requested.'
      : action === 'pause'
        ? 'Queued/running mission work has been paused (blocked) pending owner review.'
        : 'Mission is blocked pending owner review.')
  );
}

/**
 * Action handler that surfaces every triggered rule to the orchestrator's
 * chat queue as a `[ESCALATION]` system event. The built-in `pause`
 * behaviour (blocking the mission's WorkItems) stays inside
 * {@link EscalationService}; this handler is purely the notification leg.
 *
 * @param deps - Queue + logger
 * @returns Handler suitable for {@link EscalationService.setActionHandler}
 */
export function createEscalationNotifier(
  deps: Pick<EscalationBootDependencies, 'messageQueue' | 'logger'>,
): EscalationActionHandler {
  return async (mission, rule, action) => {
    try {
      deps.messageQueue.enqueue({
        content: formatEscalationEnvelope(mission, rule, action),
        conversationId: ESCALATION_CONVERSATION_ID,
        source: MESSAGE_SOURCES.SYSTEM_EVENT,
        targetSession: ORCHESTRATOR_SESSION_NAME,
        sourceMetadata: {
          missionId: mission.id,
          condition: rule.condition,
          threshold: rule.threshold,
          action,
          escalateTo: rule.escalateTo,
        },
      });
    } catch (err) {
      deps.logger.warn('Escalation notification enqueue failed (non-fatal)', {
        missionId: mission.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

/**
 * Boot the escalation loop if enabled. Never throws — a failure to start
 * is logged and `null` is returned so the backend keeps booting.
 *
 * Must be called AFTER the TriggerEngine action handler has been wired in
 * `index.ts`: `EscalationService.start()` wraps whatever handler is
 * currently installed and delegates non-escalation triggers to it.
 *
 * @param deps - Boot dependencies
 * @returns The started service, or `null` when disabled / failed
 */
export async function bootEscalationService(
  deps: EscalationBootDependencies,
): Promise<EscalationService | null> {
  if (!isEscalationEnabled()) {
    deps.logger.info('EscalationService disabled via env', { env: ESCALATION_ENABLED_ENV });
    return null;
  }
  const projectPath = deps.projectPath ?? getMissionProjectPath();
  try {
    const service = deps.createService
      ? deps.createService(projectPath)
      : new EscalationService(projectPath);
    service.setActionHandler(createEscalationNotifier(deps));
    await service.start();
    return service;
  } catch (err) {
    deps.logger.warn('EscalationService boot failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
