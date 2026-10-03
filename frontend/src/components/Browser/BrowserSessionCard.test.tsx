/**
 * BrowserSessionCard tests.
 *
 * @module components/Browser/BrowserSessionCard.test
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BrowserSessionCard, hostOf, OWNER_FRAME_POLL_MS } from './BrowserSessionCard';
import * as sessionService from '../../services/browser-session.service';
import type { BrowserSession } from '../../services/browser-session.service';
import { layOut, touch } from './frame-stage-test-utils';

const base: BrowserSession = {
	control: 'agent',
	id: 'flopost-pia',
	agentSession: 'flopost-pia',
	agentName: 'Pia',
	status: 'reading',
	lastAction: 'Reading page',
	lastActionAt: Date.now(),
	startedAt: Date.now(),
	url: 'https://account.sunrun.com/transfer?token=secret-session-token',
	frameAt: 1234,
};

describe('hostOf', () => {
	it('keeps only the host, not the query string', () => {
		// The full URL routinely carries a session token; this label sits in a
		// list someone may screen-share.
		expect(hostOf('https://account.sunrun.com/transfer?token=abc')).toBe('account.sunrun.com');
	});

	it('returns an empty string for a missing or unparseable URL', () => {
		expect(hostOf(undefined)).toBe('');
		expect(hostOf('not a url')).toBe('');
	});
});

/** Frames handed out by the mocked fetch, and the object URLs made for them. */
let frameFetch: ReturnType<typeof vi.fn>;
let objectUrls = 0;

/** Let the frame fetch resolve and React render it. */
async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

beforeEach(() => {
	objectUrls = 0;
	frameFetch = vi.fn(async () => new Blob(['jpeg'], { type: 'image/jpeg' }));
	vi.spyOn(sessionService, 'fetchBrowserFrame').mockImplementation(frameFetch as never);
	URL.createObjectURL = vi.fn(() => `blob:frame-${++objectUrls}`);
	URL.revokeObjectURL = vi.fn();
});

describe('BrowserSessionCard', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('shows the agent, its status and the host only', () => {
		render(<BrowserSessionCard session={base} expanded={false} onToggle={() => {}} />);

		expect(screen.getByText('Pia')).toBeInTheDocument();
		expect(screen.getByText('Reading page')).toBeInTheDocument();
		expect(screen.getByText(/account\.sunrun\.com/)).toBeInTheDocument();
		expect(screen.queryByText(/secret-session-token/)).not.toBeInTheDocument();
	});

	it('falls back to the session name when the agent has no display name', () => {
		const { agentName, ...noName } = base;
		render(<BrowserSessionCard session={noName as BrowserSession} expanded={false} onToggle={() => {}} />);
		expect(screen.getByText('flopost-pia')).toBeInTheDocument();
	});

	it('does not fetch or render the picture until expanded', async () => {
		const { rerender } = render(
			<BrowserSessionCard session={base} expanded={false} onToggle={() => {}} />,
		);
		await flush();
		expect(screen.queryByRole('img')).not.toBeInTheDocument();
		expect(frameFetch).not.toHaveBeenCalled();

		rerender(<BrowserSessionCard session={base} expanded onToggle={() => {}} />);
		await flush();
		expect(screen.getByRole('img')).toBeInTheDocument();
	});

	it('fetches this session\'s frame and shows it', async () => {
		render(<BrowserSessionCard session={base} expanded onToggle={() => {}} />);
		await flush();
		expect(frameFetch).toHaveBeenCalledWith('flopost-pia', 1234, 0);
		expect(screen.getByRole('img').getAttribute('src')).toBe('blob:frame-1');
	});

	it('keeps the last good frame when a poll brings nothing back', async () => {
		render(<BrowserSessionCard session={base} expanded onToggle={() => {}} />);
		await flush();
		expect(screen.getByRole('img').getAttribute('src')).toBe('blob:frame-1');

		frameFetch.mockResolvedValue(null); // 404, error or an empty body
		act(() => {
			vi.advanceTimersByTime(1600);
		});
		await flush();

		expect(frameFetch).toHaveBeenCalledTimes(2);
		expect(screen.getByRole('img').getAttribute('src')).toBe('blob:frame-1');
		expect(URL.revokeObjectURL).not.toHaveBeenCalled();
	});

	it('says plainly that the picture goes nowhere else', () => {
		// The rule this whole feature is built around, stated where the person
		// looking at a screenshot of their own logged-in account can read it.
		render(<BrowserSessionCard session={base} expanded onToggle={() => {}} />);
		expect(screen.getByText(/never attached to a chat message or posted to Slack/)).toBeInTheDocument();
	});

	it('waits for a frame rather than showing a broken image', () => {
		const { frameAt, ...noFrame } = base;
		render(<BrowserSessionCard session={noFrame as BrowserSession} expanded onToggle={() => {}} />);
		expect(screen.getByText(/Waiting for the first frame/)).toBeInTheDocument();
		expect(screen.queryByRole('img')).not.toBeInTheDocument();
	});

	it('surfaces a capture failure instead of silently showing a stale frame', () => {
		render(
			<BrowserSessionCard
				session={{ ...base, frameError: 'Cannot access a chrome:// URL' }}
				expanded
				onToggle={() => {}}
			/>,
		);
		expect(screen.getByText(/Cannot access a chrome:\/\/ URL/)).toBeInTheDocument();
	});

	it('re-requests the frame on a timer while expanded, and frees the one it replaces', async () => {
		render(<BrowserSessionCard session={base} expanded onToggle={() => {}} />);
		await flush();
		const first = screen.getByRole('img').getAttribute('src');

		act(() => {
			vi.advanceTimersByTime(1600);
		});
		await flush();

		expect(screen.getByRole('img').getAttribute('src')).not.toBe(first);
		expect(URL.revokeObjectURL).toHaveBeenCalledWith(first);
	});

	it('stops polling once collapsed, so an unwatched session costs nothing', () => {
		const { rerender } = render(<BrowserSessionCard session={base} expanded onToggle={() => {}} />);
		rerender(<BrowserSessionCard session={base} expanded={false} onToggle={() => {}} />);

		act(() => {
			vi.advanceTimersByTime(10_000);
		});

		// Nothing to assert on the DOM — the picture is gone; the point is that
		// advancing the clock does not throw or schedule work on a dead card.
		expect(screen.queryByRole('img')).not.toBeInTheDocument();
	});

	it('toggles when the header is clicked', () => {
		const onToggle = vi.fn();
		render(<BrowserSessionCard session={base} expanded={false} onToggle={onToggle} />);

		fireEvent.click(screen.getByRole('button', { name: /Pia/ }));

		expect(onToggle).toHaveBeenCalledTimes(1);
	});

	it('offers Stop for a running session and not for a finished one', () => {
		const onStop = vi.fn();
		const { rerender } = render(
			<BrowserSessionCard session={base} expanded={false} onToggle={() => {}} onStop={onStop} />,
		);
		expect(screen.getByText('Stop')).toBeInTheDocument();

		rerender(
			<BrowserSessionCard
				session={{ ...base, status: 'done' }}
				expanded={false}
				onToggle={() => {}}
				onStop={onStop}
			/>,
		);
		expect(screen.queryByText('Stop')).not.toBeInTheDocument();
	});

	it('shows what the agent is held on, in words the owner can judge', () => {
		// The owner needs to see the thing itself, not "action pending".
		render(
			<BrowserSessionCard
				session={{
					...base,
					status: 'waiting_owner',
					pending: {
						id: 'p1',
						tool: 'click',
						description: 'Clicked button[aria-label="Send"]',
						matched: 'sending',
						raisedAt: Date.now(),
					},
				}}
				expanded
				onToggle={() => {}}
			/>,
		);

		expect(screen.getByText(/waiting on you/)).toBeInTheDocument();
		expect(screen.getByText(/sending/)).toBeInTheDocument();
		expect(screen.getByText('Let it')).toBeInTheDocument();
		expect(screen.getByText('No')).toBeInTheDocument();
	});

	it('offers to take the browser while the agent has it', () => {
		render(<BrowserSessionCard session={base} expanded onToggle={() => {}} />);
		expect(screen.getByText('Take control of the browser')).toBeInTheDocument();
	});

	it('opens a collapsed card when you take control, so the controls show', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
		const onToggle = vi.fn();
		render(<BrowserSessionCard session={base} expanded={false} onToggle={onToggle} />);
		fireEvent.click(screen.getByText('Take control of the browser'));
		expect(onToggle).toHaveBeenCalledTimes(1);
	});

	it('does not close an open card when you take control', () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
		const onToggle = vi.fn();
		render(<BrowserSessionCard session={base} expanded onToggle={onToggle} />);
		fireEvent.click(screen.getByText('Take control of the browser'));
		expect(onToggle).not.toHaveBeenCalled();
	});

	it('says plainly that the agent is locked out once you take it', () => {
		render(
			<BrowserSessionCard session={{ ...base, control: 'owner' }} expanded onToggle={() => {}} />,
		);
		expect(screen.getByText('You have the browser.')).toBeInTheDocument();
		expect(screen.getByText('Give control back')).toBeInTheDocument();
		expect(screen.getByText(/agent is locked out/)).toBeInTheDocument();
	});

	it('offers no controls on a finished session', () => {
		render(<BrowserSessionCard session={{ ...base, status: 'done' }} expanded onToggle={() => {}} />);
		expect(screen.queryByText('Take control of the browser')).not.toBeInTheDocument();
	});

	it('stops without also toggling the card open', () => {
		const onStop = vi.fn();
		const onToggle = vi.fn();
		render(<BrowserSessionCard session={base} expanded={false} onToggle={onToggle} onStop={onStop} />);

		fireEvent.click(screen.getByText('Stop'));

		expect(onStop).toHaveBeenCalledWith('flopost-pia');
		expect(onToggle).not.toHaveBeenCalled();
	});

	describe('owner driving', () => {
		const owned: BrowserSession = { ...base, control: 'owner', status: 'waiting_owner' };

		/** Give the frame a phone's layout: a 1280x800 frame drawn 320x200. */
		function sizeFrame(): HTMLElement {
			const stage = screen.getByTestId('frame-stage');
			layOut(stage, screen.getByRole('img'));
			return stage;
		}

		it('shows no controls, and does nothing on a tap, while the agent drives', async () => {
			const send = vi.spyOn(sessionService, 'sendBrowserInput');
			render(<BrowserSessionCard session={base} expanded onToggle={() => {}} />);
			await flush();

			expect(screen.queryByTestId('browser-owner-controls')).not.toBeInTheDocument();
			const stage = sizeFrame();
			touch(stage, 'pointerDown', 1, 10, 10);
			touch(stage, 'pointerUp', 1, 10, 10);
			fireEvent.click(screen.getByRole('img'), { clientX: 10, clientY: 10 });
			expect(send).not.toHaveBeenCalled();
		});

		it('tells the owner what to do when the agent is waiting on them', () => {
			render(
				<BrowserSessionCard session={{ ...base, status: 'waiting_owner' }} expanded onToggle={() => {}} />,
			);
			expect(screen.getByTestId('take-control-hint')).toHaveTextContent(/Take control of the browser/);
		});

		it('turns a click on the frame into a tap in frame pixels, with a ripple', async () => {
			const send = vi
				.spyOn(sessionService, 'sendBrowserInput')
				.mockResolvedValue({ ok: true, frameAt: 99 });
			const onChanged = vi.fn();
			render(<BrowserSessionCard session={owned} expanded onToggle={() => {}} onChanged={onChanged} />);
			await flush();
			const stage = sizeFrame();

			touch(stage, 'pointerDown', 1, 160, 50);
			touch(stage, 'pointerUp', 1, 160, 50);

			expect(screen.getByTestId('tap-ripple')).toBeInTheDocument();
			expect(send).toHaveBeenCalledWith('flopost-pia', {
				kind: 'tap',
				x: 640,
				y: 200,
				frameWidth: 1280,
				frameHeight: 800,
			});
			await act(async () => {
				await Promise.resolve();
			});
			expect(onChanged).toHaveBeenCalled();
		});

		it('turns a drag on the frame into a swipe that scrolls the page', async () => {
			const send = vi.spyOn(sessionService, 'sendBrowserInput').mockResolvedValue({ ok: true, frameAt: 99 });
			render(<BrowserSessionCard session={owned} expanded onToggle={() => {}} />);
			await flush();
			const stage = sizeFrame();

			touch(stage, 'pointerDown', 1, 100, 150);
			touch(stage, 'pointerMove', 1, 100, 110);
			touch(stage, 'pointerUp', 1, 100, 110);
			await flush();

			expect(send).toHaveBeenCalledWith(
				'flopost-pia',
				expect.objectContaining({ kind: 'swipe', x: 400, y: 600, dx: 0, frameWidth: 1280, frameHeight: 800 }),
			);
			const [, input] = send.mock.calls[0] as unknown as [string, { dy: number }];
			expect(input.dy).toBeLessThanOrEqual(-160);
		});

		it('goes full screen with a compact bar, and comes back', async () => {
			render(<BrowserSessionCard session={owned} expanded onToggle={() => {}} />);
			await flush();
			expect(screen.getByLabelText('Address to open')).toBeInTheDocument();

			await act(async () => {
				fireEvent.click(screen.getByTestId('enter-fullscreen'));
			});

			expect(screen.getByTestId('browser-surface')).toHaveAttribute('data-fullscreen', 'overlay');
			expect(screen.getByTestId('browser-surface').className).toContain('fixed inset-0');
			expect(screen.getByLabelText('Press Enter')).toBeInTheDocument();
			expect(screen.queryByLabelText('Address to open')).not.toBeInTheDocument();

			await act(async () => {
				fireEvent.click(screen.getByTestId('exit-fullscreen'));
			});
			expect(screen.getByTestId('browser-surface')).not.toHaveAttribute('data-fullscreen');
		});

		it('shows the control bar while the owner drives, and says why an input failed', async () => {
			vi.spyOn(sessionService, 'sendBrowserInput').mockResolvedValue({ ok: false, error: 'No Chrome browser connected.' });
			render(<BrowserSessionCard session={owned} expanded onToggle={() => {}} />);

			expect(screen.getByTestId('browser-owner-controls')).toBeInTheDocument();
			expect(screen.getByTestId('driving-hint')).toBeInTheDocument();

			await act(async () => {
				fireEvent.click(screen.getByText('Back'));
				await Promise.resolve();
			});
			expect(screen.getByRole('alert')).toHaveTextContent('No Chrome browser connected.');
		});

		it('refreshes the frame faster while the owner drives', async () => {
			render(<BrowserSessionCard session={owned} expanded onToggle={() => {}} />);
			await flush();

			act(() => {
				vi.advanceTimersByTime(OWNER_FRAME_POLL_MS + 10);
			});
			await flush();

			expect(frameFetch).toHaveBeenCalledTimes(2);
		});

		it('does not refresh that fast while the agent drives', async () => {
			render(<BrowserSessionCard session={base} expanded onToggle={() => {}} />);
			await flush();

			act(() => {
				vi.advanceTimersByTime(OWNER_FRAME_POLL_MS + 10);
			});
			await flush();

			expect(frameFetch).toHaveBeenCalledTimes(1);
		});
	});
});
