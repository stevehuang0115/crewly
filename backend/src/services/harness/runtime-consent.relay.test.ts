import { createConsentSiblingRelay, parseConsentWire, receiveConsentWire, type ConsentRelayDeps, type ConsentWireMessage } from './runtime-consent.relay.js';

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
function make(overrides: Partial<ConsentRelayDeps> = {}) {
	const sent: Array<{ queueId: string; message: ConsentWireMessage }> = [];
	const deps: ConsentRelayDeps = {
		selfId: async () => 'mbp',
		accountInstances: async () =>
			new Map([
				['mbp', 'q-mbp'],
				['air', 'q-air'],
				['win', 'q-win'],
			]),
		hasOtherMachines: () => true,
		send: jest.fn(async (queueId: string, message: ConsentWireMessage) => {
			sent.push({ queueId, message });
		}),
		logger: { info: jest.fn(), warn: jest.fn() },
		...overrides,
	};
	return { deps, sent };
}

describe('parseConsentWire', () => {
	it('reads a reply and an ack', () => {
		expect(parseConsentWire({ v: 1, kind: 'reply', id: 'a', reply: 'accept', target: { channelId: 'D1', threadTs: '5' }, fromInstanceId: 'mbp' })).toEqual({
			v: 1,
			kind: 'reply',
			id: 'a',
			reply: 'accept',
			target: { channelId: 'D1', threadTs: '5' },
			inThread: false,
			fromInstanceId: 'mbp',
		});
		expect(parseConsentWire({ v: 1, kind: 'reply', id: 'a', reply: 'accept', target: null, inThread: true, fromInstanceId: 'mbp' })).toMatchObject({ inThread: true });
		expect(parseConsentWire({ v: 1, kind: 'ack', id: 'a', fromInstanceId: 'win' })).toEqual({ v: 1, kind: 'ack', id: 'a', fromInstanceId: 'win' });
	});

	it("drops a target in an agent's own-bot DM (only that agent's machine can post there)", () => {
		const parsed = parseConsentWire({ v: 1, kind: 'reply', id: 'a', reply: 'decline', target: { channelId: 'DORC', agentSession: 'crewly-orc' }, fromInstanceId: 'mbp' });
		expect(parsed).toMatchObject({ reply: 'decline', target: null });
	});

	it.each([
		null,
		'text',
		{ v: 2, kind: 'ack', id: 'a', fromInstanceId: 'win' },
		{ v: 1, kind: 'ack', fromInstanceId: 'win' },
		{ v: 1, kind: 'ack', id: 'a' },
		{ v: 1, kind: 'reply', id: 'a', reply: 'maybe', fromInstanceId: 'win' },
		{ v: 1, kind: 'other', id: 'a', fromInstanceId: 'win' },
	])('rejects %j', (payload) => {
		expect(parseConsentWire(payload)).toBeNull();
	});
});

describe('createConsentSiblingRelay', () => {
	it('sends the answer to every other machine of the account', async () => {
		const { deps, sent } = make();
		const relay = createConsentSiblingRelay(deps);
		expect(relay.hasSiblings()).toBe(true);
		const count = await relay.forward({ id: 'f1', reply: 'accept', target: { channelId: 'D1', threadTs: '5' }, inThread: true });
		expect(count).toBe(2);
		expect(sent.map((s) => s.queueId)).toEqual(['q-air', 'q-win']);
		expect(sent[0].message).toEqual({ v: 1, kind: 'reply', id: 'f1', reply: 'accept', target: { channelId: 'D1', threadTs: '5' }, inThread: true, fromInstanceId: 'mbp' });
	});

	it('counts only the machines it reached', async () => {
		const { deps } = make({
			send: jest.fn(async (queueId: string) => {
				if (queueId === 'q-air') throw new Error('offline');
			}),
		});
		expect(await createConsentSiblingRelay(deps).forward({ id: 'f1', reply: 'accept', target: null, inThread: false })).toBe(1);
	});
});

describe('receiveConsentWire', () => {
	const reply = { v: 1, kind: 'reply', id: 'f1', reply: 'accept', target: { channelId: 'D1', threadTs: '5' }, inThread: true, fromInstanceId: 'win' };

	it('applies a reply while waiting and confirms to the sender', async () => {
		const { deps, sent } = make();
		const consent = { handleSiblingReply: jest.fn(() => true), handleSiblingAck: jest.fn() };
		expect(await receiveConsentWire(reply, consent, deps)).toBe('taken');
		expect(consent.handleSiblingReply).toHaveBeenCalledWith('accept', { channelId: 'D1', threadTs: '5' }, true);
		expect(sent).toEqual([{ queueId: 'q-win', message: { v: 1, kind: 'ack', id: 'f1', fromInstanceId: 'mbp' } }]);
	});

	it('stays silent when it is not waiting', async () => {
		const { deps, sent } = make();
		const consent = { handleSiblingReply: jest.fn(() => false), handleSiblingAck: jest.fn() };
		expect(await receiveConsentWire(reply, consent, deps)).toBe('not_waiting');
		expect(sent).toHaveLength(0);
	});

	it('passes a confirmation to the consent service', async () => {
		const { deps } = make();
		const consent = { handleSiblingReply: jest.fn(() => false), handleSiblingAck: jest.fn() };
		expect(await receiveConsentWire({ v: 1, kind: 'ack', id: 'f1', fromInstanceId: 'win' }, consent, deps)).toBe('ack');
		expect(consent.handleSiblingAck).toHaveBeenCalledWith('f1');
	});

	it('ignores a machine outside the account, its own echo and junk', async () => {
		const { deps, sent } = make();
		const consent = { handleSiblingReply: jest.fn(() => true), handleSiblingAck: jest.fn() };
		expect(await receiveConsentWire({ ...reply, fromInstanceId: 'stranger' }, consent, deps)).toBe('ignored');
		expect(await receiveConsentWire({ ...reply, fromInstanceId: 'mbp' }, consent, deps)).toBe('ignored');
		expect(await receiveConsentWire({ nope: true }, consent, deps)).toBe('ignored');
		expect(consent.handleSiblingReply).not.toHaveBeenCalled();
		expect(sent).toHaveLength(0);
	});

	it('still counts as taken when the confirmation cannot be sent', async () => {
		const { deps } = make({
			send: async () => {
				throw new Error('cloud down');
			},
		});
		const consent = { handleSiblingReply: jest.fn(() => true), handleSiblingAck: jest.fn() };
		expect(await receiveConsentWire(reply, consent, deps)).toBe('taken');
	});
});
