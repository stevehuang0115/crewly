/**
 * Spend caps from the owner's DM with the orc. Handled by the backend, not
 * the orc — so it works while the orc itself is stopped by its cap:
 *
 * - `set daily cap for crewly-orc to $5` / `set daily cap for Ella to 3`
 * - `set daily cap to $5` (the default for every agent)
 * - `set daily total cap to $20` (all agents together)
 * - `remove daily cap for Ella` / `remove daily cap` / `remove daily total cap`
 * - `raise cap for orc to $10 today` / `raise total cap to $40 today`
 *
 * While the orc is stopped by a cap, every other owner DM to it gets one
 * harness line saying so (the message itself stays queued for the orc).
 *
 * specs/2026-10-02-spend-cap.md
 *
 * @module services/spend/spend-cap-command
 */

import { ORCHESTRATOR_SESSION_NAME, SPEND_CAP_CONSTANTS as C } from '../../constants.js';
import type { SlackIncomingMessage } from '../../types/slack.types.js';
import { formatUsd, spendCapReason, type SpendStop } from './spend-cap.gate.js';
import { suggestedRaise, type SpendCapPatch } from './spend-cap.service.js';

/** A parsed command. */
export type SpendCapCommand =
  | { kind: 'set'; target: string | null; usd: number }
  | { kind: 'set_total'; usd: number }
  | { kind: 'remove'; target: string | null }
  | { kind: 'remove_total' }
  | { kind: 'raise'; target: string; usd: number };

const AMOUNT = String.raw`\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:usd|dollars?)?`;
const CAP = String.raw`(?:daily\s+)?(?:spend(?:ing)?\s+)?cap`;

/**
 * Normalise a message for matching.
 *
 * @param text - Raw text
 * @returns Lower-cased, mentions and trailing punctuation removed
 */
function norm(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+>/g, '')
    .replace(/[`*_]/g, '')
    .toLowerCase()
    .replace(/[\s.。!！~～]+$/u, '')
    .replace(/^(?:please|pls)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a spend cap command.
 *
 * @param text - Message text
 * @returns The command, or null when the message is not one
 *
 * @example
 * parseSpendCapCommand('set daily cap for crewly-orc to $5') // { kind: 'set', target: 'crewly-orc', usd: 5 }
 * parseSpendCapCommand('raise cap for orc to $10 today') // { kind: 'raise', target: 'orc', usd: 10 }
 */
export function parseSpendCapCommand(text: string | undefined): SpendCapCommand | null {
  if (!text) return null;
  const t = norm(text);
  let m = new RegExp(String.raw`^set (?:the )?(?:daily total|total daily|total)(?: spend(?:ing)?)? cap to ${AMOUNT}$`).exec(t);
  if (m) return { kind: 'set_total', usd: Number(m[1]) };
  m = new RegExp(String.raw`^set (?:the )?${CAP}(?: for (.+?))? to ${AMOUNT}(?: (?:a|per) day)?$`).exec(t);
  if (m) return { kind: 'set', target: m[1]?.trim() || null, usd: Number(m[2]) };
  m = /^(?:remove|clear|turn off|disable) (?:the )?(?:daily total|total daily|total)(?: spend(?:ing)?)? cap$/.exec(t);
  if (m) return { kind: 'remove_total' };
  m = new RegExp(String.raw`^(?:remove|clear|turn off|disable) (?:the )?${CAP}(?: for (.+))?$`).exec(t);
  if (m) return { kind: 'remove', target: m[1]?.trim() || null };
  m = new RegExp(String.raw`^raise (?:the )?(?:daily total|total daily|total)(?: spend(?:ing)?)? cap to ${AMOUNT}(?: (?:for )?today)?$`).exec(t);
  if (m) return { kind: 'raise', target: C.TOTAL_TARGET, usd: Number(m[1]) };
  m = new RegExp(String.raw`^raise (?:the )?${CAP} for (.+?) to ${AMOUNT}(?: (?:for )?today)?$`).exec(t);
  if (m) {
    const target = m[1].trim();
    return { kind: 'raise', target: ['total', 'all', 'all agents'].includes(target) ? C.TOTAL_TARGET : target, usd: Number(m[2]) };
  }
  return null;
}

/** An agent the owner can name. */
export interface NamedAgent {
  session: string;
  name: string;
}

/**
 * Resolve the agent the owner named.
 *
 * @param who - Session name, member name, or "orc" / "orchestrator"
 * @param agents - Configured agents
 * @returns Session, or null when unknown / ambiguous
 */
export function resolveAgent(who: string, agents: NamedAgent[]): string | null {
  const w = who.trim().toLowerCase().replace(/^@/, '');
  if (['orc', 'the orc', 'orchestrator', 'the orchestrator', 'crewly orc', ORCHESTRATOR_SESSION_NAME].includes(w)) return ORCHESTRATOR_SESSION_NAME;
  const bySession = agents.find((a) => a.session.toLowerCase() === w);
  if (bySession) return bySession.session;
  const byName = agents.filter((a) => a.name.toLowerCase() === w);
  return byName.length === 1 ? byName[0].session : null;
}

/** What the interceptor needs. */
export interface SpendCapCommandDeps {
  /** `orc` when the message is the owner writing in their DM with the orc */
  ownerDmScope: (message: SlackIncomingMessage) => 'orc' | 'agent' | null;
  replyTargetOf: (message: SlackIncomingMessage) => unknown;
  reply: (text: string, target: unknown) => Promise<unknown>;
  /** Configured agents (orc included) */
  agents: () => Promise<NamedAgent[]>;
  setCaps: (patch: SpendCapPatch) => Promise<unknown>;
  raiseToday: (target: string, usd: number) => Promise<number>;
  /** The orc's stop, or null */
  orcStop: () => SpendStop | null;
  onError?: (err: unknown) => void;
}

/**
 * The orc's harness line while it is stopped by a cap.
 *
 * @param stop - The orc's stop
 * @returns One line
 */
export function orcCappedReply(stop: SpendStop): string {
  const raise = suggestedRaise(stop.capUsd, stop.spentUsd);
  const target = stop.scope === 'total' ? 'total' : 'orc';
  return `${spendCapReason(stop, 'Orc')}. No new turns start until midnight; your message is queued. To raise it for today, reply \`raise cap for ${target} to $${raise} today\` (or Settings → System → Spend).`;
}

/**
 * Run a parsed command.
 *
 * @param cmd - Command
 * @param deps - Collaborators
 * @returns The owner's one-line answer
 */
export async function runSpendCapCommand(cmd: SpendCapCommand, deps: Pick<SpendCapCommandDeps, 'agents' | 'setCaps' | 'raiseToday'>): Promise<string> {
  const agents = await deps.agents();
  const who = (target: string): { session: string; name: string } | string => {
    const session = resolveAgent(target, agents);
    if (!session) return `I don't know an agent called "${target}". Use its name or session name (e.g. crewly-orc).`;
    const name = session === ORCHESTRATOR_SESSION_NAME ? 'Orc' : agents.find((a) => a.session === session)?.name ?? session;
    return { session, name };
  };
  switch (cmd.kind) {
    case 'set_total':
      await deps.setCaps({ totalCapUsd: cmd.usd });
      return `Daily total spend cap set to ${formatUsd(cmd.usd)} for all agents together.`;
    case 'remove_total':
      await deps.setCaps({ totalCapUsd: null });
      return 'Daily total spend cap removed.';
    case 'set': {
      if (!cmd.target) {
        await deps.setCaps({ defaultAgentCapUsd: cmd.usd });
        return `Daily spend cap set to ${formatUsd(cmd.usd)} per agent (agents with their own cap keep it).`;
      }
      const a = who(cmd.target);
      if (typeof a === 'string') return a;
      await deps.setCaps({ agents: { [a.session]: cmd.usd } });
      return `Daily spend cap for ${a.name} set to ${formatUsd(cmd.usd)}.`;
    }
    case 'remove': {
      if (!cmd.target) {
        await deps.setCaps({ defaultAgentCapUsd: null });
        return 'Default daily spend cap removed (agents with their own cap keep it).';
      }
      const a = who(cmd.target);
      if (typeof a === 'string') return a;
      await deps.setCaps({ agents: { [a.session]: null } });
      return `${a.name} has no daily spend cap now.`;
    }
    case 'raise': {
      if (cmd.target === C.TOTAL_TARGET) {
        const cap = await deps.raiseToday(C.TOTAL_TARGET, cmd.usd);
        return `Daily total spend cap raised to ${formatUsd(cap)} for today.`;
      }
      const a = who(cmd.target);
      if (typeof a === 'string') return a;
      const cap = await deps.raiseToday(a.session, cmd.usd);
      return `${a.name}'s daily spend cap raised to ${formatUsd(cap)} for today. Queued messages are being delivered.`;
    }
  }
}

/**
 * The Slack bridge interceptor for the owner's orc DM.
 *
 * @param deps - Collaborators
 * @returns Interceptor: true when the message was a cap command (consumed)
 */
export function createSpendCapInterceptor(deps: SpendCapCommandDeps): (message: SlackIncomingMessage) => boolean {
  return (message) => {
    if (deps.ownerDmScope(message) !== 'orc') return false;
    const target = deps.replyTargetOf(message);
    const cmd = message.hasFiles ? null : parseSpendCapCommand(message.text);
    if (cmd) {
      void runSpendCapCommand(cmd, deps)
        .then((text) => deps.reply(text, target))
        .catch((err) => {
          deps.onError?.(err);
          return deps.reply(`Couldn't change the cap: ${err instanceof Error ? err.message : String(err)}`, target).catch(() => undefined);
        });
      return true;
    }
    const stop = deps.orcStop();
    if (stop) {
      // Not consumed: the message goes on to the orc's queue and waits there.
      void deps.reply(orcCappedReply(stop), target).catch((err) => deps.onError?.(err));
    }
    return false;
  };
}
