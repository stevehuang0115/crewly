/**
 * Token caps and boosts from the owner's DM with the orc. Handled by the
 * backend, not the orc — so it works while the orc itself is stopped:
 *
 * Caps (amounts in tokens: `5M`, `500k`, `2000万`, `5000000`):
 * - `set daily cap for Ella to 5M` / `set daily cap to 5M` (default per agent)
 * - `set team cap for CE to 50M` / `set daily cap for team CE to 50M`
 * - `set daily total cap to 200M` (all agents together)
 * - `remove daily cap for Ella` / `remove team cap for CE` / `remove daily cap` / `remove daily total cap`
 *
 * Boosts (until local midnight):
 * - `boost CE by 20M today` / `boost Ella by 5M` / `boost everyone by 10M today`
 * - `unlimited today for everyone` / `unlimited today for CE` / `CE unlimited today`
 * - `放开 CE 今天` / `今天放开 CE` / `今天全部放开` / `给 CE 加 20M` / `CE 今天加 2000万`
 *
 * A target is everyone, a team (by name) or an agent (by name / session);
 * a name that is both a team and an agent means the team. Replies are
 * English (harness text rule).
 *
 * While the orc is stopped by a cap, every other owner DM to it gets one
 * harness line saying so (the message itself stays queued for the orc).
 *
 * specs/2026-10-02-spend-cap.md
 *
 * @module services/spend/spend-cap-command
 */

import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import type { SlackIncomingMessage } from '../../types/slack.types.js';
import { compactTokens, formatTokens, parseTokenAmount } from '../usage/token-format.js';
import { spendCapReason, type SpendStop } from './spend-cap.gate.js';
import { suggestedBoost, type BoostInput, type SpendCapPatch } from './spend-cap.service.js';

/** A parsed command. `target` is the name as typed (resolved later). */
export type SpendCapCommand =
  | { kind: 'set'; target: string | null; team?: boolean; tokens: number }
  | { kind: 'set_total'; tokens: number }
  | { kind: 'remove'; target: string | null; team?: boolean }
  | { kind: 'remove_total' }
  | { kind: 'boost'; target: string; tokens: number }
  | { kind: 'unlimited'; target: string }
  | { kind: 'usd_hint' };

/** A name a boost may target from free text: short ASCII, or an "everyone" word. */
const NAME = /^[a-z0-9][a-z0-9 _.@-]{0,39}$/;

/**
 * Whether free text after a boost keyword is a plausible target (so an
 * ordinary sentence that happens to start with 放开 / ends with "unlimited
 * today" still goes to the orc).
 *
 * @param who - Candidate target
 * @returns True when it may be a team / agent name or "everyone"
 */
function plausibleTarget(who: string): boolean {
  return EVERYONE.has(who) || NAME.test(who);
}

/** Words for "everyone". */
const EVERYONE = new Set(['everyone', 'everybody', 'all', 'all agents', 'every agent', 'the whole crew', 'total', '所有人', '全部', '大家', '所有', '全员', '全部人']);

const AMOUNT = String.raw`(\d+(?:\.\d+)?\s*(?:k|m|mil|million|b|bn|billion|万|亿)?)(?:\s*tokens?)?`;
const CAP = String.raw`(?:daily\s+)?(?:token\s+|spend(?:ing)?\s+|usage\s+)?cap`;
const TODAY = String.raw`(?:\s*(?:for\s+)?today)?`;

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
    .replace(/^(?:please|pls|请)\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Amount text → tokens.
 *
 * @param text - e.g. `20m`, `2000万`
 * @returns Tokens, or null
 */
function amount(text: string): number | null {
  return parseTokenAmount(text.replace(/\s+/g, ''));
}

/**
 * Parse a cap / boost command.
 *
 * @param text - Message text
 * @returns The command, or null when the message is not one
 *
 * @example
 * parseSpendCapCommand('boost CE by 20M today') // { kind: 'boost', target: 'ce', tokens: 20000000 }
 * parseSpendCapCommand('放开 CE 今天') // { kind: 'unlimited', target: 'ce' }
 */
export function parseSpendCapCommand(text: string | undefined): SpendCapCommand | null {
  if (!text) return null;
  const t = norm(text);
  if (!t) return null;
  let m: RegExpExecArray | null;
  const num = (s: string): number | null => amount(s);

  // ---- caps
  m = new RegExp(String.raw`^set (?:the )?(?:daily total|total daily|total)(?: token| spend(?:ing)?)? cap to ${AMOUNT}$`).exec(t);
  if (m && num(m[1])) return { kind: 'set_total', tokens: num(m[1]) as number };
  m = new RegExp(String.raw`^set (?:the )?(?:daily )?team (?:token )?cap for (.+?) to ${AMOUNT}(?: (?:a|per) day)?$`).exec(t);
  if (m && num(m[2])) return { kind: 'set', target: m[1].trim(), team: true, tokens: num(m[2]) as number };
  m = new RegExp(String.raw`^set (?:the )?${CAP} for team (.+?) to ${AMOUNT}(?: (?:a|per) day)?$`).exec(t);
  if (m && num(m[2])) return { kind: 'set', target: m[1].trim(), team: true, tokens: num(m[2]) as number };
  m = new RegExp(String.raw`^set (?:the )?${CAP}(?: for (.+?))? to ${AMOUNT}(?: (?:a|per) day)?$`).exec(t);
  if (m && num(m[2])) return { kind: 'set', target: m[1]?.trim() || null, tokens: num(m[2]) as number };
  m = /^(?:remove|clear|turn off|disable) (?:the )?(?:daily total|total daily|total)(?: token| spend(?:ing)?)? cap$/.exec(t);
  if (m) return { kind: 'remove_total' };
  m = /^(?:remove|clear|turn off|disable) (?:the )?(?:daily )?team cap for (.+)$/.exec(t) ?? new RegExp(String.raw`^(?:remove|clear|turn off|disable) (?:the )?${CAP} for team (.+)$`).exec(t);
  if (m) return { kind: 'remove', target: m[1].trim(), team: true };
  m = new RegExp(String.raw`^(?:remove|clear|turn off|disable) (?:the )?${CAP}(?: for (.+))?$`).exec(t);
  if (m) return { kind: 'remove', target: m[1]?.trim() || null };

  // ---- boosts (English)
  m = new RegExp(String.raw`^boost (.+?) (?:by |\+)\s*${AMOUNT}${TODAY}$`).exec(t);
  if (m && num(m[2])) return { kind: 'boost', target: m[1].trim(), tokens: num(m[2]) as number };
  m = new RegExp(String.raw`^give (.+?) (?:\+)?${AMOUNT} (?:more|extra)${TODAY}$`).exec(t);
  if (m && num(m[2])) return { kind: 'boost', target: m[1].trim(), tokens: num(m[2]) as number };
  m = /^(?:unlimited|no (?:token )?cap|no limit)(?: tokens?)? (?:for )?today(?: for (.+))?$/.exec(t);
  if (m) return { kind: 'unlimited', target: m[1]?.trim() || 'everyone' };
  m = /^(?:unlimited|no (?:token )?cap|no limit) (?:tokens? )?for (.+?)(?: (?:for )?today)?$/.exec(t);
  if (m) return { kind: 'unlimited', target: m[1].trim() };
  m = /^(?:lift|remove|drop) (?:the )?(?:daily )?(?:token )?caps? (?:for|on) (.+?) (?:for )?today$/.exec(t);
  if (m) return { kind: 'unlimited', target: m[1].trim() };
  m = /^(.+?) unlimited today$/.exec(t);
  if (m && plausibleTarget(m[1].trim())) return { kind: 'unlimited', target: m[1].trim() };

  // ---- boosts (Chinese)
  const zh = t.replace(/\s+/g, ' ');
  m = /^(?:今天)?\s*(?:全部|全都|所有人|大家)?\s*放开(?:吧)?\s*(.*?)\s*(?:今天|今日)?(?:吧)?$/u.exec(zh);
  if (m) {
    const who = m[1].trim();
    const all = /^(?:今天|今日)?\s*(?:全部|全都|所有人|大家)/u.test(zh) || EVERYONE.has(who) || who === '';
    if (all) return { kind: 'unlimited', target: 'everyone' };
    if (plausibleTarget(who)) return { kind: 'unlimited', target: who };
  }
  m = /^(.+?)\s*(?:今天|今日)\s*(?:不限|不封顶|放开)$/u.exec(zh);
  if (m && plausibleTarget(m[1].trim())) return { kind: 'unlimited', target: m[1].trim() };
  m = new RegExp(String.raw`^(?:今天)?\s*给\s*(.+?)\s*(?:今天)?\s*(?:加|多加|增加)\s*${AMOUNT}$`, 'u').exec(zh);
  if (m && num(m[2]) && plausibleTarget(m[1].trim())) return { kind: 'boost', target: m[1].trim(), tokens: num(m[2]) as number };
  m = new RegExp(String.raw`^(.+?)\s*(?:今天|今日)\s*(?:加|多加|增加)\s*${AMOUNT}$`, 'u').exec(zh);
  if (m && num(m[2]) && plausibleTarget(m[1].trim())) return { kind: 'boost', target: m[1].trim(), tokens: num(m[2]) as number };

  // ---- the pre-token dollar forms: answer with the token form instead of passing them on
  if (/^(?:set|raise|remove) .*cap.*\$\s*\d/.test(t)) return { kind: 'usd_hint' };
  return null;
}

/** An agent the owner can name. */
export interface NamedAgent {
  session: string;
  name: string;
}

/** A team the owner can name. */
export interface NamedTeam {
  id: string;
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

/**
 * Resolve the team the owner named.
 *
 * @param who - Team name or id (`team CE` works too)
 * @param teams - Teams
 * @returns Team, or null when unknown / ambiguous
 */
export function resolveTeam(who: string, teams: NamedTeam[]): NamedTeam | null {
  const w = who.trim().toLowerCase().replace(/^(?:the )?team\s+/, '').replace(/\s+team$/, '');
  const byId = teams.find((t) => t.id.toLowerCase() === w);
  if (byId) return byId;
  const byName = teams.filter((t) => t.name.toLowerCase() === w);
  return byName.length === 1 ? byName[0] : null;
}

/** What the interceptor needs. */
export interface SpendCapCommandDeps {
  /** `orc` when the message is the owner writing in their DM with the orc */
  ownerDmScope: (message: SlackIncomingMessage) => 'orc' | 'agent' | null;
  replyTargetOf: (message: SlackIncomingMessage) => unknown;
  reply: (text: string, target: unknown) => Promise<unknown>;
  /** Configured agents (orc included) */
  agents: () => Promise<NamedAgent[]>;
  teams: () => Promise<NamedTeam[]>;
  setCaps: (patch: SpendCapPatch) => Promise<unknown>;
  boost: (input: BoostInput) => Promise<unknown>;
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
  const extra = compactTokens(suggestedBoost(stop.capTokens));
  const who = stop.scope === 'total' ? 'everyone' : stop.scope === 'team' ? (stop.teamName ?? 'the team') : 'orc';
  return `${spendCapReason(stop, 'Orc')}. No new turns start until midnight; your message is queued. To lift it for today, reply \`boost ${who} by ${extra} today\` or \`unlimited today for ${who}\` (or the Usage page (/usage)).`;
}

/** A resolved target. */
type Target = { scope: 'all' } | { scope: 'team'; team: NamedTeam } | { scope: 'agent'; session: string; name: string };

/**
 * Run a parsed command.
 *
 * @param cmd - Command
 * @param deps - Collaborators
 * @returns The owner's one-line answer
 */
export async function runSpendCapCommand(cmd: SpendCapCommand, deps: Pick<SpendCapCommandDeps, 'agents' | 'teams' | 'setCaps' | 'boost'>): Promise<string> {
  const agents = await deps.agents();
  const teams = await deps.teams();
  const agentOf = (target: string): { session: string; name: string } | null => {
    const session = resolveAgent(target, agents);
    if (!session) return null;
    return { session, name: session === ORCHESTRATOR_SESSION_NAME ? 'Orc' : (agents.find((a) => a.session === session)?.name ?? session) };
  };
  const unknown = (target: string): string => `I don't know a team or agent called "${target}". Use a team name (e.g. ${teams[0]?.name ?? 'CE'}), an agent's name or session name, or "everyone".`;
  const resolve = (target: string, preferTeam: boolean): Target | string => {
    if (EVERYONE.has(target.trim().toLowerCase())) return { scope: 'all' };
    const team = resolveTeam(target, teams);
    const agent = agentOf(target);
    if (team && (preferTeam || !agent)) return { scope: 'team', team };
    if (agent) return { scope: 'agent', ...agent };
    return unknown(target);
  };
  const label = (t: Target): string => (t.scope === 'all' ? 'everyone' : t.scope === 'team' ? `team ${t.team.name}` : t.name);
  const boostInput = (t: Target): Pick<BoostInput, 'scope' | 'id'> =>
    t.scope === 'all' ? { scope: 'all' } : t.scope === 'team' ? { scope: 'team', id: t.team.id } : { scope: 'agent', id: t.session };

  switch (cmd.kind) {
    case 'usd_hint':
      return 'Caps are counted in tokens now, not dollars. Try `set daily cap for orc to 5M`, `set team cap for CE to 50M`, or `boost CE by 20M today`.';
    case 'set_total':
      await deps.setCaps({ totalCapTokens: cmd.tokens });
      return `Daily token cap set to ${formatTokens(cmd.tokens)} for all agents together.`;
    case 'remove_total':
      await deps.setCaps({ totalCapTokens: null });
      return 'Daily total token cap removed.';
    case 'set': {
      if (!cmd.target) {
        await deps.setCaps({ defaultAgentCapTokens: cmd.tokens });
        return `Daily token cap set to ${formatTokens(cmd.tokens)} per agent (agents with their own cap keep it).`;
      }
      const t = resolve(cmd.target, cmd.team === true);
      if (typeof t === 'string') return t;
      if (t.scope === 'all') {
        await deps.setCaps({ totalCapTokens: cmd.tokens });
        return `Daily token cap set to ${formatTokens(cmd.tokens)} for all agents together.`;
      }
      if (t.scope === 'team') {
        await deps.setCaps({ teams: { [t.team.id]: cmd.tokens } });
        return `Daily token cap for team ${t.team.name} set to ${formatTokens(cmd.tokens)} (all its members together).`;
      }
      await deps.setCaps({ agents: { [t.session]: cmd.tokens } });
      return `Daily token cap for ${t.name} set to ${formatTokens(cmd.tokens)}.`;
    }
    case 'remove': {
      if (!cmd.target) {
        await deps.setCaps({ defaultAgentCapTokens: null });
        return 'Default daily token cap removed (agents with their own cap keep it).';
      }
      const t = resolve(cmd.target, cmd.team === true);
      if (typeof t === 'string') return t;
      if (t.scope === 'all') {
        await deps.setCaps({ totalCapTokens: null });
        return 'Daily total token cap removed.';
      }
      if (t.scope === 'team') {
        await deps.setCaps({ teams: { [t.team.id]: null } });
        return `Team ${t.team.name} has no daily token cap now.`;
      }
      await deps.setCaps({ agents: { [t.session]: null } });
      return `${t.name} has no daily token cap now.`;
    }
    case 'boost': {
      const t = resolve(cmd.target, true);
      if (typeof t === 'string') return t;
      await deps.boost({ ...boostInput(t), extraTokens: cmd.tokens, by: 'orc-dm' });
      return `Boosted ${label(t)} by +${formatTokens(cmd.tokens)} until midnight. Queued messages are being delivered.`;
    }
    case 'unlimited': {
      const t = resolve(cmd.target, true);
      if (typeof t === 'string') return t;
      await deps.boost({ ...boostInput(t), unlimited: true, by: 'orc-dm' });
      return `No token cap for ${label(t)} until midnight. Queued messages are being delivered.`;
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
