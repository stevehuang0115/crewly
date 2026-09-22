/**
 * Tests for BrowserSessionService.
 *
 * @module services/browser/browser-session.service.test
 */

import {
	BrowserSessionService,
	describeAction,
	matchIrreversible,
	statusForTool,
	type FrameCapturer,
} from './browser-session.service.js';
import { BROWSER_SESSION_CONSTANTS } from '../../constants.js';

describe('describeAction', () => {
	it('names the destination for a navigation', () => {
		expect(describeAction('navigate', { url: 'https://sunrun.com' })).toBe('Opening https://sunrun.com');
	});

	it('never echoes what was typed', () => {
		// Typed text is routinely a password, an account number or an address.
		// The action line is shown in the UI and must not carry it.
		const line = describeAction('fill', { selector: '#password', text: 'hunter2-real-secret' });
		expect(line).not.toContain('hunter2-real-secret');
		expect(line).toBe('Typed into #password');
	});

	it('does not echo typed text for type or insertText either', () => {
		expect(describeAction('type', { text: 'secret' })).not.toContain('secret');
		expect(describeAction('insertText', { text: 'secret' })).not.toContain('secret');
	});

	it('falls back to the tool name for anything unrecognised', () => {
		expect(describeAction('someFutureTool')).toBe('someFutureTool');
	});

	it('copes with missing params', () => {
		expect(describeAction('click')).toBe('Clicked the page');
		expect(describeAction('navigate')).toBe('Opening a page');
	});
});

describe('statusForTool', () => {
	it.each([
		['navigate', 'navigating'],
		['readText', 'reading'],
		['screenshot', 'reading'],
		['click', 'acting'],
		['fill', 'acting'],
		['unbindTab', 'done'],
	])('maps %s to %s', (tool, expected) => {
		expect(statusForTool(tool)).toBe(expected);
	});
});

describe('matchIrreversible', () => {
	it('spots a send button however it is addressed', () => {
		expect(matchIrreversible('click', { selector: 'button[aria-label="Send"]' })).toBe('sending');
		expect(matchIrreversible('click', { selector: '.btn-send-email' })).toBe('sending');
		expect(matchIrreversible('click', { selector: 'button', text: '发送' })).toBe('sending');
	});

	it.each([
		['submit', { selector: 'button[type=submit]' }, 'submitting'],
		['pay', { selector: '#checkout-pay' }, 'paying'],
		['delete', { selector: 'button.delete-account' }, 'deleting'],
		['confirm', { selector: '#confirm-transfer' }, 'confirming'],
		['publish', { selector: '.publish-post' }, 'publishing'],
		['sign', { selector: '#sign-document' }, 'signing'],
	])('holds %s', (_label, params, expected) => {
		expect(matchIrreversible('click', params)).toBe(expected);
	});

	it('leaves reading alone — nothing about it is irreversible', () => {
		expect(matchIrreversible('readText', { selector: '#send-status' })).toBeNull();
		expect(matchIrreversible('screenshot', {})).toBeNull();
		expect(matchIrreversible('getInteractiveElements', {})).toBeNull();
	});

	it('lets ordinary clicking and typing through', () => {
		// A list that matches everything trains people to click through it,
		// which is worse than no list at all.
		expect(matchIrreversible('click', { selector: '#next-page' })).toBeNull();
		expect(matchIrreversible('fill', { selector: '#address', text: '123 Main St' })).toBeNull();
		expect(matchIrreversible('scroll', {})).toBeNull();
	});

	it('treats Enter as a submit but other keys as ordinary', () => {
		expect(matchIrreversible('pressKey', { key: 'Enter' })).toContain('submitting');
		expect(matchIrreversible('pressKey', { key: 'Tab' })).toBeNull();
		expect(matchIrreversible('pressKey', { key: 'a' })).toBeNull();
	});

	it('copes with no params at all', () => {
		expect(matchIrreversible('click')).toBeNull();
	});
});

describe('BrowserSessionService', () => {
	let service: BrowserSessionService;

	beforeEach(() => {
		BrowserSessionService.resetInstance();
		service = BrowserSessionService.getInstance();
		service.clear();
	});

	afterEach(() => {
		BrowserSessionService.resetInstance();
	});

	/** A capturer that always succeeds, counting its calls. */
	function okCapturer(): jest.MockedFunction<FrameCapturer> {
		const fn: FrameCapturer = async () => ({ base64: 'AAAA', format: 'jpeg', devicePixelRatio: 2 });
		return jest.fn(fn) as jest.MockedFunction<FrameCapturer>;
	}

	describe('noteAction', () => {
		it('creates a session on the first action and tracks the URL', () => {
			service.noteAction({ agentSession: 'pia', tool: 'navigate', params: { url: 'https://x.test' } });

			const session = service.getSession('pia');
			expect(session).toMatchObject({
				id: 'pia',
				agentSession: 'pia',
				status: 'navigating',
				url: 'https://x.test',
				lastAction: 'Opening https://x.test',
			});
		});

		it('ignores an action with no agent session', () => {
			service.noteAction({ agentSession: '', tool: 'navigate' });
			expect(service.listSessions()).toHaveLength(0);
		});

		it('keeps the agent name and goal once seen', () => {
			service.noteAction({ agentSession: 'pia', tool: 'navigate', agentName: 'Pia', goal: 'Transfer the lease' });
			service.noteAction({ agentSession: 'pia', tool: 'readText' });

			expect(service.getSession('pia')).toMatchObject({ agentName: 'Pia', goal: 'Transfer the lease' });
		});

		it('marks the session done when the agent releases the tab', () => {
			service.noteAction({ agentSession: 'pia', tool: 'navigate' });
			service.noteAction({ agentSession: 'pia', tool: 'unbindTab' });

			const session = service.getSession('pia')!;
			expect(session.status).toBe('done');
			expect(session.endedAt).toBeDefined();
		});

		it('drops the old picture when a finished agent starts new work', async () => {
			// Otherwise the panel shows the previous task's page — which could
			// be a page from an entirely different context — as if it were live.
			service.setCapturer(okCapturer());
			service.noteAction({ agentSession: 'pia', tool: 'navigate' });
			await service.captureFrame('pia');
			expect(service.getFrame('pia')).toBeDefined();

			service.noteAction({ agentSession: 'pia', tool: 'unbindTab' });
			service.noteAction({ agentSession: 'pia', tool: 'navigate', params: { url: 'https://new.test' } });

			expect(service.getFrame('pia')).toBeUndefined();
			expect(service.getSession('pia')!.endedAt).toBeUndefined();
		});

		it('orders the list by most recent activity', () => {
			service.noteAction({ agentSession: 'a', tool: 'navigate' });
			service.noteAction({ agentSession: 'b', tool: 'navigate' });
			// Force distinct timestamps regardless of clock resolution.
			(service.getSession('a') as never);
			service.noteAction({ agentSession: 'a', tool: 'click' });

			const ids = service.listSessions().map((s) => s.id);
			expect(ids[0]).toBe('a');
		});

		it('can hide finished sessions', () => {
			service.noteAction({ agentSession: 'a', tool: 'navigate' });
			service.noteAction({ agentSession: 'b', tool: 'navigate' });
			service.endSession('b');

			expect(service.listSessions(false).map((s) => s.id)).toEqual(['a']);
			expect(service.listSessions(true)).toHaveLength(2);
		});
	});

	describe('capture cadence', () => {
		it('does not capture a session nobody has acted on or watched', () => {
			expect(service.shouldCapture('nobody')).toBe(false);
		});

		it('captures an unwatched session only after it acted, and only slowly', () => {
			const t0 = 1_000_000;
			service.noteAction({ agentSession: 'pia', tool: 'navigate' });

			// Dirty and no frame yet — due immediately.
			expect(service.shouldCapture('pia', t0)).toBe(true);
		});

		it('does not re-capture an unwatched session that is not dirty', async () => {
			service.setCapturer(okCapturer());
			service.noteAction({ agentSession: 'pia', tool: 'navigate' });
			await service.captureFrame('pia');

			// captureFrame clears dirty; nobody is watching, so nothing is due.
			expect(service.shouldCapture('pia', Date.now() + 60_000)).toBe(false);
		});

		it('keeps capturing a watched session even when the agent is idle', async () => {
			service.setCapturer(okCapturer());
			service.noteAction({ agentSession: 'pia', tool: 'navigate' });
			await service.captureFrame('pia');

			// Fetching the frame is what registers a watcher.
			service.getFrame('pia');

			const later = Date.now() + BROWSER_SESSION_CONSTANTS.WATCHED_FRAME_INTERVAL_MS + 10;
			expect(service.isWatched('pia', later)).toBe(true);
			expect(service.shouldCapture('pia', later)).toBe(true);
		});

		it('stops counting a viewer once the watch window lapses', () => {
			service.noteAction({ agentSession: 'pia', tool: 'navigate' });
			service.getFrame('pia');

			const wayLater = Date.now() + BROWSER_SESSION_CONSTANTS.WATCH_WINDOW_MS + 1_000;
			expect(service.isWatched('pia', wayLater)).toBe(false);
		});

		it('never captures a finished session', () => {
			service.noteAction({ agentSession: 'pia', tool: 'navigate' });
			service.endSession('pia', 'stopped');

			expect(service.shouldCapture('pia')).toBe(false);
		});

		it('does not start a second capture while one is in flight', async () => {
			let release: (() => void) | undefined;
			const slowImpl: FrameCapturer = () =>
				new Promise((resolve) => {
					release = () => resolve({ base64: 'AAAA', format: 'jpeg' });
				});
			const slow = jest.fn(slowImpl) as jest.MockedFunction<FrameCapturer>;
			service.setCapturer(slow);
			service.noteAction({ agentSession: 'pia', tool: 'navigate' });

			const first = service.captureFrame('pia');
			// A slow page must not accumulate a capture per tick.
			expect(service.shouldCapture('pia')).toBe(false);
			await expect(service.captureFrame('pia')).resolves.toBe(false);

			release!();
			await first;
			expect(slow).toHaveBeenCalledTimes(1);
		});
	});

	describe('captureFrame', () => {
		it('stores the image and stamps the session', async () => {
			service.setCapturer(okCapturer());
			service.noteAction({ agentSession: 'pia', tool: 'navigate' });

			await expect(service.captureFrame('pia')).resolves.toBe(true);

			const frame = service.getFrame('pia')!;
			expect(frame.base64).toBe('AAAA');
			expect(frame.mimeType).toBe('image/jpeg');
			expect(frame.devicePixelRatio).toBe(2);
			expect(service.getSession('pia')!.frameAt).toBeDefined();
		});

		it('labels a PNG from an extension that ignores the format hint', async () => {
			// An older extension does not understand jpeg/scale and answers
			// with PNG. The frame must still render, not be mislabelled.
			const pngCapturer: FrameCapturer = async () => ({ base64: 'AAAA', format: 'png' });
			service.setCapturer(pngCapturer);
			service.noteAction({ agentSession: 'pia', tool: 'navigate' });
			await service.captureFrame('pia');

			expect(service.getFrame('pia')!.mimeType).toBe('image/png');
		});

		it('requests the configured encoding', async () => {
			const capturer = okCapturer();
			service.setCapturer(capturer);
			service.noteAction({ agentSession: 'pia', tool: 'navigate' });
			await service.captureFrame('pia');

			expect(capturer).toHaveBeenCalledWith('pia', {
				format: BROWSER_SESSION_CONSTANTS.FRAME_FORMAT,
				quality: BROWSER_SESSION_CONSTANTS.FRAME_QUALITY,
				scale: BROWSER_SESSION_CONSTANTS.FRAME_SCALE,
			});
		});

		it('records a capture failure without throwing or retrying in a loop', async () => {
			const failing: FrameCapturer = async () => {
				throw new Error('Cannot access a chrome:// URL');
			};
			service.setCapturer(failing);
			service.noteAction({ agentSession: 'pia', tool: 'navigate' });

			await expect(service.captureFrame('pia')).resolves.toBe(false);
			expect(service.getSession('pia')!.frameError).toContain('chrome://');
			// Dirty is cleared, so a broken page is not hammered once per tick.
			expect(service.shouldCapture('pia')).toBe(false);
		});

		it('records an empty result as a failure', async () => {
			const emptyCapturer: FrameCapturer = async () => null;
			service.setCapturer(emptyCapturer);
			service.noteAction({ agentSession: 'pia', tool: 'navigate' });

			await expect(service.captureFrame('pia')).resolves.toBe(false);
			expect(service.getSession('pia')!.frameError).toBe('No image returned');
		});

		it('does nothing without a capturer, which is the no-extension case', async () => {
			service.setCapturer(null);
			service.noteAction({ agentSession: 'pia', tool: 'navigate' });

			await expect(service.captureFrame('pia')).resolves.toBe(false);
			expect(await service.tick()).toBe(0);
		});
	});

	describe('tick', () => {
		it('captures every due session in one pass', async () => {
			const capturer = okCapturer();
			service.setCapturer(capturer);
			service.noteAction({ agentSession: 'a', tool: 'navigate' });
			service.noteAction({ agentSession: 'b', tool: 'navigate' });

			expect(await service.tick()).toBe(2);
			expect(capturer).toHaveBeenCalledTimes(2);
		});

		it('keeps going when one session fails to capture', async () => {
			const mixed: FrameCapturer = async (agentSession) => {
				if (agentSession === 'a') throw new Error('restricted page');
				return { base64: 'AAAA', format: 'jpeg' };
			};
			service.setCapturer(mixed);
			service.noteAction({ agentSession: 'a', tool: 'navigate' });
			service.noteAction({ agentSession: 'b', tool: 'navigate' });

			await service.tick();

			expect(service.getSession('a')!.frameError).toBeDefined();
			expect(service.getFrame('b')).toBeDefined();
		});
	});

	describe('control and holds', () => {
		it('lets ordinary actions through', () => {
			expect(service.authorize('pia', 'readText', {})).toEqual({ allow: true });
			expect(service.authorize('pia', 'click', { selector: '#next' })).toEqual({ allow: true });
		});

		it('holds an irreversible action and shows the owner what it was', () => {
			// The incident this exists for: an owner asked for an email to be
			// drafted and the agent sent it. At this layer that is a click.
			const verdict = service.authorize('pia', 'click', { selector: 'button[aria-label="Send"]' });

			expect(verdict.allow).toBe(false);
			const session = service.getSession('pia')!;
			expect(session.status).toBe('waiting_owner');
			expect(session.pending).toMatchObject({ tool: 'click', matched: 'sending' });
		});

		it('tells the agent not to retry or work around it', () => {
			const verdict = service.authorize('pia', 'click', { selector: '#submit' });
			expect(verdict.allow).toBe(false);
			if (verdict.allow) return;
			expect(verdict.reason).toMatch(/do not retry/i);
			expect(verdict.reason).toMatch(/another way/i);
		});

		it('keeps refusing while a hold is open, under the same id', () => {
			const first = service.authorize('pia', 'click', { selector: '#submit' });
			const second = service.authorize('pia', 'click', { selector: '#submit' });
			expect(second.allow).toBe(false);
			if (first.allow || second.allow) return;
			expect(second.code).toBe('awaiting_owner');
			expect(second.pendingId).toBe(first.pendingId);
		});

		it('lets exactly one attempt through after the owner approves', () => {
			const held = service.authorize('pia', 'click', { selector: '#submit' });
			expect(held.allow).toBe(false);
			if (held.allow) return;

			service.resolvePending('pia', held.pendingId!, 'approve');

			// The retry goes through...
			expect(service.authorize('pia', 'click', { selector: '#submit' })).toEqual({ allow: true });
			// ...and the next one is held again. Approving one action must not
			// open the gate for good.
			expect(service.authorize('pia', 'click', { selector: '#submit' }).allow).toBe(false);
		});

		it('does not let anything through after a rejection', () => {
			const held = service.authorize('pia', 'click', { selector: '#submit' });
			if (held.allow) return;

			service.resolvePending('pia', held.pendingId!, 'reject');

			expect(service.authorize('pia', 'click', { selector: '#submit' }).allow).toBe(false);
		});

		it('ignores a decision that names the wrong hold', () => {
			service.authorize('pia', 'click', { selector: '#submit' });
			expect(service.resolvePending('pia', 'not-the-id', 'approve')).toBeUndefined();
			expect(service.getSession('pia')!.pending).toBeDefined();
		});

		it('refuses the agent entirely while the owner holds the wheel', () => {
			service.noteAction({ agentSession: 'pia', tool: 'navigate' });
			service.takeControl('pia');

			// Not just writes — reads too. The owner may be typing a password.
			const verdict = service.authorize('pia', 'readText', {});
			expect(verdict.allow).toBe(false);
			if (verdict.allow) return;
			expect(verdict.code).toBe('owner_has_control');
			expect(service.getSession('pia')!.status).toBe('waiting_owner');
		});

		it('gives the wheel back and drops whatever was held', () => {
			service.authorize('pia', 'click', { selector: '#submit' });
			service.takeControl('pia');

			const session = service.releaseControl('pia')!;

			expect(session.control).toBe('agent');
			expect(session.pending).toBeUndefined();
			expect(session.controlTakenAt).toBeUndefined();
			expect(service.authorize('pia', 'readText', {})).toEqual({ allow: true });
		});

		it('can be switched off for an owner who wants unattended work', () => {
			service.setConfirmBeforeIrreversible(false);
			expect(service.authorize('pia', 'click', { selector: '#submit' })).toEqual({ allow: true });
			expect(service.isConfirmBeforeIrreversible()).toBe(false);
		});

		it('holds by default, so unattended is a decision someone made', () => {
			expect(service.isConfirmBeforeIrreversible()).toBe(true);
		});

		it('does nothing for take/release on a session that does not exist', () => {
			expect(service.takeControl('nobody')).toBeUndefined();
			expect(service.releaseControl('nobody')).toBeUndefined();
		});
	});

	describe('prune', () => {
		it('forgets sessions that finished long ago, and their frames', async () => {
			service.setCapturer(okCapturer());
			service.noteAction({ agentSession: 'pia', tool: 'navigate' });
			await service.captureFrame('pia');
			service.endSession('pia');

			const later = Date.now() + BROWSER_SESSION_CONSTANTS.RETAIN_FINISHED_MS + 1_000;
			expect(service.prune(later)).toBe(1);
			expect(service.getSession('pia')).toBeUndefined();
			expect(service.getFrame('pia')).toBeUndefined();
		});

		it('keeps a session that is still running', () => {
			service.noteAction({ agentSession: 'pia', tool: 'navigate' });
			expect(service.prune(Date.now() + 10 * BROWSER_SESSION_CONSTANTS.RETAIN_FINISHED_MS)).toBe(0);
		});
	});
});
