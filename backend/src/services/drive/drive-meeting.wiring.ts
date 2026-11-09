/**
 * Reading the sources of a 1:1 meeting (Meetings P2b, crewly#1415) from this
 * machine: which wiki vaults an agent may read, its latest handover, wiki
 * hits as meeting pages, and decision cards in the shape the pack uses. The
 * glue that binds these to the running services lives in index.ts.
 *
 * Privacy: an agent's vaults are its own teams' vaults and those teams'
 * project vaults — never the global wiki, never another team's.
 *
 * @module services/drive/drive-meeting.wiring
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MEETING_CONSTANTS } from '../../constants.js';
import type { Team } from '../../types/index.js';
import type { OwnerDecision } from '../../types/decision.types.js';
import { resolveMemberSessionName } from '../../utils/member-session-name.utils.js';
import { latestHandoverFile } from '../agent/runtime-session-recovery.js';
import type { WikiSearchHit } from '../wiki/wiki-search.service.js';
import type { MeetingDecisionSource } from './drive-meeting-pack.js';
import type { MeetingVault, MeetingWikiPageHit } from './drive-meeting.service.js';

/** Where team vaults live under the Crewly home. */
const TEAMS_DIR = 'teams';
const WIKI_DIR = 'wiki';
/** A project's vault, under its root. */
const PROJECT_VAULT = path.join('.crewly', 'wiki');

/**
 * The teams an agent is a member of.
 *
 * @param teams - Every team
 * @param agentSession - The agent
 * @returns Its teams, with its role in each
 */
export function teamsOfAgent(teams: readonly Team[], agentSession: string): Array<{ team: Team; role?: string }> {
  const out: Array<{ team: Team; role?: string }> = [];
  for (const team of teams) {
    const m = (team.members ?? []).find((x) => x?.id && resolveMemberSessionName(team.name, x) === agentSession);
    if (m) out.push({ team, ...(m.role ? { role: String(m.role) } : {}) });
  }
  return out;
}

/**
 * The vaults an agent may read: each of its teams' vaults, then those teams'
 * project vaults (deduplicated).
 *
 * @param teams - Every team
 * @param projects - Every project
 * @param agentSession - The agent
 * @param crewlyHome - CREWLY_HOME
 * @returns Vaults with labels (team / project names)
 */
export function vaultsOfAgent(
  teams: readonly Team[],
  projects: ReadonlyArray<{ id: string; name: string; path: string }>,
  agentSession: string,
  crewlyHome: string,
): MeetingVault[] {
  const out: MeetingVault[] = [];
  const seen = new Set<string>();
  const add = (vaultPath: string, label: string): void => {
    const key = path.resolve(vaultPath);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ vaultPath: key, label });
  };
  const mine = teamsOfAgent(teams, agentSession);
  for (const { team } of mine) add(path.join(crewlyHome, TEAMS_DIR, team.id, WIKI_DIR), team.name);
  for (const { team } of mine) {
    for (const id of team.projectIds ?? []) {
      const p = projects.find((x) => x.id === id);
      if (p?.path && path.isAbsolute(p.path)) add(path.join(p.path, PROJECT_VAULT), p.name);
    }
  }
  return out;
}

/**
 * A wiki hit as a meeting page: a readable title, where it is, its matching
 * lines, and the page file.
 *
 * @param hit - BM25 hit
 * @returns Page hit
 */
export function wikiHitToPage(hit: WikiSearchHit): MeetingWikiPageHit {
  const base = path.basename(hit.relativePath).replace(/\.md$/i, '');
  const title = base.replace(/[-_]+/g, ' ').trim() || hit.relativePath;
  return {
    title,
    where: hit.vaultLabel ? `${hit.vaultLabel}/${hit.relativePath}` : hit.relativePath,
    text: hit.snippets.map((s) => s.text).join(' … '),
    ...(hit.vaultPath ? { absPath: path.join(hit.vaultPath, hit.relativePath) } : {}),
  };
}

/**
 * Remove a page's YAML frontmatter.
 *
 * @param text - Page text
 * @returns The body
 */
export function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

/**
 * A wiki page's body, clipped, or null when it cannot be read.
 *
 * @param absPath - Page file
 * @returns The body
 */
export async function readWikiPage(absPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(absPath, 'utf8');
    return stripFrontmatter(raw).slice(0, MEETING_CONSTANTS.WIKI_PAGE_MAX_CHARS * 2);
  } catch {
    return null;
  }
}

/**
 * The agent's newest handover text, or null.
 *
 * @param handoverDir - Handover directory
 * @param agentSession - The agent
 * @returns Text (title line removed), clipped
 */
export async function readLatestHandover(handoverDir: string, agentSession: string): Promise<string | null> {
  const file = latestHandoverFile(handoverDir, agentSession);
  if (!file) return null;
  try {
    const raw = await fs.readFile(file.path, 'utf8');
    return raw.replace(/^#[^\n]*\n/, '').trim().slice(0, MEETING_CONSTANTS.HANDOVER_MAX_CHARS * 2) || null;
  } catch {
    return null;
  }
}

/**
 * A decision card in the shape the pack uses.
 *
 * @param d - Owner decision
 * @returns Pack source
 */
export function decisionSource(d: OwnerDecision): MeetingDecisionSource {
  return {
    id: d.id,
    question: d.question,
    status: d.status,
    asker: d.asker,
    requestedBy: d.requestedBy,
    options: d.options.map((o) => ({ key: o.key, label: o.label })),
    ...(d.card ? { card: { slackChannelId: d.card.slackChannelId, messageTs: d.card.messageTs, ...(d.card.threadTs ? { threadTs: d.card.threadTs } : {}) } } : {}),
    ...(d.place ? { place: d.place } : {}),
    ...(d.chosenKey ? { chosenKey: d.chosenKey } : {}),
    ...(d.answerText ? { answerText: d.answerText } : {}),
    ...(d.ownerWords ? { ownerWords: d.ownerWords } : {}),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}
