/**
 * Tests for wakeRefusedClaimTarget (#929).
 *
 * @module services/task-pool/claim-target-waker.test
 */

import { wakeRefusedClaimTarget, type ClaimTargetWakerDeps } from './claim-target-waker.js';

/**
 * Builds the dependencies for one scenario.
 *
 * @param overrides - Replacements
 * @returns Deps with a recording waker
 */
function deps(overrides: Partial<ClaimTargetWakerDeps> = {}): ClaimTargetWakerDeps & { wake: jest.Mock } {
	return {
		findWorkItem: async (id) => ({ id, status: 'queued', target: 'dana' }),
		sessionLive: () => false,
		findMember: async () => ({ team: { id: 'marketing' }, member: { id: 'm-dana' } }),
		wake: jest.fn().mockResolvedValue({ outcome: 'started' }),
		...overrides,
	} as ClaimTargetWakerDeps & { wake: jest.Mock };
}

describe('wakeRefusedClaimTarget (#929)', () => {
	it('starts a down agent for the WorkItem queued for it', async () => {
		const d = deps();
		const out = await wakeRefusedClaimTarget({ agentId: 'dana', workItemId: 'wi-1', callerSession: 'crewly-orc' }, d);
		expect(out).toEqual({ outcome: 'started' });
		expect(d.wake).toHaveBeenCalledWith({ teamId: 'marketing', memberId: 'm-dana', session: 'dana', workItemId: 'wi-1', callerSession: 'crewly-orc' });
	});

	it.each([
		['the agent is running', { sessionLive: () => true }],
		['the item is for someone else', { findWorkItem: async (id: string) => ({ id, status: 'queued' as const, target: 'leo' }) }],
		['the item is no longer queued', { findWorkItem: async (id: string) => ({ id, status: 'running' as const, target: 'dana' }) }],
		['the item does not exist', { findWorkItem: async () => null }],
		['the session is no team member', { findMember: async () => null }],
	])('does nothing when %s', async (_label, override) => {
		const d = deps(override as Partial<ClaimTargetWakerDeps>);
		expect(await wakeRefusedClaimTarget({ agentId: 'dana', workItemId: 'wi-1' }, d)).toBeNull();
		expect(d.wake).not.toHaveBeenCalled();
	});
});
