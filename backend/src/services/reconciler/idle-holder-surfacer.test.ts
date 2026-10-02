/**
 * Idle holder of a running WorkItem is reported to the team lead once (#842).
 *
 * The reported sequence: a worker claims a WorkItem, then stops working
 * without reporting done/blocked/failed while its session stays up. Its lease
 * runs out, the claim is revoked and the item goes back to the queue — and
 * before this, nobody was told.
 *
 * @module services/reconciler/idle-holder-surfacer.test
 */

import { createTaskClaim, createWorkItem } from '../../types/v2/index.js';
import type { TaskClaim, WorkItem } from '../../types/v2/index.js';
import type { Team } from '../../types/index.js';
import {
	detectExpiredClaims,
	detectIdleHoldersOfRunningWork,
	IDLE_HOLDER_SURFACED_AT_KEY,
	type AgentHealth,
} from './reconcile-rules.js';
import { surfaceIdleHolders, buildIdleHolderReview } from './idle-holder-surfacer.js';

jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
		}),
	},
}));

const WORKER = 'think-tank-sage-2ffacc8f';
const LEAD = 'think-tank-atlas-b4e166f6';

const TEAM = {
	id: 'team-think-tank',
	name: 'Think Tank',
	leaderIds: ['m-atlas'],
	members: [
		{ id: 'm-atlas', name: 'Atlas', sessionName: LEAD, role: 'team-leader', canDelegate: true, hierarchyLevel: 1 },
		{ id: 'm-sage', name: 'Sage', sessionName: WORKER, role: 'researcher' },
	],
} as unknown as Team;

/** A running WorkItem held by the worker. */
function runningItem(overrides: Partial<WorkItem> = {}): WorkItem {
	return {
		...createWorkItem({ type: 'delegate', owner: 'agent', title: 'Summarise the sermon transcripts', target: WORKER }),
		status: 'running',
		...overrides,
	};
}

/** The worker's claim, lease and grace long gone (status already `expiring`). */
function lapsedClaim(wi: WorkItem): TaskClaim {
	return {
		...createTaskClaim({ workItemId: wi.id, agentId: WORKER }),
		status: 'expiring',
		leaseExpiresAt: new Date(Date.now() - 30 * 60_000).toISOString(),
	};
}

/** Health map with the worker's session up but quiet for an hour. */
function quietWorker(overrides: Partial<AgentHealth> = {}): Map<string, AgentHealth> {
	return new Map([[WORKER, {
		sessionName: WORKER,
		status: 'active',
		lastActivityAt: new Date(Date.now() - 60 * 60_000).toISOString(),
		...overrides,
	}]]);
}

describe('idle holder of running work (#842)', () => {
	it('a quiet worker whose claim lapses is reported to its lead once', async () => {
		const wi = runningItem();
		const claim = lapsedClaim(wi);
		const health = quietWorker();

		// The reconciler revokes the lapsed claim of a quiet holder…
		const expired = detectExpiredClaims([claim], undefined, health);
		expect(expired.revokedIds).toEqual([claim.id]);

		// …and the holder is still up, so it stopped without reporting.
		const holders = detectIdleHoldersOfRunningWork([claim], expired.revokedIds, [wi], health);
		expect(holders).toEqual([{ workItem: wi, agentSession: WORKER }]);

		const added: WorkItem[] = [];
		const stamps: Array<[string, Record<string, unknown>]> = [];
		const reviews = await surfaceIdleHolders(holders, {
			loadTeams: async () => [TEAM],
			addToPool: async (r) => { added.push(r); },
			stamp: async (id, patch) => { stamps.push([id, patch]); },
		});

		expect(reviews).toHaveLength(1);
		expect(added[0]).toMatchObject({
			id: `${wi.id}:review:idle_holder`,
			type: 'review',
			target: LEAD,
			status: 'queued',
			metadata: { reviewReason: 'idle_holder', sourceWorkItemId: wi.id, teamId: 'team-think-tank' },
		});
		expect(added[0].description).toContain(WORKER);
		expect(stamps).toEqual([[wi.id, { [IDLE_HOLDER_SURFACED_AT_KEY]: expect.any(String) }]]);

		// Once stamped, the next lapse of the same item is not reported again.
		const stamped = { ...wi, metadata: { ...(wi.metadata ?? {}), [IDLE_HOLDER_SURFACED_AT_KEY]: new Date().toISOString() } };
		expect(detectIdleHoldersOfRunningWork([claim], [claim.id], [stamped], health)).toEqual([]);
	});

	it('does not report a worker whose session is gone (the stuck rule handles it)', () => {
		const wi = runningItem();
		const claim = lapsedClaim(wi);
		expect(detectIdleHoldersOfRunningWork([claim], [claim.id], [wi], quietWorker({ status: 'inactive' }))).toEqual([]);
	});

	it('does not report a worker sitting on a human prompt (waiting_on_human handles it)', () => {
		const wi = runningItem();
		const claim = lapsedClaim(wi);
		const waiting = quietWorker({ waitingOnHumanSince: new Date().toISOString() });
		expect(detectIdleHoldersOfRunningWork([claim], [claim.id], [wi], waiting)).toEqual([]);
	});

	it('does not report a claim that is not being revoked', () => {
		const wi = runningItem();
		const claim = lapsedClaim(wi);
		expect(detectIdleHoldersOfRunningWork([claim], [], [wi], quietWorker())).toEqual([]);
	});

	it('a worker that is visibly working keeps its claim and is not reported', () => {
		const wi = runningItem();
		const claim = lapsedClaim(wi);
		const busy = quietWorker({ lastActivityAt: new Date().toISOString() });
		const expired = detectExpiredClaims([claim], undefined, busy);
		expect(expired.revokedIds).toEqual([]);
		expect(detectIdleHoldersOfRunningWork([claim], expired.revokedIds, [wi], busy)).toEqual([]);
	});

	it('goes to the orchestrator when the quiet worker leads its own team', () => {
		const wi = runningItem({ target: LEAD });
		const review = buildIdleHolderReview({ workItem: wi, agentSession: LEAD }, TEAM, new Date());
		expect(review.target).toBe('crewly-orc');
	});
});
