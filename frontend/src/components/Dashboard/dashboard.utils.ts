/**
 * Dashboard helpers: who an agent session is, who is working on what right
 * now, and which two answers a decision shows inline
 * (specs/2026-10-02-ui-redesign.md, Dashboard).
 *
 * @module components/Dashboard/dashboard.utils
 */

import type { Team } from '@/types';
import type { DecisionOption, OwnerDecision } from '@/types/decision.types';
import { isOrchestratorSession, ORCHESTRATOR_LABEL } from '@/utils/team-chat.utils';

/** Display identity of an agent session. */
export interface AgentIdentity {
  /** Agent name ("Atlas") */
  name: string;
  /** Team name, when the agent belongs to one */
  team?: string;
}

/** Map of session name → identity. */
export type AgentDirectory = ReadonlyMap<string, AgentIdentity>;

/**
 * Build the session → name/team lookup from the teams list.
 *
 * @param teams - Teams with members
 * @returns Lookup by session name
 */
export function buildAgentDirectory(teams: readonly Team[]): AgentDirectory {
  const out = new Map<string, AgentIdentity>();
  for (const team of teams) {
    for (const m of team.members ?? []) {
      if (m.sessionName && !out.has(m.sessionName)) out.set(m.sessionName, { name: m.name, team: team.name });
    }
  }
  return out;
}

/**
 * The human name of a session ("Orchestrator", "Atlas"), falling back to the
 * raw session when the agent is unknown (removed team, system asker).
 *
 * @param session - Agent session name
 * @param directory - Lookup from {@link buildAgentDirectory}
 * @returns Identity to display
 */
export function resolveAgent(session: string, directory: AgentDirectory): AgentIdentity {
  const known = directory.get(session);
  if (known) return known;
  if (isOrchestratorSession(session)) return { name: ORCHESTRATOR_LABEL };
  return { name: session };
}

/** Label the backend gives the free-text answer option of a derived card. */
export const REPLY_OPTION_LABEL = 'Reply in thread';

/**
 * Split a decision's answers into the two shown as buttons and the rest
 * (shown in "⋯"). "Reply in thread" always goes to "⋯"; the default answer,
 * when it is an option, is shown first.
 *
 * @param d - Decision
 * @returns Inline (≤2) and overflow options, original keys kept
 */
export function splitDecisionOptions(d: Pick<OwnerDecision, 'options' | 'defaultKey'>): {
  inline: DecisionOption[];
  more: DecisionOption[];
} {
  const answers = d.options.filter((o) => o.label !== REPLY_OPTION_LABEL);
  const ordered = [
    ...answers.filter((o) => o.key === d.defaultKey),
    ...answers.filter((o) => o.key !== d.defaultKey),
  ];
  // Keep the agent's own order when the default is not first, so Yes / No
  // stay Yes / No; only lift the default when it would otherwise be hidden.
  const defaultIdx = answers.findIndex((o) => o.key === d.defaultKey);
  const inline = defaultIdx >= 2 ? ordered.slice(0, 2) : answers.slice(0, 2);
  const inlineKeys = new Set(inline.map((o) => o.key));
  return { inline, more: d.options.filter((o) => !inlineKeys.has(o.key)) };
}

/** A run (work item) as the dashboard reads it from `/api/task-pool/items`. */
export interface RunningItem {
  id?: string;
  title?: string;
  status?: string;
  /** Agent session the run is assigned to */
  target?: string;
  startedAt?: string;
  createdAt?: string;
}

/** One working agent. */
export interface CrewMember {
  session: string;
  name: string;
  team: string;
  /** What they are on ("adding the share card …"), or null when unknown */
  doing: string | null;
}

/** The crew right now: working agents first, idle ones on one line. */
export interface CrewSnapshot {
  working: CrewMember[];
  /** Names of agents that are running but not working */
  idle: string[];
}

/**
 * Who is working on what. An agent counts as working when its session is up
 * and it is busy or has a running run; it counts as idle when its session is
 * up and it is neither. Stopped agents are left out (Teams lists them).
 *
 * @param teams - Teams with members
 * @param running - Runs with status `running`
 * @returns Working and idle agents
 */
export function buildCrewSnapshot(teams: readonly Team[], running: readonly RunningItem[]): CrewSnapshot {
  const latestBySession = new Map<string, RunningItem>();
  for (const item of running) {
    if (!item.target || item.status !== 'running') continue;
    const prev = latestBySession.get(item.target);
    const at = (x: RunningItem): string => x.startedAt ?? x.createdAt ?? '';
    if (!prev || at(item) > at(prev)) latestBySession.set(item.target, item);
  }

  const working: CrewMember[] = [];
  const idle: string[] = [];
  const seen = new Set<string>();
  for (const team of teams) {
    for (const m of team.members ?? []) {
      if (!m.sessionName || seen.has(m.sessionName)) continue;
      seen.add(m.sessionName);
      const up = m.agentStatus === 'active' || m.agentStatus === 'started';
      if (!up) continue;
      const run = latestBySession.get(m.sessionName);
      if (run || m.workingStatus === 'in_progress') {
        working.push({ session: m.sessionName, name: m.name, team: team.name, doing: run?.title?.trim() || null });
      } else {
        idle.push(m.name);
      }
    }
  }
  return { working, idle };
}
