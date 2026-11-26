/**
 * Temporary-member history and seat requests — one bounded JSON file in
 * CREWLY_HOME (`temp-members.json`,
 * specs/2026-11-26-temp-members-seat-requests.md).
 *
 * The history (each temporary member opened, removed or made permanent) is
 * the evidence shown on a seat-request card and in the daily digest. Seat
 * requests are kept here too, keyed by their owner card.
 *
 * @module services/temp-members/temp-member.store
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { TEMP_MEMBER_CONSTANTS } from '../../constants.js';
import { atomicWriteFile, readJsonStore } from '../../utils/file-io.utils.js';

/** What happened to a temporary member. */
export type TempMemberEventType = 'created' | 'removed' | 'converted';

/** One history line. */
export interface TempMemberEvent {
  type: TempMemberEventType;
  /** ISO time */
  at: string;
  teamId: string;
  teamName: string;
  memberId: string;
  memberName: string;
  /** The member's agent id (session) */
  session: string;
  role: string;
  /** Why it was created (`created`), or why it went (`removed` / `converted`) */
  reason: string;
  /** Who did it: a lead's session, `system` (automatic removal) or `owner` (seat approved) */
  by: string;
  workItemId?: string;
}

/** How a seat request ended. */
export type SeatRequestStatus = 'open' | 'approved' | 'declined';

/** A lead's request for a permanent seat. */
export interface SeatRequest {
  /** Owner decision id (the card) */
  decisionId: string;
  teamId: string;
  teamName: string;
  role: string;
  /** Name the lead asked for, if any */
  name?: string;
  reason: string;
  askerSession: string;
  askerName: string;
  /** ISO time it was asked */
  at: string;
  status: SeatRequestStatus;
  /** ISO time it settled */
  settledAt?: string;
  /** Member that fills the seat (approved) */
  memberId?: string;
}

/** The file. */
interface StoreFile {
  version: 1;
  events: TempMemberEvent[];
  seatRequests: SeatRequest[];
}

/** File-backed store; writes are serialised and atomic. */
export class TempMemberStore {
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * @param filePath - Absolute path of the JSON file
   */
  constructor(private readonly filePath: string) {}

  /**
   * Store under a Crewly home.
   *
   * @param crewlyHome - CREWLY_HOME
   * @returns Store
   */
  static inHome(crewlyHome: string): TempMemberStore {
    return new TempMemberStore(path.join(crewlyHome, TEMP_MEMBER_CONSTANTS.STORE_FILE));
  }

  /**
   * History lines, oldest first, optionally from a time on.
   *
   * @param sinceMs - Only events at or after this time (epoch ms)
   * @returns Events
   */
  async events(sinceMs?: number): Promise<TempMemberEvent[]> {
    const { events } = await this.load();
    return sinceMs === undefined ? events : events.filter((e) => Date.parse(e.at) >= sinceMs);
  }

  /**
   * Append a history line (the oldest are dropped past the cap).
   *
   * @param event - Line to add
   * @returns The stored line
   */
  record(event: TempMemberEvent): Promise<TempMemberEvent> {
    return this.write((data) => {
      data.events = [...data.events, event].slice(-TEMP_MEMBER_CONSTANTS.MAX_EVENTS);
      return event;
    });
  }

  /**
   * Every seat request, oldest first.
   *
   * @returns Requests
   */
  async seatRequests(): Promise<SeatRequest[]> {
    return (await this.load()).seatRequests;
  }

  /**
   * Add a seat request (settled ones are dropped first when past the cap).
   *
   * @param request - Request to add
   * @returns The stored request
   */
  addSeatRequest(request: SeatRequest): Promise<SeatRequest> {
    return this.write((data) => {
      const all = [...data.seatRequests, request];
      let over = all.length - TEMP_MEMBER_CONSTANTS.MAX_SEAT_REQUESTS;
      data.seatRequests = all.filter((r) => {
        if (over > 0 && r.status !== 'open') {
          over -= 1;
          return false;
        }
        return true;
      });
      return request;
    });
  }

  /**
   * Change the seat request of a decision.
   *
   * @param decisionId - Owner decision id
   * @param patch - Fields to set
   * @returns The changed request, or null when there is none
   */
  updateSeatRequest(decisionId: string, patch: Partial<SeatRequest>): Promise<SeatRequest | null> {
    return this.write((data) => {
      const i = data.seatRequests.findIndex((r) => r.decisionId === decisionId);
      if (i === -1) return null;
      data.seatRequests[i] = { ...data.seatRequests[i], ...patch };
      return data.seatRequests[i];
    });
  }

  /**
   * Run one serialised read-modify-write.
   *
   * @param mutate - Changes the loaded file in place and returns the result
   * @returns What `mutate` returned
   */
  private write<T>(mutate: (data: StoreFile) => T): Promise<T> {
    const run = this.chain.then(async () => {
      const data = await this.load();
      const result = mutate(data);
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await atomicWriteFile(this.filePath, JSON.stringify(data, null, 2));
      return result;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Read the file (an absent or unreadable file is an empty store).
   *
   * @returns File content
   */
  private async load(): Promise<StoreFile> {
    const read = await readJsonStore<StoreFile>(this.filePath, {
      validate: (d) => (d && typeof d === 'object' && Array.isArray((d as StoreFile).events) ? null : 'not a temp-member store'),
    });
    if (read.status === 'ok') return { version: 1, events: read.data.events ?? [], seatRequests: read.data.seatRequests ?? [] };
    return { version: 1, events: [], seatRequests: [] };
  }
}
