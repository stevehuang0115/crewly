/**
 * Wiring for {@link planTeamLeadReport} (crewly#1371): the real teams, team
 * channels and pool. The planning stays in `team-lead-report.ts`.
 *
 * @module services/orc/team-lead-report.wiring
 */

import type { Team } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { isOrchestratorSender } from './orc-delivery-enforcer.service.js';
import { findStatusWorkItem } from './orc-status-routing.js';
import { leadReportOf, planTeamLeadReport, type LeadReport } from './team-lead-report.js';

/** Collaborators of {@link resolveLeadReport}. */
export interface LeadReportSources {
  /** The team → Slack channel mappings, or null when Slack team channels are not set up */
  channels(): Promise<Array<{ teamId: string; slackChannelId: string; slackChannelName: string }> | null>;
  /** Every team */
  teams(): Promise<Team[]>;
}

/**
 * The real sources (lazy imports keep this module light).
 *
 * @returns Sources
 */
export function defaultLeadReportSources(): LeadReportSources {
  return {
    channels: async () => {
      const { getSlackTeamChannelService } = await import('../slack/slack-team-channel.service.js');
      const service = getSlackTeamChannelService();
      return service ? service.listMappings() : null;
    },
    teams: async () => {
      const { StorageService } = await import('../core/storage.service.js');
      return StorageService.getInstance().getTeams();
    },
  };
}

/**
 * Who reports a new work item to the owner, and where: the stamp to put on
 * it (see {@link planTeamLeadReport}). Never throws.
 *
 * @param input - The item (origin already stamped), its creator, the pool
 * @param sources - Teams and channels (default: the real ones)
 * @returns The stamp, or null
 */
export async function resolveLeadReport(
  input: { workItem: WorkItem; creator?: string; items: readonly WorkItem[] },
  sources: LeadReportSources = defaultLeadReportSources(),
): Promise<LeadReport | null> {
  try {
    if (!input.creator || !input.workItem.target) return null;
    // No team channels → nowhere for a lead to report; checked first so
    // nothing reads the team store when Slack is not set up.
    const channels = await sources.channels();
    if (!channels || channels.length === 0) return null;
    const teams = await sources.teams();
    return planTeamLeadReport({
      workItem: input.workItem,
      creator: input.creator,
      teams,
      isOrchestrator: isOrchestratorSender,
      channelOf: (teamId) => {
        const m = channels.find((c) => c.teamId === teamId);
        return m ? { slackChannelId: m.slackChannelId, channelName: m.slackChannelName } : null;
      },
      items: input.items,
    });
  } catch {
    return null;
  }
}

/**
 * The lead report of the work an agent status report is about (the item it
 * names, else the sender's current or just-finished item). Never throws.
 *
 * @param input - Sender and the work item the report named
 * @param poolItems - Pool items (default: the task pool)
 * @param now - Clock (epoch ms)
 * @returns The stamp, or null
 */
export async function leadReportForStatus(
  input: { sender: string; workItemId?: string },
  poolItems?: () => Promise<WorkItem[]>,
  now: number = Date.now(),
): Promise<LeadReport | null> {
  try {
    const load =
      poolItems ??
      (async () => {
        const { TaskPoolService } = await import('../task-pool/task-pool.service.js');
        return TaskPoolService.getInstance().getAllItems();
      });
    const items = await load();
    return leadReportOf(findStatusWorkItem(items, input.sender, input.workItemId, now));
  } catch {
    return null;
  }
}
