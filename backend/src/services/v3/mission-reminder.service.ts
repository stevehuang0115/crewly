/**
 * Mission Reminder Service
 *
 * Scans active Missions and sends proactive Slack reminders to KR owners
 * if their metrics are 'off_track' or 'at_risk'.
 *
 * Features:
 * - Periodic sweep of all active missions
 * - KR-level status evaluation via KRTrackingService
 * - Intelligent owner resolution (Mission owner -> Team Lead)
 * - Proactive Slack delivery via SlackOrchestratorBridge
 * - Rate limiting to prevent reminder fatigue (lastReminderAt tracking)
 *
 * @module services/v3/mission-reminder.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { StorageService } from '../core/storage.service.js';
import { KRTrackingService } from './kr-tracking.service.js';
import { getSlackOrchestratorBridge } from '../slack/slack-orchestrator-bridge.js';
import type { Mission } from '../../types/v2/mission.types.js';
import type { MissionOKRSummary } from '../../types/v2/key-result.types.js';
import { atomicWriteJson } from '../../utils/file-io.utils.js';
import { pickTeamLead } from '../../utils/team.utils.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum interval between reminders for the same mission (24 hours) */
const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function getMissionsDir(): string {
  return path.join(process.cwd(), '.crewly', 'missions');
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Service for sending proactive reminders for off-track OKRs.
 */
export class MissionReminderService {
  private static instance: MissionReminderService | null = null;
  private readonly logger: ComponentLogger;
  private readonly storageService: StorageService;
  private readonly krTrackingService: KRTrackingService;

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('MissionReminder');
    this.storageService = StorageService.getInstance();
    this.krTrackingService = KRTrackingService.getInstance();
  }

  static getInstance(): MissionReminderService {
    if (!MissionReminderService.instance) {
      MissionReminderService.instance = new MissionReminderService();
    }
    return MissionReminderService.instance;
  }

  static resetInstance(): void {
    MissionReminderService.instance = null;
  }

  /**
   * Run a full sweep of all active missions and send reminders where needed.
   *
   * @param force - If true, ignores the REMINDER_COOLDOWN_MS
   * @returns Summary of actions taken
   */
  async runSweep(force: boolean = false): Promise<{ checked: number; sent: number; skipped: number }> {
    const now = new Date();
    const missions = await this.loadAllActiveMissions();
    const result = { checked: 0, sent: 0, skipped: 0 };

    this.logger.info('Starting Mission OKR reminder sweep', { count: missions.length });

    for (const mission of missions) {
      result.checked++;

      // Check cooldown
      if (!force && mission.lastReminderAt) {
        const lastSent = new Date(mission.lastReminderAt);
        if (now.getTime() - lastSent.getTime() < REMINDER_COOLDOWN_MS) {
          result.skipped++;
          continue;
        }
      }

      try {
        // Get OKR progress summary
        const summary = await this.krTrackingService.computeMissionOKRProgress(mission.id);

        // If any KRs are off-track or at-risk, send a reminder
        if (summary.offTrack > 0 || summary.atRisk > 0) {
          const sent = await this.sendReminder(mission, summary);
          if (sent) {
            result.sent++;
            // Update lastReminderAt
            mission.lastReminderAt = now.toISOString();
            await this.saveMission(mission);
          }
        }
      } catch (err) {
        this.logger.error('Failed to process mission reminder', {
          missionId: mission.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.logger.info('Mission OKR reminder sweep complete', result);
    return result;
  }

  /**
   * Send a Slack reminder for a specific mission.
   */
  private async sendReminder(mission: Mission, summary: MissionOKRSummary): Promise<boolean> {
    const bridge = getSlackOrchestratorBridge();
    if (!bridge) {
      this.logger.warn('SlackOrchestratorBridge not available, cannot send reminder');
      return false;
    }

    // Resolve owner name for @mention
    const ownerName = await this.resolveOwnerName(mission);
    const urgency = summary.offTrack > 0 ? 'high' : 'normal';

    const message = this.formatReminderMessage(mission, summary, ownerName);

    try {
      await bridge.sendNotification({
        type: 'okr_reminder',
        title: `OKR Alert: ${mission.objective.slice(0, 50)}${mission.objective.length > 50 ? '...' : ''}`,
        message,
        urgency,
        timestamp: new Date().toISOString(),
        metadata: {
          missionId: mission.id,
          offTrack: summary.offTrack,
          atRisk: summary.atRisk,
        },
      });
      return true;
    } catch (err) {
      this.logger.error('Failed to send Slack notification', {
        missionId: mission.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Format the reminder message text.
   */
  private formatReminderMessage(mission: Mission, summary: MissionOKRSummary, ownerName: string): string {
    const statusLine = summary.offTrack > 0
      ? `🚨 *${summary.offTrack} Key Results are OFF TRACK*`
      : `⚠️ *${summary.atRisk} Key Results are AT RISK*`;

    return `Hello ${ownerName},

${statusLine} for Mission: "${mission.objective}"

Progress: ${Math.round(summary.overallProgress)}%
Total KRs: ${summary.totalKRs}
Achieved: ${summary.achieved}
On Track: ${summary.onTrack}
At Risk: ${summary.atRisk}
Off Track: ${summary.offTrack}

Please review the current strategy and adjust as needed.
cc: @${ORCHESTRATOR_SESSION_NAME}`;
  }

  /**
   * Resolve a human-readable name for the mission owner.
   */
  private async resolveOwnerName(mission: Mission): Promise<string> {
    // 1. Try explicit ownerId
    if (mission.ownerId) {
      const member = await this.storageService.getMemberById(mission.ownerId);
      if (member) return member.name;
    }

    // 2. Fallback to Team Lead of ownerTeamId via the canonical 4-rule
    //    cascade in `utils/team.utils.pickTeamLead` — same resolver used
    //    by chat-v2 mention dispatch so behavior cannot drift.
    const teams = await this.storageService.getTeams();
    const team = teams.find((t) => t.id === mission.ownerTeamId);
    if (team) {
      const leader = pickTeamLead(team);
      if (leader) return leader.name;
      return team.name;
    }

    return 'Team Lead';
  }

  /**
   * Load all missions with 'active' status.
   */
  private async loadAllActiveMissions(): Promise<Mission[]> {
    const dir = getMissionsDir();
    try {
      const files = await fs.readdir(dir);
      const missions: Mission[] = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(path.join(dir, file), 'utf-8');
          const mission = JSON.parse(raw) as Mission;
          if (mission.status === 'active') {
            missions.push(mission);
          }
        } catch {
          // Skip corrupt files
        }
      }
      return missions;
    } catch {
      return [];
    }
  }

  /**
   * Save a mission back to disk.
   */
  private async saveMission(mission: Mission): Promise<void> {
    const filePath = path.join(getMissionsDir(), `${mission.id}.json`);
    await atomicWriteJson(filePath, mission);
  }
}
