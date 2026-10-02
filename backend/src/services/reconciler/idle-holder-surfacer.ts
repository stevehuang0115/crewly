/**
 * Tell a team lead, once, that a worker went quiet holding a running WorkItem
 * (#842).
 *
 * {@link detectIdleHoldersOfRunningWork} finds the case; this turns each one
 * into a review WorkItem for the worker's team lead (the orchestrator when the
 * worker leads its own team or has none) and stamps the source item so it is
 * reported once.
 *
 * @module services/reconciler/idle-holder-surfacer
 */

import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import type { Team } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { pickTeamLead } from '../../utils/team.utils.js';
import { IDLE_HOLDER_SURFACED_AT_KEY, type IdleHolder } from './reconcile-rules.js';

/** What {@link surfaceIdleHolders} needs. */
export interface IdleHolderSurfacerDeps {
	loadTeams: () => Promise<Team[]>;
	addToPool: (wi: WorkItem) => Promise<unknown>;
	/** Merge metadata into a WorkItem. */
	stamp: (workItemId: string, patch: Record<string, unknown>) => Promise<unknown>;
	now?: () => Date;
}

/** Id suffix of the review WorkItem (one per source item). */
const REVIEW_ID_SUFFIX = ':review:idle_holder';

/**
 * The review WorkItem that reports one idle holder.
 *
 * @param holder - The idle holder
 * @param team - The worker's team, if known
 * @param now - Current time
 * @returns The review WorkItem
 */
export function buildIdleHolderReview(holder: IdleHolder, team: Team | null, now: Date): WorkItem {
	const { workItem: wi, agentSession } = holder;
	const lead = team ? pickTeamLead(team) : null;
	const target = lead?.sessionName && lead.sessionName !== agentSession ? lead.sessionName : ORCHESTRATOR_SESSION_NAME;
	const id = `${wi.id}${REVIEW_ID_SUFFIX}`;
	const title = (wi.title ?? '').split('\n')[0].slice(0, 80);
	return {
		id,
		type: 'review',
		owner: 'team_lead',
		target,
		title: `Went quiet on a running task: ${title}`,
		description: [
			`\`${agentSession}\` claimed WorkItem \`${wi.id}\` and then stopped: no output and no API call long enough for its claim to lapse, while its session is still up.`,
			'It did not report done, blocked or failed. The item went back to the queue and is offered to it again.',
			'Check whether it is stuck, waiting for something, or gave up without saying so; then unblock, re-assign or cancel the item.',
		].join('\n'),
		status: 'queued',
		createdAt: now.toISOString(),
		retryCount: 0,
		maxRetries: wi.maxRetries,
		requestId: wi.requestId,
		missionId: wi.missionId,
		parentWorkItemId: wi.parentWorkItemId,
		inputTokens: 0,
		outputTokens: 0,
		cost: 0,
		metadata: {
			...(team ? { teamId: team.id } : {}),
			idempotencyKey: id,
			reviewReason: 'idle_holder',
			sourceWorkItemId: wi.id,
		},
	} as WorkItem;
}

/**
 * Report each idle holder to its team lead, once per WorkItem.
 *
 * @param holders - From {@link detectIdleHoldersOfRunningWork}
 * @param deps - Teams, pool and metadata writer
 * @returns The review WorkItems that were queued
 */
export async function surfaceIdleHolders(holders: ReadonlyArray<IdleHolder>, deps: IdleHolderSurfacerDeps): Promise<WorkItem[]> {
	if (holders.length === 0) return [];
	const now = deps.now?.() ?? new Date();
	const teams = await deps.loadTeams().catch(() => [] as Team[]);
	const queued: WorkItem[] = [];
	for (const holder of holders) {
		const team = teams.find((t) => (t.members ?? []).some((m) => m.sessionName === holder.agentSession)) ?? null;
		const review = buildIdleHolderReview(holder, team, now);
		await deps.addToPool(review);
		await deps.stamp(holder.workItem.id, { [IDLE_HOLDER_SURFACED_AT_KEY]: now.toISOString() });
		queued.push(review);
	}
	return queued;
}
