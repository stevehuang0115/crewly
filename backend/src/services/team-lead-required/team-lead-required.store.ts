/**
 * Which teams were asked about their missing lead
 * (`<CREWLY_HOME>/team-lead-required.json`).
 *
 * One record per team. Writes are atomic (temp file + rename); an unreadable
 * file reads as empty. specs/2026-10-04-tl-delegation.md §6
 *
 * @module services/team-lead-required/team-lead-required.store
 */

import * as fs from 'fs';
import * as path from 'path';
import { TEAM_LEAD_REQUIRED_CONSTANTS } from '../../constants.js';

/**
 * Where a team's question stands.
 *
 * - `asked`: a card is waiting for the owner
 * - `snoozed`: the owner said "Not now" (or did not answer); not asked again
 *   until `snoozedUntil`
 */
export type TeamLeadAskStatus = 'asked' | 'snoozed';

/** A member offered on the card. */
export interface TeamLeadCandidate {
  memberId: string;
  /** The option label (the member's name as shown on the button) */
  label: string;
}

/** One team's record. */
export interface TeamLeadAskRecord {
  teamId: string;
  status: TeamLeadAskStatus;
  /** ISO time of the last change */
  updatedAt: string;
  /** Decision card of the current / last ask */
  decisionId?: string;
  /** Members offered on that card, in option order */
  candidates?: TeamLeadCandidate[];
  /** ISO time before which the team is not asked about again (status `snoozed`) */
  snoozedUntil?: string;
}

/** File shape. */
interface TeamLeadFile {
  version: 1;
  teams: Record<string, TeamLeadAskRecord>;
}

const STATUSES: readonly TeamLeadAskStatus[] = ['asked', 'snoozed'];

/** Reads and writes the records. */
export class TeamLeadRequiredStore {
  /**
   * @param file - JSON file path
   */
  constructor(private readonly file: string) {}

  /**
   * Store in a Crewly home.
   *
   * @param crewlyHome - CREWLY_HOME
   * @returns Store
   */
  static inHome(crewlyHome: string): TeamLeadRequiredStore {
    return new TeamLeadRequiredStore(path.join(crewlyHome, TEAM_LEAD_REQUIRED_CONSTANTS.STORE_FILENAME));
  }

  /** @returns Every record, keyed by team id */
  all(): Record<string, TeamLeadAskRecord> {
    return this.read().teams;
  }

  /**
   * One record.
   *
   * @param teamId - Team id
   * @returns Record, or null
   */
  get(teamId: string): TeamLeadAskRecord | null {
    return this.read().teams[teamId] ?? null;
  }

  /**
   * Replace a record.
   *
   * @param record - Record
   * @returns The record
   */
  set(record: TeamLeadAskRecord): TeamLeadAskRecord {
    const data = this.read();
    data.teams[record.teamId] = record;
    this.write(data);
    return record;
  }

  /**
   * Forget a team.
   *
   * @param teamId - Team id
   * @returns True when a record was removed
   */
  delete(teamId: string): boolean {
    const data = this.read();
    if (!data.teams[teamId]) return false;
    delete data.teams[teamId];
    this.write(data);
    return true;
  }

  /**
   * Read the file (a missing or broken file, or a malformed record, reads as absent).
   *
   * @returns File contents
   */
  private read(): TeamLeadFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Partial<TeamLeadFile>;
      const teams: Record<string, TeamLeadAskRecord> = {};
      for (const [teamId, r] of Object.entries(raw.teams ?? {})) {
        if (!r || !STATUSES.includes(r.status) || typeof r.updatedAt !== 'string') continue;
        teams[teamId] = { ...r, teamId };
      }
      return { version: 1, teams };
    } catch {
      return { version: 1, teams: {} };
    }
  }

  /**
   * Write the file atomically.
   *
   * @param data - File contents
   */
  private write(data: TeamLeadFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
