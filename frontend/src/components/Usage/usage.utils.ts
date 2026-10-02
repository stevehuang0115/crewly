/**
 * Usage page helpers: runtime labels, cap labels, links and bar widths.
 *
 * @module components/Usage/usage.utils
 */

import { compactTokens, type CapAgent, type CapTeam, type UsageBoost, type UsageRow } from '../../services/usage.service';
import { LINKS } from '../../constants/routes.constants';

/** Labels of runtimes. */
export const RUNTIME_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'crewly-agent': 'Crewly Agent',
  'codex-cli': 'Codex',
  'gemini-cli': 'Gemini CLI',
  'antigravity-cli': 'Antigravity',
  'opencode-cli': 'OpenCode',
  other: 'Other',
};

/**
 * Label of a runtime id.
 *
 * @param id - Runtime id
 * @returns Human label
 */
export function runtimeLabel(id: string): string {
  return RUNTIME_LABELS[id] ?? id;
}

/**
 * Text of a team's cap.
 *
 * @param t - Team row
 * @returns e.g. `50M cap (+20M today)`, `Unlimited today`, `No cap`
 */
export function teamCapLabel(t: Pick<CapTeam, 'baseCapTokens' | 'capTokens' | 'extraTokens' | 'unlimited'>): string {
  if (t.unlimited) return 'Unlimited today';
  if (t.baseCapTokens === null) return t.extraTokens > 0 ? `No cap (+${compactTokens(t.extraTokens)} boost)` : 'No cap';
  return t.extraTokens > 0 ? `${compactTokens(t.capTokens ?? t.baseCapTokens)} cap (+${compactTokens(t.extraTokens)} today)` : `${compactTokens(t.baseCapTokens)} cap`;
}

/**
 * Text of an agent's cap.
 *
 * @param a - Agent row
 * @returns e.g. `8M cap (default)`, `Unlimited today`, `No cap`
 */
export function agentCapLabel(a: Pick<CapAgent, 'capTokens' | 'capSource' | 'unlimited' | 'boosted'>): string {
  if (a.unlimited) return 'Unlimited today';
  if (a.capSource === 'exempt') return 'Not capped';
  if (a.capTokens === null) return 'No cap';
  const source = a.capSource === 'default' ? ' (default)' : '';
  return `${compactTokens(a.capTokens)} cap${source}${a.boosted ? ' · boosted' : ''}`;
}

/**
 * What a boost does, in words.
 *
 * @param b - Boost
 * @returns e.g. `+20M until midnight`
 */
export function boostLabel(b: Pick<UsageBoost, 'unlimited' | 'extraTokens'>): string {
  return b.unlimited ? 'Unlimited until midnight' : `+${compactTokens(b.extraTokens ?? 0)} until midnight`;
}

/**
 * Who a boost is for.
 *
 * @param target - Boost target (`*`, `team:<id>` or an agent session)
 * @param teams - Teams, for names
 * @param agents - Agents, for names
 * @returns Name
 */
export function boostTargetName(target: string, teams: Pick<CapTeam, 'teamId' | 'name'>[], agents: Pick<CapAgent, 'session' | 'name'>[]): string {
  if (target === '*') return 'Everyone';
  if (target.startsWith('team:')) {
    const id = target.slice(5);
    return teams.find((t) => t.teamId === id)?.name ?? id;
  }
  return agents.find((a) => a.session === target)?.name ?? target;
}

/**
 * Link of a work-item row, pointed at its new home (Tickets › Runs).
 *
 * @param row - Stats row
 * @returns Path, or undefined when the row has none
 */
export function workItemLink(row: Pick<UsageRow, 'key' | 'link'>): string | undefined {
  if (!row.link) return undefined;
  const m = /^\/workitems\/([^/?#]+)/.exec(row.link);
  return m ? LINKS.run(decodeURIComponent(m[1])) : row.link;
}

/**
 * Bar width relative to the largest row (the largest is full width).
 *
 * @param total - This row's tokens
 * @param max - Largest row's tokens
 * @returns CSS width, e.g. `56%`
 */
export function barWidth(total: number, max: number): string {
  if (max <= 0 || total <= 0) return '0%';
  return `${Math.max(1, Math.round((total / max) * 100))}%`;
}

/**
 * Share as a short percentage.
 *
 * @param share - 0..1
 * @returns e.g. `56%`, `<1%`
 */
export function shareLabel(share: number): string {
  if (share > 0 && share < 0.01) return '<1%';
  return `${Math.round(share * 100)}%`;
}
