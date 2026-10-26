/**
 * The orchestrator's names.
 *
 * The orchestrator runs as one session (`ORCHESTRATOR_SESSION_NAME`,
 * `crewly-orc`) but posts under display names: chat rows it writes carry
 * `senderId: "Orchestrator"` (its sender has no id, so the name stands in),
 * skills call it `orc`. Anything that turns a sender into an agent to wake,
 * queue for or deliver to must speak the session name, or the message goes
 * to a session that does not exist and waits there forever (D-952: the
 * owner's skip was queued for "Orchestrator", 2026-10-26).
 *
 * @module utils/orchestrator-alias.utils
 */

import { ORCHESTRATOR_SESSION_NAME } from '../constants.js';

/**
 * Is this sender the orchestrator itself (by session name or the display
 * names the prompt/skills use for it)?
 *
 * @param sender - A session name or `senderName`/`senderId` as posted
 * @returns True for the orchestrator
 */
export function isOrchestratorSender(sender: string | null | undefined): boolean {
  const s = (sender ?? '').trim().toLowerCase();
  return s === ORCHESTRATOR_SESSION_NAME.toLowerCase() || s === 'orchestrator' || s === 'orc';
}

/**
 * The session an agent name addresses: the orchestrator's aliases become its
 * session name, every other name is returned as given.
 *
 * @param name - A session name or a display alias
 * @returns The session name to wake, queue for or deliver to
 */
export function canonicalAgentSession(name: string): string {
  return isOrchestratorSender(name) ? ORCHESTRATOR_SESSION_NAME : name;
}
