/**
 * OKR Owner Guidance — the part of the goal layer that reaches out to the
 * owner instead of waiting to be looked at.
 *
 * Observed on steamfun-ops (2026-09-18): a team OKR proposal sat in
 * `pending_approval` and nothing told anyone. The hourly sweep skips pending
 * missions by design, the orchestrator only learns about goals through a
 * memory search at registration, and the owner would only find the proposal
 * by opening the Missions page. Two behaviours fix that:
 *
 * 1. **Approval nudge** — every pending proposal is surfaced to the owner
 *    (Slack DM through the orchestrator bridge + a line in the orchestrator's
 *    queue so it can mention it in chat), once, then again every 24 h while
 *    it stays pending. Persisted on the mission as `lastApprovalNudgeAt`.
 * 2. **Weekly digest** — on a cron boundary (default Monday 09:00 UTC,
 *    `CREWLY_OKR_DIGEST_CRON` / `CREWLY_OKR_DIGEST_TZ`) one message per
 *    account: each mission's KRs with current → target and status, pending
 *    proposals, stale missions. State in `~/.crewly/okr-digest-state.json`.
 *
 * Both are failure-soft and run from {@link MissionReminderService.runSweep}.
 *
 * @module services/v3/okr-owner-guidance.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import { getMissionsDir } from './mission-paths.js';
import { isMissionExecutable, type Mission } from '../../types/v2/mission.types.js';
import type { KeyResult } from '../../types/v2/key-result.types.js';
import { OKR_GUIDANCE_CONSTANTS } from '../../constants.js';

/** Sends an owner-facing notification (Slack via the orchestrator bridge). */
export type OwnerNotifier = (input: { title: string; message: string; urgency: 'normal' | 'high'; metadata?: Record<string, unknown> }) => Promise<void>;
/** Puts a line in the orchestrator's queue so it can mention it in chat. */
export type OrchestratorNotifier = (content: string) => void;
/** Lists a mission's Key Results. */
export type KeyResultLister = (missionId: string) => Promise<KeyResult[]>;

/** Persisted digest state. */
interface DigestState {
  lastDigestAt?: string;
}

/** What one guidance pass did. */
export interface GuidanceOutcome {
  pendingProposals: number;
  nudged: number;
  digestSent: boolean;
}

/** Constructor dependencies (all injectable for tests). */
export interface OKROwnerGuidanceDeps {
  notifyOwner?: OwnerNotifier | null;
  notifyOrchestrator?: OrchestratorNotifier | null;
  listKeyResults: KeyResultLister;
  loadMissions?: () => Promise<Mission[]>;
  saveMission?: (mission: Mission) => Promise<void>;
  statePath?: string | null;
  now?: () => Date;
  digestCron?: string;
  digestTz?: string;
}

const STATE_FILE = 'okr-digest-state.json';

/**
 * Render a KR line for a human: `KR1 …: 3 → 2 tickets (on_track)`.
 *
 * @param kr - Key Result
 * @returns One line
 */
export function formatKrLine(kr: KeyResult): string {
  const unit = kr.unit ? ` ${kr.unit}` : '';
  return `• ${kr.title}: ${kr.current} → ${kr.target}${unit} (${kr.status.replace('_', ' ')})`;
}

/**
 * Owner-facing guidance for the OKR layer. See module docs.
 */
export class OKROwnerGuidanceService {
  private static instance: OKROwnerGuidanceService | null = null;
  private readonly logger: ComponentLogger;
  private readonly deps: Required<Pick<OKROwnerGuidanceDeps, 'listKeyResults' | 'loadMissions' | 'saveMission' | 'now' | 'digestCron' | 'digestTz'>> &
    Pick<OKROwnerGuidanceDeps, 'notifyOwner' | 'notifyOrchestrator' | 'statePath'>;

  constructor(deps: OKROwnerGuidanceDeps) {
    this.logger = LoggerService.getInstance().createComponentLogger('OKROwnerGuidance');
    this.deps = {
      notifyOwner: deps.notifyOwner ?? null,
      notifyOrchestrator: deps.notifyOrchestrator ?? null,
      listKeyResults: deps.listKeyResults,
      loadMissions: deps.loadMissions ?? loadAllMissionsFromDisk,
      saveMission: deps.saveMission ?? saveMissionToDisk,
      statePath: deps.statePath === undefined ? path.join(getCrewlyHomePath(), STATE_FILE) : deps.statePath,
      now: deps.now ?? (() => new Date()),
      digestCron: deps.digestCron ?? process.env['CREWLY_OKR_DIGEST_CRON'] ?? OKR_GUIDANCE_CONSTANTS.DIGEST_CRON,
      digestTz: deps.digestTz ?? process.env['CREWLY_OKR_DIGEST_TZ'] ?? OKR_GUIDANCE_CONSTANTS.DIGEST_TZ,
    };
  }

  static getInstance(): OKROwnerGuidanceService | null {
    return this.instance;
  }

  static setInstance(next: OKROwnerGuidanceService | null): void {
    this.instance = next;
  }

  /** Late-bound notifiers (the bridge and the queue exist after boot). */
  setNotifiers(owner: OwnerNotifier | null, orchestrator: OrchestratorNotifier | null): void {
    this.deps.notifyOwner = owner;
    this.deps.notifyOrchestrator = orchestrator;
  }

  /**
   * One guidance pass: nudge pending proposals, then send the digest if its
   * cron boundary has passed since the last one. Never throws.
   *
   * @returns Counts for the sweep log
   */
  async run(): Promise<GuidanceOutcome> {
    const outcome: GuidanceOutcome = { pendingProposals: 0, nudged: 0, digestSent: false };
    let missions: Mission[] = [];
    try {
      missions = await this.deps.loadMissions();
    } catch (err) {
      this.logger.warn('Could not load missions for owner guidance', { error: errText(err) });
      return outcome;
    }
    const now = this.deps.now();
    const pending = missions.filter((m) => m.status === 'active' && m.approval?.state === 'pending_approval');
    outcome.pendingProposals = pending.length;
    for (const mission of pending) {
      try {
        if (await this.nudgeIfDue(mission, missions, now)) outcome.nudged += 1;
      } catch (err) {
        this.logger.warn('Approval nudge failed', { missionId: mission.id, error: errText(err) });
      }
    }
    try {
      outcome.digestSent = await this.sendDigestIfDue(missions, now);
    } catch (err) {
      this.logger.warn('Weekly OKR digest failed', { error: errText(err) });
    }
    return outcome;
  }

  /**
   * Nudge the owner about one pending proposal when never nudged or the
   * cooldown has elapsed.
   *
   * @param mission - A pending_approval mission
   * @param all - All missions (to name the parent)
   * @param now - Clock
   * @returns Whether a nudge went out
   */
  private async nudgeIfDue(mission: Mission, all: Mission[], now: Date): Promise<boolean> {
    const last = mission.lastApprovalNudgeAt ? Date.parse(mission.lastApprovalNudgeAt) : 0;
    if (now.getTime() - last < OKR_GUIDANCE_CONSTANTS.APPROVAL_NUDGE_COOLDOWN_MS) return false;
    const krs = await this.deps.listKeyResults(mission.id).catch(() => [] as KeyResult[]);
    const parent = mission.parentMissionId ? all.find((m) => m.id === mission.parentMissionId) : undefined;
    const lines = [
      `A ${mission.level ?? 'team'} OKR proposal is waiting for your approval:`,
      `*${mission.objective}*`,
      parent ? `Under: ${parent.objective}` : undefined,
      krs.length > 0 ? 'Key Results:' : 'No Key Results attached yet.',
      ...krs.slice(0, OKR_GUIDANCE_CONSTANTS.MAX_KRS_IN_MESSAGE).map(formatKrLine),
      `Approve or reject it on the Missions page (mission ${mission.id}). Nothing runs until you do.`,
    ].filter((l): l is string => Boolean(l));
    const message = lines.join('\n');
    if (this.deps.notifyOwner) {
      await this.deps.notifyOwner({
        title: 'OKR proposal awaiting your approval',
        message,
        urgency: 'normal',
        metadata: { missionId: mission.id, kind: 'okr_proposal_pending' },
      });
    }
    this.deps.notifyOrchestrator?.(
      `[OKR-APPROVAL] Mission ${mission.id} ("${mission.objective.slice(0, 80)}") is pending the owner's approval. Mention it the next time you talk to the owner; do not execute, remind or decompose it until it is approved.`,
    );
    mission.lastApprovalNudgeAt = now.toISOString();
    await this.deps.saveMission(mission);
    this.logger.info('Owner nudged about pending OKR proposal', { missionId: mission.id, krs: krs.length });
    return true;
  }

  /**
   * Send the weekly digest when the cron boundary has passed since the last
   * digest (or ever).
   *
   * @param missions - All missions
   * @param now - Clock
   * @returns Whether a digest went out
   */
  private async sendDigestIfDue(missions: Mission[], now: Date): Promise<boolean> {
    if (!this.deps.notifyOwner && !this.deps.notifyOrchestrator) return false;
    const state = await this.loadState();
    let boundary: Date;
    try {
      boundary = CronExpressionParser.parse(this.deps.digestCron, { currentDate: now, tz: this.deps.digestTz }).prev().toDate();
    } catch (err) {
      this.logger.warn('Invalid OKR digest cron — digest disabled', { cron: this.deps.digestCron, error: errText(err) });
      return false;
    }
    if (!state.lastDigestAt) {
      // First run: start the schedule from now instead of firing a digest at
      // every fresh boot on whatever day it happens to be.
      await this.saveState({ lastDigestAt: now.toISOString() });
      return false;
    }
    if (Date.parse(state.lastDigestAt) >= boundary.getTime()) return false;
    const live = missions.filter((m) => isMissionExecutable(m));
    const pending = missions.filter((m) => m.status === 'active' && m.approval?.state === 'pending_approval');
    if (live.length === 0 && pending.length === 0) {
      // Nothing to report — still stamp so we do not re-check every sweep.
      await this.saveState({ lastDigestAt: now.toISOString() });
      return false;
    }
    const sections: string[] = [`*Weekly OKR digest* — ${now.toISOString().slice(0, 10)}`];
    for (const m of live) {
      const krs = await this.deps.listKeyResults(m.id).catch(() => [] as KeyResult[]);
      const stale = (m.staleCycles ?? 0) >= OKR_GUIDANCE_CONSTANTS.STALE_CYCLES_FLAG ? ' ⚠️ no progress' : '';
      sections.push([`*${m.objective}* (${m.level ?? 'company'})${stale}`, ...(krs.length ? krs.slice(0, OKR_GUIDANCE_CONSTANTS.MAX_KRS_IN_MESSAGE).map(formatKrLine) : ['• no Key Results'])].join('\n'));
    }
    if (pending.length > 0) {
      sections.push(['*Waiting for your approval:*', ...pending.map((m) => `• ${m.objective} (mission ${m.id})`)].join('\n'));
    }
    const message = sections.join('\n\n');
    if (this.deps.notifyOwner) {
      await this.deps.notifyOwner({ title: 'Weekly OKR digest', message, urgency: 'normal', metadata: { kind: 'okr_digest' } });
    }
    this.deps.notifyOrchestrator?.(`[OKR-DIGEST] The weekly OKR digest was sent to the owner (${live.length} live, ${pending.length} pending). If the owner asks, the numbers are in the Missions page.`);
    await this.saveState({ lastDigestAt: now.toISOString() });
    this.logger.info('Weekly OKR digest sent', { live: live.length, pending: pending.length });
    return true;
  }

  private async loadState(): Promise<DigestState> {
    if (!this.deps.statePath) return this.memoryState;
    return safeReadJson<DigestState>(this.deps.statePath, {});
  }

  private memoryState: DigestState = {};

  private async saveState(state: DigestState): Promise<void> {
    this.memoryState = state;
    if (!this.deps.statePath) return;
    await atomicWriteJson(this.deps.statePath, state);
  }
}

/**
 * Read every mission file in the shared missions dir (corrupt files skipped).
 *
 * @returns All missions, any status
 */
export async function loadAllMissionsFromDisk(): Promise<Mission[]> {
  const dir = getMissionsDir();
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: Mission[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(await fs.readFile(path.join(dir, f), 'utf-8')) as Mission);
    } catch {
      // skip
    }
  }
  return out;
}

/**
 * Persist one mission back to its file.
 *
 * @param mission - Mission to write
 */
export async function saveMissionToDisk(mission: Mission): Promise<void> {
  await atomicWriteJson(path.join(getMissionsDir(), `${mission.id}.json`), mission);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
