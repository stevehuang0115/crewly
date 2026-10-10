/**
 * Drive mode v3 status snapshot, machine half (mirrors crewly-services
 * `auth/src/drive/drive-briefing.contract.ts`; specs/2026-10-09-drive-mode-v3.md §1).
 *
 * The snapshot is what the voice orchestrator answers status questions from
 * ("how is CE doing?", "what is Ella on?", "where is CE-12?") without asking
 * an agent. This machine rebuilds it from structured data on every change
 * and pushes it:
 *
 *   PUT /api/cloud/instances/:instanceId/briefing {snapshot}   (this machine's Cloud token)
 *
 * Names, never secrets: every text field is clipped and passed through the
 * secret redactor before it leaves the machine. Pure types.
 *
 * @module services/drive/drive-briefing.contract
 */

/** Where a piece of work is (normalised across tickets and work items). */
export type BriefingItemStatus = 'open' | 'in_progress' | 'review' | 'blocked' | 'done' | 'cancelled';

/** What an agent is doing. */
export type BriefingAgentState = 'working' | 'idle' | 'starting' | 'stopped';

/** One team. */
export interface BriefingTeam {
  name: string;
  /** Lead's name */
  lead?: string;
  /** Members' names */
  agents: string[];
  open: number;
  inProgress: number;
  review: number;
  blocked: number;
  /** Finished in the last 24 h */
  doneToday: number;
}

/** One agent. */
export interface BriefingAgent {
  session: string;
  name: string;
  team?: string;
  role?: string;
  state: BriefingAgentState;
  /** What it is working on now, and since when */
  activity?: { title: string; since: string; ref?: string };
  /** Its last few messages to the owner, newest first, clipped */
  lastToOwner?: Array<{ at: string; text: string }>;
}

/** A project ticket or a task-pool work item. */
export interface BriefingItem {
  /** `CE-12`, `wi:1a2b3c4d` */
  ref: string;
  kind: 'ticket' | 'work';
  title: string;
  status: BriefingItemStatus;
  /** Assignee's name */
  assignee?: string;
  team?: string;
  project?: string;
  updatedAt: string;
  /** The last thing said about it (ticket log line, work item summary) */
  last?: string;
  /**
   * Tickets: when someone last worked on or wrote about it (ISO). Lets the
   * voice say "last updated 5 days ago". Absent on older machines.
   */
  lastActivityAt?: string;
  /** Tickets: whole days since `lastActivityAt` */
  idleDays?: number;
  /**
   * Tickets: open and silent past the stale threshold (3 days in progress /
   * review, 14 days ready / backlog), so the status may be outdated. The voice
   * should say so rather than state it as current. Absent = not flagged.
   */
  maybeOutdated?: true;
}

/** Something waiting on the owner (live card / question / review only). */
export interface BriefingWaiting {
  ref: string;
  kind: 'decision' | 'question' | 'review';
  from: string;
  team?: string;
  summary: string;
  since: string;
  urgency?: 'high' | 'normal' | 'low';
  /** A collapsed review entry (one agent, several finished things): every ticket it stands for */
  refs?: string[];
}

/** The snapshot this machine pushes. */
export interface BriefingSnapshot {
  v: 1;
  generatedAt: string;
  teams: BriefingTeam[];
  agents: BriefingAgent[];
  items: BriefingItem[];
  waiting: BriefingWaiting[];
}
