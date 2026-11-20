import { createReloginSiblingRelay, parseReloginWire, receiveReloginWire, type ReloginRelayDeps, type ReloginWireMessage } from './relogin-reply.relay.js';

jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
		}),
	},
}));

/**
 * Relay dependencies for a three-machine account, seen from the MacBook.
 *
 * @param overrides - Field overrides
 * @returns Deps and what was sent
 */
function make(overrides: Partial<ReloginRelayDeps> = {}) {
	const sent: Array<{ queueId: string; message: ReloginWireMessage }> = [];
	const deps: ReloginRelayDeps = {
		selfId: async () => 'mbp',
		accountInstances: async () =>
			new Map([
				['mbp', 'q-mbp'],
				['mini', 'q-mini'],
				['win', 'q-win'],
			]),
		hasOtherMachines: () => true,
		send: jest.fn(async (queueId: string, message: ReloginWireMessage) => {
			sent.push({ queueId, message });
		}),
		ackWaitMs: 30,
		logger: { info: jest.fn(), warn: jest.fn() },
		...overrides,
	};
	return { deps, sent };
}

describe('parseReloginWire', () => {
	it('reads an ask (with or without a harness) and an ack', () => {
		expect(parseReloginWire({ v: 1, kind: 'ask', id: 'a', harnessId: 'codex-cli', target: { channelId: 'D1', threadTs: '5' }, fromInstanceId: 'mbp' })).toEqual({
			v: 1,
			kind: 'ask',
			id: 'a',
			harnessId: 'codex-cli',
			target: { channelId: 'D1', threadTs: '5' },
			fromInstanceId: 'mbp',
		});
		expect(parseReloginWire({ v: 1, kind: 'ask', id: 'a', harnessId: null, target: null, fromInstanceId: 'mbp' })).toMatchObject({ harnessId: null, target: null });
		expect(parseReloginWire({ v: 1, kind: 'ack', id: 'a', fromInstanceId: 'mini' })).toEqual({ v: 1, kind: 'ack', id: 'a', fromInstanceId: 'mini' });
	});

	it("drops a target in an agent's own-bot DM (only that agent's machine can post there)", () => {
		expect(parseReloginWire({ v: 1, kind: 'ask', id: 'a', harnessId: null, target: { channelId: 'DORC', agentSession: 'crewly-orc' }, fromInstanceId: 'mbp' })).toMatchObject({ target: null });
	});

	it.each([
		null,
		'text',
		{ v: 2, kind: 'ack', id: 'a', fromInstanceId: 'mini' },
		{ v: 1, kind: 'ack', id: '', fromInstanceId: 'mini' },
		{ v: 1, kind: 'ack', id: 'a' },
		{ v: 1, kind: 'ask', id: 'a', harnessId: 'cursor', fromInstanceId: 'mbp' },
		{ v: 1, kind: 'other', id: 'a', fromInstanceId: 'mbp' },
	])('rejects %j', (payload) => {
		expect(parseReloginWire(payload)).toBeNull();
	});
});

describe('createReloginSiblingRelay', () => {
	it('asks every other machine and resolves true when one confirms', async () => {
		const { deps, sent } = make();
		const { relay, acked } = createReloginSiblingRelay(deps);

		const asking = relay.ask(null, { channelId: 'D1', threadTs: '5' });
		await new Promise((resolve) => setImmediate(resolve));
		expect(sent.map((s) => s.queueId)).toEqual(['q-mini', 'q-win']);
		expect(sent[0].message).toMatchObject({ kind: 'ask', harnessId: null, target: { channelId: 'D1', threadTs: '5' }, fromInstanceId: 'mbp' });
		acked(sent[0].message.id);

		await expect(asking).resolves.toBe(true);
	});

	it('resolves false when nobody confirms in time, and when there is nobody to ask', async () => {
		const quiet = make();
		await expect(createReloginSiblingRelay(quiet.deps).relay.ask('codex-cli', null)).resolves.toBe(false);

		const alone = make({ accountInstances: async () => new Map([['mbp', 'q-mbp']]) });
		await expect(createReloginSiblingRelay(alone.deps).relay.ask(null, null)).resolves.toBe(false);
		expect(alone.sent).toHaveLength(0);
	});

	it('keeps going when one machine cannot be reached, and never forwards an agent-bot DM as the place to answer', async () => {
		const { deps, sent } = make({
			send: jest.fn(async (queueId: string, message: ReloginWireMessage) => {
				if (queueId === 'q-mini') throw new Error('offline');
				sent.push({ queueId, message });
			}),
		});
		await createReloginSiblingRelay(deps).relay.ask(null, { channelId: 'DORC', agentSession: 'crewly-orc' });
		expect(sent.map((s) => s.queueId)).toEqual(['q-win']);
		expect(sent[0].message).toMatchObject({ target: null });
	});
});

describe('receiveReloginWire', () => {
	const ask = { v: 1, kind: 'ask', id: 'r1', harnessId: 'codex-cli', target: { channelId: 'D1', threadTs: '5' }, fromInstanceId: 'mini' };

	it('starts the sign-in here and confirms to the sender\'s queue from the account list', async () => {
		const { deps, sent } = make();
		const relogin = { handleSiblingLogin: jest.fn().mockReturnValue(true) };

		await expect(receiveReloginWire(ask, relogin, { acked: jest.fn() }, deps)).resolves.toBe('taken');
		expect(relogin.handleSiblingLogin).toHaveBeenCalledWith('codex-cli', { channelId: 'D1', threadTs: '5' });
		expect(sent).toEqual([{ queueId: 'q-mini', message: { v: 1, kind: 'ack', id: 'r1', fromInstanceId: 'mbp' } }]);
	});

	it('stays silent when nothing is signed out here', async () => {
		const { deps, sent } = make();
		const relogin = { handleSiblingLogin: jest.fn().mockReturnValue(false) };

		await expect(receiveReloginWire(ask, relogin, { acked: jest.fn() }, deps)).resolves.toBe('nothing_signed_out');
		expect(sent).toHaveLength(0);
	});

	it('ignores its own message, a stranger\'s, and garbage; feeds a confirmation to the waiting ask', async () => {
		const { deps } = make();
		const relogin = { handleSiblingLogin: jest.fn() };
		const acked = jest.fn();

		await expect(receiveReloginWire({ ...ask, fromInstanceId: 'mbp' }, relogin, { acked }, deps)).resolves.toBe('ignored');
		await expect(receiveReloginWire({ ...ask, fromInstanceId: 'someone-else' }, relogin, { acked }, deps)).resolves.toBe('ignored');
		await expect(receiveReloginWire({ nope: true }, relogin, { acked }, deps)).resolves.toBe('ignored');
		expect(relogin.handleSiblingLogin).not.toHaveBeenCalled();

		await expect(receiveReloginWire({ v: 1, kind: 'ack', id: 'r9', fromInstanceId: 'win' }, relogin, { acked }, deps)).resolves.toBe('ack');
		expect(acked).toHaveBeenCalledWith('r9');
	});
});
