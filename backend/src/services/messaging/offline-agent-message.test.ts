import { queueForOfflineAgent, resetOfflineAgentWakes } from './offline-agent-message.js';

const dormantTeam = { team: { members: [{ agentStatus: 'inactive' }] }, member: { name: 'Pia' } };
const liveTeam = { team: { members: [{ agentStatus: 'inactive' }, { agentStatus: 'active' }] }, member: { name: 'Pia' } };

function deps(found: unknown, shares?: boolean) {
	const enqueue = jest.fn();
	const wake = jest.fn().mockResolvedValue({ success: true });
	return {
		enqueue,
		wake,
		deps: {
			findMember: jest.fn().mockResolvedValue(found),
			enqueue,
			wake,
			...(shares === undefined ? {} : { sharesChannelWithSender: jest.fn().mockReturnValue(shares) }),
		},
	};
}

describe('queueForOfflineAgent', () => {
	beforeEach(() => resetOfflineAgentWakes());

	it('starts the agent when its team has someone running', async () => {
		const d = deps(liveTeam);
		const res = await queueForOfflineAgent('flopost-pia', 'hi', d.deps);
		expect(res).toEqual({ queued: true, waking: true });
		expect(d.enqueue).toHaveBeenCalledWith('flopost-pia', 'hi');
		expect(d.wake).toHaveBeenCalledWith('flopost-pia');
	});

	it('only queues for an agent whose team is down', async () => {
		const d = deps(dormantTeam);
		const res = await queueForOfflineAgent('flopost-pia', 'hi', d.deps);
		expect(res?.waking).toBe(false);
		expect(d.enqueue).toHaveBeenCalled();
		expect(d.wake).not.toHaveBeenCalled();
	});

	it('only queues when the sender shares no channel with the agent', async () => {
		const d = deps(dormantTeam, false);
		const res = await queueForOfflineAgent('flopost-pia', 'hi', d.deps);
		expect(res?.waking).toBe(false);
		expect(d.wake).not.toHaveBeenCalled();
	});

	it('starts an agent whose team is down when the sender shares a channel with it', async () => {
		const d = deps(dormantTeam, true);
		const res = await queueForOfflineAgent('flopost-pia', 'hi', d.deps);
		expect(res).toEqual({ queued: true, waking: true });
		expect(d.wake).toHaveBeenCalledWith('flopost-pia');
	});

	it('treats a failing channel lookup as no shared channel', async () => {
		const d = deps(dormantTeam);
		const res = await queueForOfflineAgent('flopost-pia', 'hi', {
			...d.deps,
			sharesChannelWithSender: jest.fn().mockRejectedValue(new Error('db closed')),
		});
		expect(res?.waking).toBe(false);
		expect(d.wake).not.toHaveBeenCalled();
	});
});
