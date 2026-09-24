/**
 * Tests for InFlightTurnTracker.
 */

import { EventEmitter } from 'events';
import { InFlightTurnTracker, previewOf, type TurnProbeResult } from './in-flight-turn-tracker.service.js';
import { SAFE_RESTART } from '../../constants.js';

jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
		}),
	},
}));

const T0 = 1_000_000;
const LATER = T0 + SAFE_RESTART.TURN_START_GRACE_MS + 1;

describe('InFlightTurnTracker', () => {
	let tracker: InFlightTurnTracker;
	let verdicts: Record<string, TurnProbeResult>;

	beforeEach(() => {
		InFlightTurnTracker.resetInstance();
		tracker = InFlightTurnTracker.getInstance();
		verdicts = {};
		tracker.setProbe((s) => verdicts[s] ?? 'busy');
	});

	it('is a singleton', () => {
		expect(InFlightTurnTracker.getInstance()).toBe(tracker);
	});

	it('records a delivery with a preview and flags [SYSTEM] pings', () => {
		const m = tracker.recordDelivery('ella', 'check what is left in my To Do', 'pty', T0);
		const s = tracker.recordDelivery('orc', '\n[SYSTEM]\nstatus\n[/SYSTEM]\n', 'pty', T0);
		expect(m.preview).toBe('check what is left in my To Do');
		expect(m.systemEvent).toBe(false);
		expect(s.systemEvent).toBe(true);
		expect(tracker.snapshot().map((t) => t.sessionName).sort()).toEqual(['ella', 'orc']);
	});

	it('keeps a turn open while the probe says busy and drops it when resting', () => {
		tracker.recordDelivery('ella', 'hello', 'pty', T0);
		expect(tracker.getMidTurn(LATER)).toHaveLength(1);
		verdicts.ella = 'idle';
		expect(tracker.getMidTurn(LATER)).toHaveLength(0);
	});

	it('drops a turn whose session is gone', () => {
		tracker.recordDelivery('ella', 'hello', 'pty', T0);
		verdicts.ella = 'gone';
		expect(tracker.settle('ella', LATER)).toBe(false);
		expect(tracker.snapshot()).toHaveLength(0);
	});

	it('treats a fresh delivery as busy regardless of the probe (grace period)', () => {
		tracker.recordDelivery('ella', 'hello', 'pty', T0);
		verdicts.ella = 'idle';
		expect(tracker.settle('ella', T0 + 1)).toBe(true);
	});

	it('treats a throwing probe as busy', () => {
		tracker.setProbe(() => {
			throw new Error('boom');
		});
		tracker.recordDelivery('ella', 'hello', 'pty', T0);
		expect(tracker.settle('ella', LATER)).toBe(true);
	});

	it('keeps turns open when no probe is installed', () => {
		tracker.setProbe(null);
		tracker.recordDelivery('ella', 'hello', 'pty', T0);
		expect(tracker.getMidTurn(LATER)).toHaveLength(1);
	});

	it('never probes in-process turns; only completeMessage ends them', () => {
		const m = tracker.recordDelivery('agent', 'task', 'in-process', T0);
		verdicts.agent = 'gone';
		expect(tracker.getMidTurn(LATER)).toHaveLength(1);
		tracker.completeMessage('agent', m);
		expect(tracker.snapshot()).toHaveLength(0);
	});

	it('completeMessage keeps other open messages and updates since', () => {
		const a = tracker.recordDelivery('agent', 'a', 'in-process', T0);
		tracker.recordDelivery('agent', 'b', 'in-process', T0 + 10);
		tracker.completeMessage('agent', a);
		const [turn] = tracker.snapshot();
		expect(turn.messages.map((m) => m.text)).toEqual(['b']);
		expect(turn.since).toBe(T0 + 10);
		tracker.completeMessage('unknown', a);
	});

	it('caps open messages per session, dropping the oldest', () => {
		for (let i = 0; i < SAFE_RESTART.MAX_OPEN_MESSAGES_PER_SESSION + 2; i++) {
			tracker.recordDelivery('ella', `m${i}`, 'pty', T0 + i);
		}
		const [turn] = tracker.snapshot();
		expect(turn.messages).toHaveLength(SAFE_RESTART.MAX_OPEN_MESSAGES_PER_SESSION);
		expect(turn.messages[0].text).toBe('m2');
		expect(turn.since).toBe(T0 + 2);
	});

	it('annotates the most recent matching delivery with queue metadata', () => {
		tracker.recordDelivery('ella', '[CHAT:c1:abcd] hi', 'pty', T0);
		expect(
			tracker.annotate('ella', '[CHAT:c1:abcd] hi', {
				messageId: 'm1',
				source: 'slack',
				conversationId: 'c1',
				originalContent: 'hi',
				sourceMetadata: { channelId: 'D1' },
			}),
		).toBe(true);
		const [turn] = tracker.snapshot();
		expect(turn.messages[0]).toMatchObject({ messageId: 'm1', source: 'slack', originalContent: 'hi', systemEvent: false });
		expect(tracker.annotate('ella', 'other', {})).toBe(false);
		expect(tracker.annotate('nobody', 'x', {})).toBe(false);
	});

	it('snapshot returns copies', () => {
		tracker.recordDelivery('ella', 'hello', 'pty', T0);
		const snap = tracker.snapshot();
		snap[0].messages.pop();
		expect(tracker.snapshot()[0].messages).toHaveLength(1);
	});

	it('re-probes on agent:idle events and ignores other events', () => {
		const bus = new EventEmitter();
		const detach = tracker.attachEventSource(bus);
		tracker.recordDelivery('ella', 'hello', 'pty', Date.now() - SAFE_RESTART.TURN_START_GRACE_MS - 1);
		verdicts.ella = 'idle';
		bus.emit('eventPublished', { type: 'agent:busy', sessionName: 'ella' });
		expect(tracker.snapshot()).toHaveLength(1);
		bus.emit('eventPublished', { type: 'agent:idle', sessionName: 'ella' });
		expect(tracker.snapshot()).toHaveLength(0);
		detach();
		expect(bus.listenerCount('eventPublished')).toBe(0);
	});

	it('markTurnComplete drops the session', () => {
		tracker.recordDelivery('ella', 'hello', 'pty', T0);
		tracker.markTurnComplete('ella', 'test');
		expect(tracker.snapshot()).toHaveLength(0);
	});
});

describe('previewOf', () => {
	it('collapses whitespace and truncates', () => {
		expect(previewOf('  a\n\n b  ')).toBe('a b');
		const long = 'x'.repeat(SAFE_RESTART.PREVIEW_CHARS + 50);
		expect(previewOf(long)).toHaveLength(SAFE_RESTART.PREVIEW_CHARS);
	});
});
