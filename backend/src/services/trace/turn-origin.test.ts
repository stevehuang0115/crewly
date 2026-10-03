/**
 * Tests for turn-origin: unsolicited turns and browser actions are always
 * traced (2026-10-03 phantom owner input).
 */

import { setTraceContextForTesting, type TraceContext } from './trace-context.service.js';
import {
	noteHarnessWrite,
	notePromptSubmitted,
	resetTurnOriginForTesting,
	traceBrowserAction,
} from './turn-origin.js';

jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
		}),
	},
}));

interface FakeContext {
	current: Map<string, string>;
	currentTrace: jest.Mock;
	startTrace: jest.Mock;
	record: jest.Mock;
}

/**
 * A trace context double with a settable current trace per session.
 *
 * @returns The double
 */
function fakeContext(): FakeContext {
	const current = new Map<string, string>();
	const ctx: FakeContext = {
		current,
		currentTrace: jest.fn((s: string) => current.get(s) ?? null),
		startTrace: jest.fn((input: { session?: string }) => {
			const id = 'tr-new';
			if (input.session) current.set(input.session, id);
			return id;
		}),
		record: jest.fn(() => true),
	};
	return ctx;
}

describe('turn-origin', () => {
	let ctx: FakeContext;

	beforeEach(() => {
		resetTurnOriginForTesting();
		ctx = fakeContext();
		setTraceContextForTesting(ctx as unknown as TraceContext);
	});

	afterEach(() => {
		setTraceContextForTesting(null);
	});

	describe('notePromptSubmitted', () => {
		it('a prompt the harness typed is not unsolicited', () => {
			noteHarnessWrite('ella');
			expect(notePromptSubmitted('ella')).toBe(false);
			expect(ctx.record).not.toHaveBeenCalled();
		});

		it('a prompt with no harness write before it is recorded as turn.unsolicited in the current trace', () => {
			ctx.current.set('ella', 'tr-1');
			expect(notePromptSubmitted('ella')).toBe(true);
			expect(ctx.record).toHaveBeenCalledWith(expect.objectContaining({ traceId: 'tr-1', type: 'turn.unsolicited' }));
		});

		it('one submit consumes every queued harness write; the next bare submit is unsolicited', () => {
			ctx.current.set('ella', 'tr-1');
			noteHarnessWrite('ella');
			noteHarnessWrite('ella');
			expect(notePromptSubmitted('ella')).toBe(false);
			expect(notePromptSubmitted('ella')).toBe(true);
		});

		it('falls back to the last trace the session worked in when the current one has expired', () => {
			ctx.current.set('ella', 'tr-old');
			noteHarnessWrite('ella');
			notePromptSubmitted('ella');
			ctx.current.delete('ella'); // idle gap passed
			notePromptSubmitted('ella');
			expect(ctx.record).toHaveBeenLastCalledWith(expect.objectContaining({ traceId: 'tr-old', type: 'turn.unsolicited' }));
			expect(ctx.startTrace).not.toHaveBeenCalled();
		});

		it('starts an unsolicited trace when the session never had one', () => {
			notePromptSubmitted('ella');
			expect(ctx.startTrace).toHaveBeenCalledWith(expect.objectContaining({ kind: 'unsolicited', session: 'ella' }));
			expect(ctx.record).toHaveBeenCalledWith(expect.objectContaining({ traceId: 'tr-new', type: 'turn.unsolicited' }));
		});
	});

	describe('traceBrowserAction', () => {
		it('records the action with where and what, never the typed text', () => {
			ctx.current.set('ella', 'tr-1');
			traceBrowserAction({
				session: 'ella',
				tool: 'type',
				params: { selector: '.ql-editor', text: 'Agree. Absorption is the other half.' },
				url: 'https://www.linkedin.com/feed/',
				outcome: 'ok',
			});
			const call = ctx.record.mock.calls[0][0];
			expect(call).toMatchObject({ traceId: 'tr-1', type: 'skill.call', outcome: 'ok' });
			expect(call.data).toMatchObject({ tool: 'type', target: '.ql-editor', host: 'www.linkedin.com', typedChars: 36 });
			expect(JSON.stringify(call)).not.toContain('Absorption');
		});

		it('a held action is a guard.block; an action outside any trace starts one', () => {
			traceBrowserAction({ session: 'ella', tool: 'click', params: { x: 1, y: 2 }, outcome: 'blocked', reason: 'awaiting_owner' });
			expect(ctx.startTrace).toHaveBeenCalledWith(expect.objectContaining({ kind: 'unsolicited' }));
			expect(ctx.record).toHaveBeenCalledWith(expect.objectContaining({ type: 'guard.block', outcome: 'blocked' }));
		});
	});
});
